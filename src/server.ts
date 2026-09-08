/**
 * Servidor HTTP. Expone el orquestador y, en el mismo proceso, el mock del carrier.
 *
 * Codigos de estado, decididos a proposito y documentados en el README:
 *   QUOTED               -> 200
 *   NEEDS_INFO           -> 200. Es un turno normal de conversacion, no un error del
 *                           cliente: la peticion estaba bien formada y el sistema
 *                           responde lo que corresponde.
 *   PROVIDER_UNAVAILABLE -> 503 + `Retry-After`. Semanticamente correcto y accionable
 *                           para quien integra. NO es "un 500 crudo": el cuerpo es
 *                           estructurado, sin stack ni detalle interno.
 *   Peticion mal formada -> 400 con los campos que fallaron.
 */
import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./config.ts";
import { crearExtractor } from "./llm/index.ts";
import { crearClienteCotizacion } from "./provider/cliente-cotizacion.ts";
import { crearCarrierMock, type PeticionCarrier } from "./provider/carrier-mock.ts";
import { procesarPeticion, type RespuestaOrquestador } from "./orquestador.ts";
import { EsquemaPeticionEntrante } from "./schema.ts";

/**
 * Idempotencia de demostracion.
 *
 * ADVERTENCIA HONESTA, y esta escrita aqui a proposito: este almacen vive en memoria del
 * proceso. No sobrevive a un reinicio ni se comparte entre replicas, asi que NO es una
 * solucion de produccion — con dos instancias detras de un balanceador, dos clics
 * simultaneos pueden caer en procesos distintos y cotizar dos veces.
 *
 * Esta aqui para dejar el punto de intercepcion explicito y probado. El diseno real
 * —claim/complete/busy con rescate de concesion vencida en base de datos— se explica en
 * el README, en "Que dejaria listo para produccion".
 */
class AlmacenIdempotencia {
  private readonly enCurso = new Map<string, Promise<RespuestaOrquestador>>();
  private readonly hechas = new Map<string, RespuestaOrquestador>();

  obtener(clave: string): Promise<RespuestaOrquestador> | RespuestaOrquestador | undefined {
    return this.hechas.get(clave) ?? this.enCurso.get(clave);
  }

  async registrar(
    clave: string,
    trabajo: Promise<RespuestaOrquestador>,
  ): Promise<RespuestaOrquestador> {
    this.enCurso.set(clave, trabajo);
    try {
      const resultado = await trabajo;
      // Solo se memoriza lo definitivo: un fallo transitorio del proveedor no debe
      // quedar congelado como respuesta para siempre.
      if (resultado.status !== "PROVIDER_UNAVAILABLE") this.hechas.set(clave, resultado);
      return resultado;
    } finally {
      this.enCurso.delete(clave);
    }
  }
}

export function construirServidor(config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });

  const carrier = crearCarrierMock(config.carrier);
  const extractor = crearExtractor(config.llm);
  const idempotencia = new AlmacenIdempotencia();

  // La URL del carrier se resuelve EN CADA LLAMADA, no al construir: asi el servidor
  // funciona igual en un puerto fijo que en uno efimero (`port: 0`), que es lo que usa
  // el generador de evidencia para no chocar con una instancia ya levantada.
  const urlCarrier = (): string => {
    const direccion = app.server.address();
    const puerto = typeof direccion === "object" && direccion ? direccion.port : config.port;
    return `http://127.0.0.1:${puerto}/mock-carrier/quote`;
  };
  const cliente = crearClienteCotizacion({ urlCarrier, politica: config.reintentos });

  // --- El proveedor externo inestable ---------------------------------------------
  app.post("/mock-carrier/quote", async (peticion, respuesta) => {
    const cuerpo = peticion.body as PeticionCarrier;
    const controlador = new AbortController();

    /**
     * Si el cliente se rinde por timeout, se corta tambien el trabajo de este lado: una
     * peticion que ya no le sirve a nadie no debe seguir ocupando al proveedor.
     *
     * OJO CON LA SENAL CORRECTA: la primera version escuchaba `peticion.raw.on("close")`
     * y abortaba SIEMPRE, porque en Node ese evento se dispara al terminar de leerse el
     * cuerpo de la peticion, no solo cuando el cliente se desconecta. El resultado fue un
     * 499 instantaneo en todos los casos — y el escenario de caida del proveedor pasaba
     * en verde por el motivo equivocado. Lo correcto es escuchar el cierre de la
     * RESPUESTA y comprobar que aun no habiamos terminado.
     */
    let yaRespondido = false;
    respuesta.raw.on("close", () => {
      if (!yaRespondido) controlador.abort();
    });

    try {
      const resultado = await carrier.cotizar(cuerpo, controlador.signal);
      yaRespondido = true;
      if (resultado.retryAfterSegundos !== undefined) {
        void respuesta.header("Retry-After", String(resultado.retryAfterSegundos));
      }
      return await respuesta.status(resultado.status).send(resultado.cuerpo);
    } catch {
      yaRespondido = true;
      // 499 (nginx): el cliente cerro antes de recibir respuesta. No se reintenta.
      return await respuesta.status(499).send({ error: "cliente cancelo la peticion" });
    }
  });

  // --- Ingesta ---------------------------------------------------------------------
  app.post("/quote", async (peticion, respuesta) => {
    const analizada = EsquemaPeticionEntrante.safeParse(peticion.body);
    if (!analizada.success) {
      return await respuesta.status(400).send({
        status: "BAD_REQUEST",
        message: "La peticion no cumple el contrato de entrada.",
        errors: analizada.error.issues.map((problema) => ({
          field: problema.path.join(".") || "(cuerpo)",
          message: problema.message,
        })),
      });
    }

    const trabajo = (): Promise<RespuestaOrquestador> =>
      procesarPeticion(analizada.data, {
        extraccion: { extractor, timeoutMs: config.llm.timeoutMs },
        cliente,
      });

    const clave = peticion.headers["idempotency-key"];
    let resultado: RespuestaOrquestador;

    if (typeof clave === "string" && clave.trim() !== "") {
      const previa = idempotencia.obtener(clave.trim());
      resultado = previa
        ? await previa
        : await idempotencia.registrar(clave.trim(), trabajo());
    } else {
      resultado = await trabajo();
    }

    if (resultado.status === "PROVIDER_UNAVAILABLE") {
      void respuesta.header("Retry-After", "30");
      return await respuesta.status(503).send(resultado);
    }
    return await respuesta.status(200).send(resultado);
  });

  app.get("/health", async () => ({
    ok: true,
    llm_provider: extractor.detalle,
    policy: config.reintentos,
    carrier_failure_rate: config.carrier.failureRate,
  }));

  /**
   * Red de seguridad: nada sin capturar llega crudo al cliente.
   *
   * PERO un error del cliente NO se disfraza de caida del proveedor. La primera version
   * devolvia 503 PROVIDER_UNAVAILABLE para cualquier excepcion, y un cuerpo mal formado
   * —`Content-Length` que no cuadra, JSON roto, tipo de contenido incorrecto— salia como
   * "el proveedor no esta disponible". Eso manda a quien integra a perseguir una caida
   * que no existe, mientras el fallo real esta en su propia peticion.
   *
   * Se respeta el `statusCode` que el propio error ya trae cuando es 4xx.
   */
  app.setErrorHandler(async (error, _peticion, respuesta) => {
    const declarado = (error as { statusCode?: number }).statusCode;
    const esCulpaDelCliente =
      typeof declarado === "number" && declarado >= 400 && declarado < 500;

    if (esCulpaDelCliente) {
      app.log.warn({ err: error }, "peticion rechazada por el borde");
      return await respuesta.status(declarado).send({
        status: "BAD_REQUEST",
        message: "La peticion no se pudo procesar. Revisa el cuerpo y las cabeceras.",
        errors: [
          {
            field: "(cuerpo)",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }

    app.log.error({ err: error }, "error no controlado");
    return await respuesta.status(503).send({
      status: "PROVIDER_UNAVAILABLE",
      message: "No pudimos procesar tu solicitud en este momento. Intenta nuevamente.",
    });
  });

  return app;
}

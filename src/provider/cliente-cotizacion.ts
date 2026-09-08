/**
 * Cliente del carrier: una llamada HTTP real, envuelta en la politica de resiliencia.
 *
 * Este modulo no sabe de reintentos ni de jitter: eso vive en `cliente-resiliente.ts`.
 * Aqui solo se traduce la respuesta HTTP a la senal que la politica entiende
 * (reintentable o no) y se normaliza el cuerpo cuando hay exito.
 */
import type { PoliticaReintentos } from "../config.ts";
import type { PeticionCompleta } from "../schema.ts";
import {
  ErrorProveedor,
  ejecutarConReintentos,
  leerRetryAfter,
  reintentablePorStatus,
  type DependenciasResiliencia,
  type ResultadoResiliente,
} from "./cliente-resiliente.ts";
import { normalizarCotizacion, type CotizacionNormalizada } from "./normalizar.ts";

export interface ClienteCotizacion {
  cotizar(peticion: PeticionCompleta): Promise<ResultadoResiliente<CotizacionNormalizada>>;
}

export interface OpcionesCliente {
  /**
   * URL del carrier. Puede ser una funcion para resolverla en cada llamada: el servidor
   * la necesita asi cuando escucha en un puerto efimero, que solo se conoce tras
   * `listen`.
   */
  urlCarrier: string | (() => string);
  politica: PoliticaReintentos;
  resiliencia?: DependenciasResiliencia;
}

/**
 * Fabrica con dependencias inyectadas.
 *
 * La politica llega por parametro, NO se lee de `process.env` aqui dentro. Esa es la
 * decision que hace que "cambia a 2 intentos y un timeout mas agresivo" sea pasar otro
 * objeto —o editar una linea del .env— en vez de perseguir constantes por el codigo.
 */
export function crearClienteCotizacion(opciones: OpcionesCliente): ClienteCotizacion {
  const { urlCarrier, politica, resiliencia } = opciones;

  return {
    async cotizar(peticion) {
      return ejecutarConReintentos(
        async (señal) => {
          const destino = typeof urlCarrier === "function" ? urlCarrier() : urlCarrier;
          let respuesta: Response;
          try {
            respuesta = await fetch(destino, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(peticion),
              signal: señal,
            });
          } catch (error) {
            // Un abort lo propaga tal cual: la politica sabe distinguirlo y lo cuenta
            // como intento fallido reintentable.
            if (error instanceof Error && error.name === "AbortError") throw error;
            throw new ErrorProveedor("fallo de red contra el carrier", {
              reintentable: true,
              causa: error,
            });
          }

          if (!respuesta.ok) {
            const retryAfterMs = leerRetryAfter(respuesta.headers.get("retry-after"));
            const cuerpo = await respuesta.text().catch(() => "");
            throw new ErrorProveedor(
              `el carrier respondio ${respuesta.status}: ${cuerpo.slice(0, 200)}`,
              {
                status: respuesta.status,
                reintentable: reintentablePorStatus(respuesta.status),
                retryAfterMs,
              },
            );
          }

          // Validacion y normalizacion dentro del intento: un 200 con cuerpo roto es un
          // fallo del intento, no un exito que revienta despues.
          return normalizarCotizacion(await respuesta.json());
        },
        politica,
        resiliencia ?? {},
      );
    },
  };
}

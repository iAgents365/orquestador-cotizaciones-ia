/**
 * Orquestador: une ingesta, guardrail y proveedor externo en el contrato de salida.
 *
 * Los tres estados son excluyentes y siempre identificables:
 *   QUOTED               -> hubo cotizacion
 *   NEEDS_INFO           -> falto informacion; NO se llamo al proveedor
 *   PROVIDER_UNAVAILABLE -> se llamo y no se pudo; degradacion elegante
 *
 * Regla estructural: la llamada al proveedor externo esta DESPUES del guardrail y no hay
 * ninguna otra ruta hacia ella. Un mensaje incompleto no puede llegar al carrier ni por
 * accidente, porque el unico tipo que el cliente acepta es `PeticionCompleta`, y ese tipo
 * solo se construye tras pasar la validacion.
 */
import type { ClienteCotizacion } from "./provider/cliente-cotizacion.ts";
import type { CotizacionNormalizada } from "./provider/normalizar.ts";
import { ErrorAgotado } from "./provider/cliente-resiliente.ts";
import { extraerPeticion, type DependenciasExtraccion } from "./extractor.ts";
import type { NombreCampo, PeticionEntrante } from "./schema.ts";

export interface MetaRespuesta {
  request_id: string;
  llm_provider: string;
  /** Intentos consumidos contra el carrier. 0 si nunca se le llamo. */
  provider_attempts: number;
  duration_ms: number;
  /** Anomalias del modelo (tipos malos, claves inventadas). Vacio en el camino feliz. */
  warnings?: string[];
}

export type RespuestaOrquestador =
  | {
      status: "QUOTED";
      quote: CotizacionNormalizada;
      /** Supuestos DECLARADOS que se aplicaron. Nunca silenciosos. */
      assumptions: Array<{ field: string; value: unknown; reason: string }>;
      meta: MetaRespuesta;
    }
  | {
      status: "NEEDS_INFO";
      missing_fields: NombreCampo[];
      message: string;
      meta: MetaRespuesta;
    }
  | {
      status: "PROVIDER_UNAVAILABLE";
      message: string;
      meta: MetaRespuesta;
    };

export interface DependenciasOrquestador {
  extraccion: DependenciasExtraccion;
  cliente: ClienteCotizacion;
  ahora?: () => number;
  idRequest?: () => string;
}

const MENSAJE_DEGRADADO =
  "No pudimos obtener la cotizacion en este momento. Intenta nuevamente en unos minutos.";

export async function procesarPeticion(
  entrada: PeticionEntrante,
  dependencias: DependenciasOrquestador,
): Promise<RespuestaOrquestador> {
  const ahora = dependencias.ahora ?? Date.now;
  const idRequest = dependencias.idRequest ?? (() => crypto.randomUUID());
  const inicio = ahora();
  const requestId = idRequest();

  const extraccion = await extraerPeticion(entrada.message_text, dependencias.extraccion);
  const avisos = extraccion.anomalias.map(
    (anomalia) => `${anomalia.campo}: ${anomalia.problema}`,
  );

  const meta = (intentos: number): MetaRespuesta => ({
    request_id: requestId,
    llm_provider: dependencias.extraccion.extractor.detalle,
    provider_attempts: intentos,
    duration_ms: ahora() - inicio,
    ...(avisos.length > 0 ? { warnings: avisos } : {}),
  });

  // --- Guardrail: aqui se corta ANTES de gastar una llamada al proveedor externo ---
  if (extraccion.estado === "incompleto") {
    return {
      status: "NEEDS_INFO",
      missing_fields: extraccion.faltantes,
      message: extraccion.mensaje,
      meta: meta(0),
    };
  }

  try {
    const resultado = await dependencias.cliente.cotizar(extraccion.peticion);
    return {
      status: "QUOTED",
      quote: resultado.valor,
      assumptions: extraccion.supuestos.map((supuesto) => ({
        field: supuesto.campo,
        value: supuesto.valor,
        reason: supuesto.motivo,
      })),
      meta: meta(resultado.intentos),
    };
  } catch (error) {
    // Degradacion elegante: el detalle tecnico se queda en la traza del servidor; al
    // usuario le llega un estado accionable, nunca una excepcion cruda ni un stack.
    const intentos = error instanceof ErrorAgotado ? error.intentos : 0;
    console.error(
      JSON.stringify({
        nivel: "error",
        evento: "carrier_agotado",
        request_id: requestId,
        motivo: error instanceof ErrorAgotado ? error.motivo : "desconocido",
        intentos,
        fallos: (error as { fallos?: unknown }).fallos ?? [],
      }),
    );
    return { status: "PROVIDER_UNAVAILABLE", message: MENSAJE_DEGRADADO, meta: meta(intentos) };
  }
}

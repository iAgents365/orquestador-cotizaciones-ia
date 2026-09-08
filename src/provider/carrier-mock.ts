/**
 * Mock del proveedor externo de cotizaciones. Reproduce lo que pide la Fase 3:
 * latencia variable de 1 a 3 s, fallos intermitentes 429/504 a tasa configurable, y una
 * respuesta CRUDA con nombres y tipos distintos a los del contrato de salida, para que
 * la normalizacion sea trabajo real y no un cambio de nombre.
 *
 * Se sirve como ruta HTTP dentro del mismo proceso (`POST /mock-carrier/quote`). Podria
 * haber sido una funcion en memoria, pero entonces el timeout, el `AbortSignal` y el
 * `Retry-After` serian simulaciones. Sobre HTTP son reales, y es la integracion que la
 * prueba quiere ver.
 *
 * La aleatoriedad es SEMBRABLE: con `CARRIER_SEED` fija, la secuencia de fallos se
 * repite exactamente. Sin eso, la evidencia adjunta no seria reproducible por quien
 * evalua, y "adjunte una corrida con suerte" no es evidencia.
 */
import type { ConfigCarrier } from "../config.ts";

/** mulberry32: generador pequeno, rapido y reproducible a partir de una semilla. */
export function generadorSembrado(semilla: string): () => number {
  let estado = 0;
  for (let i = 0; i < semilla.length; i += 1) {
    estado = (Math.imul(31, estado) + semilla.charCodeAt(i)) | 0;
  }
  let a = estado >>> 0;
  return function siguiente(): number {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Respuesta cruda del carrier: nombres abreviados, numeros como texto, moneda en minusculas. */
export interface RespuestaCrudaCarrier {
  carrier_code: string;
  orig_city: string;
  dest_city: string;
  billable_weight: string;
  svc: string;
  pieces: number;
  rate: { value: string; curr: string };
  eta_days: number;
  quote_ref: string;
}

export interface PeticionCarrier {
  origin: string;
  destination: string;
  weight_kg: number;
  service_type: string;
  package_count: number;
}

const MULTIPLICADOR_SERVICIO: Record<string, number> = {
  express: 1.75,
  standard: 1.0,
  economy: 0.8,
};

/** Tarifa deterministica: misma peticion, misma cifra. Facilita comprobar la evidencia. */
export function calcularTarifa(peticion: PeticionCarrier): number {
  const base = 120;
  const porKilo = 25 * peticion.weight_kg;
  const porBulto = 40 * Math.max(0, peticion.package_count - 1);
  const multiplicador = MULTIPLICADOR_SERVICIO[peticion.service_type] ?? 1;
  return Math.round((base + porKilo + porBulto) * multiplicador);
}

export interface ResultadoCarrier {
  status: number;
  cuerpo: RespuestaCrudaCarrier | { error: string };
  /** Segundos que el carrier pide esperar; solo en 429. */
  retryAfterSegundos?: number;
}

export interface CarrierMock {
  /** Decide latencia y exito/fallo. Respeta la senal: un abort corta la espera. */
  cotizar(peticion: PeticionCarrier, señal: AbortSignal): Promise<ResultadoCarrier>;
  /** Numero de llamadas recibidas: sirve para probar que los reintentos ocurrieron. */
  llamadas(): number;
}

export function crearCarrierMock(config: ConfigCarrier): CarrierMock {
  const azar = config.seed ? generadorSembrado(config.seed) : Math.random;
  let contador = 0;

  return {
    llamadas: () => contador,

    async cotizar(peticion, señal): Promise<ResultadoCarrier> {
      contador += 1;

      const rango = config.maxLatencyMs - config.minLatencyMs;
      const latencia = Math.floor(config.minLatencyMs + azar() * rango);

      await new Promise<void>((resolver, rechazar) => {
        if (señal.aborted) {
          rechazar(Object.assign(new Error("cancelado"), { name: "AbortError" }));
          return;
        }
        const temporizador = setTimeout(() => {
          señal.removeEventListener("abort", alAbortar);
          resolver();
        }, latencia);
        const alAbortar = (): void => {
          clearTimeout(temporizador);
          rechazar(Object.assign(new Error("cancelado"), { name: "AbortError" }));
        };
        señal.addEventListener("abort", alAbortar, { once: true });
      });

      if (azar() < config.failureRate) {
        // Se alternan los dos fallos que pide el enunciado. El 429 ademas manda
        // `Retry-After`, que el cliente debe obedecer por encima de su propio backoff.
        const es429 = azar() < 0.5;
        if (es429) {
          return {
            status: 429,
            cuerpo: { error: "rate limit exceeded" },
            retryAfterSegundos: 1,
          };
        }
        return { status: 504, cuerpo: { error: "upstream gateway timeout" } };
      }

      const importe = calcularTarifa(peticion);
      return {
        status: 200,
        cuerpo: {
          carrier_code: "MOCK-CARRIER",
          orig_city: peticion.origin,
          dest_city: peticion.destination,
          billable_weight: peticion.weight_kg.toFixed(1),
          svc: peticion.service_type.toUpperCase(),
          pieces: peticion.package_count,
          rate: { value: importe.toFixed(2), curr: "mxn" },
          eta_days: peticion.service_type === "express" ? 2 : 5,
          quote_ref: `MC-${String(contador).padStart(6, "0")}`,
        },
      };
    },
  };
}

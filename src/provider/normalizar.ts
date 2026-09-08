/**
 * Normalizacion de la respuesta del carrier: de su forma cruda a nuestro contrato.
 *
 * REGLA QUE SE APLICA AQUI: la respuesta cruda se VALIDA antes de transformarse. Un 200
 * no prueba que el cuerpo sirva — es el mismo error que dar por bueno un `exit 0`. Si el
 * proveedor cambia `rate.value` de "420.00" a null, queremos enterarnos en el borde con
 * un mensaje claro, y no propagar un `NaN` hasta la respuesta que ve el usuario.
 *
 * Un cuerpo invalido NO es reintentable: repetir la llamada daria el mismo cuerpo roto.
 */
import { z } from "zod";
import { ErrorProveedor } from "./cliente-resiliente.ts";

const numeroDesdeTexto = z.preprocess((valor) => {
  if (typeof valor !== "string") return valor;
  const limpio = valor.trim().replace(/,/gu, "");
  if (limpio === "" || !/^-?\d+(\.\d+)?$/.test(limpio)) return valor;
  return Number(limpio);
}, z.number().finite());

export const EsquemaRespuestaCruda = z.object({
  carrier_code: z.string().min(1),
  orig_city: z.string().min(1),
  dest_city: z.string().min(1),
  billable_weight: numeroDesdeTexto.pipe(z.number().positive()),
  svc: z.string().min(1),
  pieces: z.number().int().positive(),
  rate: z.object({
    value: numeroDesdeTexto.pipe(z.number().nonnegative()),
    curr: z.string().min(3).max(3),
  }),
  eta_days: z.number().int().nonnegative(),
  quote_ref: z.string().min(1),
});

export interface CotizacionNormalizada {
  origin: string;
  destination: string;
  weight_kg: number;
  service_type: string;
  package_count: number;
  amount: number;
  currency: string;
  provider: string;
  /** Extras del contrato propio, documentados en el README. */
  eta_days: number;
  quote_reference: string;
}

export function normalizarCotizacion(crudo: unknown): CotizacionNormalizada {
  const analizado = EsquemaRespuestaCruda.safeParse(crudo);
  if (!analizado.success) {
    const detalle = analizado.error.issues
      .map((problema) => `${problema.path.join(".")}: ${problema.message}`)
      .join("; ");
    throw new ErrorProveedor(`el carrier devolvio un cuerpo que no cumple su contrato: ${detalle}`, {
      reintentable: false,
    });
  }

  const datos = analizado.data;
  return {
    origin: datos.orig_city,
    destination: datos.dest_city,
    weight_kg: datos.billable_weight,
    service_type: datos.svc.toLowerCase(),
    package_count: datos.pieces,
    amount: datos.rate.value,
    currency: datos.rate.curr.toUpperCase(),
    provider: datos.carrier_code.toLowerCase(),
    eta_days: datos.eta_days,
    quote_reference: datos.quote_ref,
  };
}

/**
 * Cliente resiliente generico: timeout por intento, presupuesto total, reintentos con
 * backoff exponencial y FULL JITTER, y clasificacion entre errores reintentables y no.
 *
 * No sabe nada de cotizaciones. Envuelve cualquier operacion asincrona, para que la
 * politica de resiliencia se pueda razonar y probar sin levantar un servidor.
 *
 * POR QUE FULL JITTER Y NO SOLO BACKOFF EXPONENCIAL
 * Sin jitter, N clientes que fallan a la vez reintentan en el MISMO milisegundo, y otra
 * vez al doble, y otra al cuadruple. El backoff exponencial solo no dispersa la manada:
 * la sincroniza. Full jitter reparte cada reintento por toda la ventana:
 *
 *     espera = random(0, min(cap, base * 2^intento))
 *
 * Referencia: "Exponential Backoff And Jitter", Marc Brooker, AWS Architecture Blog.
 * Se eligio full jitter sobre equal jitter porque en la simulacion publicada de AWS
 * equal jitter hace mas trabajo y tarda mas, y full jitter no guarda estado mas alla
 * del numero de intento.
 */
import type { PoliticaReintentos } from "../config.ts";

/** Error con la informacion que la politica necesita para decidir si vale reintentar. */
export class ErrorProveedor extends Error {
  readonly status: number | undefined;
  readonly reintentable: boolean;
  /** Milisegundos pedidos por el propio proveedor via `Retry-After`. */
  readonly retryAfterMs: number | undefined;

  constructor(
    mensaje: string,
    opciones: {
      status?: number | undefined;
      reintentable: boolean;
      retryAfterMs?: number | undefined;
      causa?: unknown;
    },
  ) {
    super(mensaje, opciones.causa === undefined ? undefined : { cause: opciones.causa });
    this.name = "ErrorProveedor";
    this.status = opciones.status;
    this.reintentable = opciones.reintentable;
    this.retryAfterMs = opciones.retryAfterMs;
  }
}

/** El ciclo se agoto: ni un intento mas cabe, o el presupuesto se acabo. */
export class ErrorAgotado extends Error {
  readonly intentos: number;
  readonly motivo: "intentos" | "presupuesto" | "no-reintentable";
  readonly ultimoError: unknown;

  constructor(motivo: ErrorAgotado["motivo"], intentos: number, ultimoError: unknown) {
    const explicacion = {
      intentos: "se agotaron los intentos disponibles",
      presupuesto: "se agoto el presupuesto total de latencia",
      "no-reintentable": "el proveedor devolvio un error que no admite reintento",
    }[motivo];
    super(`Proveedor no disponible: ${explicacion}`);
    this.name = "ErrorAgotado";
    this.motivo = motivo;
    this.intentos = intentos;
    this.ultimoError = ultimoError;
  }
}

/**
 * Clasificacion por defecto.
 *
 * Reintentable: 408, 425, 429 y toda la familia 5xx, mas los fallos de red y los
 * timeouts (que llegan como `AbortError`).
 *
 * NO reintentable: el resto de 4xx. Un 400 o un 422 significa que la peticion esta mal
 * construida; repetirla identica solo gasta latencia del usuario y cuota del proveedor.
 */
export function esReintentable(error: unknown): boolean {
  if (error instanceof ErrorProveedor) return error.reintentable;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  // Fallos de red de undici/fetch: sin respuesta, no hubo decision del servidor.
  if (error instanceof TypeError) return true;
  return false;
}

export function reintentablePorStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/** `Retry-After` puede venir en segundos o como fecha HTTP. Devuelve ms, o undefined. */
export function leerRetryAfter(cabecera: string | null, ahora = Date.now()): number | undefined {
  if (!cabecera) return undefined;
  const recortada = cabecera.trim();
  if (/^\d+$/.test(recortada)) return Number(recortada) * 1000;
  const fecha = Date.parse(recortada);
  if (Number.isNaN(fecha)) return undefined;
  return Math.max(0, fecha - ahora);
}

export interface IntentoFallido {
  intento: number;
  error: string;
  status?: number | undefined;
  esperaMs?: number | undefined;
}

export interface ResultadoResiliente<T> {
  valor: T;
  intentos: number;
  fallos: IntentoFallido[];
  duracionMs: number;
}

export interface DependenciasResiliencia {
  /** Inyectables para que las pruebas sean deterministas y no esperen de verdad. */
  dormir?: (ms: number, señal: AbortSignal) => Promise<void>;
  azar?: () => number;
  ahora?: () => number;
}

const dormirReal = (ms: number, señal: AbortSignal): Promise<void> =>
  new Promise((resolver, rechazar) => {
    if (señal.aborted) return rechazar(new Error("cancelado"));
    const temporizador = setTimeout(() => {
      señal.removeEventListener("abort", alAbortar);
      resolver();
    }, ms);
    const alAbortar = () => {
      clearTimeout(temporizador);
      rechazar(new Error("cancelado"));
    };
    señal.addEventListener("abort", alAbortar, { once: true });
  });

/** espera = random(0, min(cap, base * 2^intento)) — full jitter de AWS. */
export function esperaConFullJitter(
  intento: number,
  politica: Pick<PoliticaReintentos, "backoffBaseMs" | "backoffCapMs">,
  azar: () => number,
): number {
  const techoExponencial = politica.backoffBaseMs * Math.pow(2, intento);
  const techo = Math.min(politica.backoffCapMs, techoExponencial);
  return Math.floor(azar() * techo);
}

/**
 * Ejecuta `operacion` con la politica dada.
 *
 * `operacion` recibe una `AbortSignal` ya combinada: se dispara cuando vence el timeout
 * de ESE intento o cuando se agota el presupuesto total, lo que ocurra primero. Una
 * peticion que ya no le sirve a nadie se aborta en vez de dejarla colgando.
 */
export async function ejecutarConReintentos<T>(
  operacion: (señal: AbortSignal, intento: number) => Promise<T>,
  politica: PoliticaReintentos,
  dependencias: DependenciasResiliencia = {},
): Promise<ResultadoResiliente<T>> {
  const dormir = dependencias.dormir ?? dormirReal;
  const azar = dependencias.azar ?? Math.random;
  const ahora = dependencias.ahora ?? Date.now;

  const inicio = ahora();
  const limite = inicio + politica.totalBudgetMs;
  const fallos: IntentoFallido[] = [];
  let ultimoError: unknown;

  for (let intento = 0; intento < politica.maxAttempts; intento += 1) {
    const restante = limite - ahora();
    // Con el presupuesto agotado no se lanza un intento condenado a abortar a media via.
    if (restante <= 0) {
      throw Object.assign(new ErrorAgotado("presupuesto", intento, ultimoError), { fallos });
    }

    const controlador = new AbortController();
    const msDeEsteIntento = Math.min(politica.timeoutMs, restante);
    const temporizador = setTimeout(() => controlador.abort(), msDeEsteIntento);

    try {
      const valor = await operacion(controlador.signal, intento);
      clearTimeout(temporizador);
      return { valor, intentos: intento + 1, fallos, duracionMs: ahora() - inicio };
    } catch (error) {
      clearTimeout(temporizador);
      ultimoError = error;

      const status = error instanceof ErrorProveedor ? error.status : undefined;

      if (!esReintentable(error)) {
        fallos.push({ intento: intento + 1, error: String(error), status });
        throw Object.assign(new ErrorAgotado("no-reintentable", intento + 1, error), { fallos });
      }

      const esUltimo = intento === politica.maxAttempts - 1;
      if (esUltimo) {
        fallos.push({ intento: intento + 1, error: String(error), status });
        throw Object.assign(new ErrorAgotado("intentos", intento + 1, error), { fallos });
      }

      // El proveedor manda si pidio una espera explicita; si no, full jitter.
      const pedidaPorElProveedor =
        error instanceof ErrorProveedor ? error.retryAfterMs : undefined;
      const calculada = esperaConFullJitter(intento, politica, azar);
      let espera = pedidaPorElProveedor ?? calculada;

      // Nunca esperar mas alla del presupuesto: mejor cortar limpio que dormir de mas.
      const restanteTrasFallo = limite - ahora();
      if (espera >= restanteTrasFallo) {
        fallos.push({ intento: intento + 1, error: String(error), status });
        throw Object.assign(new ErrorAgotado("presupuesto", intento + 1, error), { fallos });
      }

      fallos.push({ intento: intento + 1, error: String(error), status, esperaMs: espera });

      const controladorEspera = new AbortController();
      const cortePresupuesto = setTimeout(
        () => controladorEspera.abort(),
        Math.max(0, restanteTrasFallo),
      );
      try {
        await dormir(espera, controladorEspera.signal);
      } catch {
        throw Object.assign(new ErrorAgotado("presupuesto", intento + 1, error), { fallos });
      } finally {
        clearTimeout(cortePresupuesto);
      }
    }
  }

  throw Object.assign(new ErrorAgotado("intentos", politica.maxAttempts, ultimoError), { fallos });
}

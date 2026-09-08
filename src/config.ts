/**
 * TODA la politica operativa vive aqui y se lee UNA vez, al arrancar.
 *
 * Regla dura: ningun modulo lee `process.env` por su cuenta, y sobre todo nunca dentro
 * del bucle de reintentos. Las fabricas reciben su configuracion inyectada. Eso es lo
 * que convierte "cambia a 2 intentos y un timeout mas agresivo" en editar una linea del
 * .env o pasar un objeto distinto en una prueba, en vez de perseguir constantes.
 */
import { z } from "zod";

const entero = (pordefecto: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(pordefecto);

const decimal = (pordefecto: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(pordefecto);

const EsquemaEntorno = z.object({
  PORT: entero(3000, 1, 65535),
  HOST: z.string().default("127.0.0.1"),

  LLM_PROVIDER: z.enum(["mock", "ollama", "gemini"]).default("mock"),
  /**
   * 30 s. Parece generoso y lo es a proposito: lo dicta el proveedor mas lento, que es
   * un modelo local en CPU. Medido en este equipo (Ryzen 5 PRO 4650U, sin aceleracion),
   * una extraccion con qwen2.5:3b tarda ~9 s. Con el default anterior de 8000 ms, el
   * timeout abortaba SIEMPRE la ruta de Ollama.
   *
   * La degradacion se comporto bien —cayo a NEEDS_INFO avisando del fallo, sin inventar
   * datos— pero un timeout que nunca deja terminar al proveedor no protege: lo inutiliza.
   * Con `mock` el valor es irrelevante (respuesta inmediata) y con Gemini conviene bajarlo
   * a 5000-8000, porque ahi 30 s de espera si son una anomalia real.
   */
  LLM_TIMEOUT_MS: entero(30000, 100, 120000),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("llama3.2:3b"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-lite-latest"),

  PROVIDER_MAX_ATTEMPTS: entero(3, 1, 10),
  /**
   * 3500 ms, no 2500. El carrier tarda entre 1000 y 3000 ms por diseno del enunciado.
   * Un timeout de 2500 cae DENTRO de esa franja, asi que aborta ~25% de las llamadas que
   * iban a responder bien: el sistema se fabrica sus propios fallos y luego los reintenta.
   * Se midio: con 2500, el escenario de exito consumia 2 intentos y 4.8 s.
   * El timeout por intento se pone por ENCIMA de la latencia normal del proveedor; su
   * trabajo es cortar lo anormal, no lo lento.
   */
  PROVIDER_TIMEOUT_MS: entero(3500, 50, 60000),
  PROVIDER_TOTAL_BUDGET_MS: entero(9000, 100, 120000),
  PROVIDER_BACKOFF_BASE_MS: entero(250, 0, 60000),
  PROVIDER_BACKOFF_CAP_MS: entero(4000, 0, 60000),

  CARRIER_FAILURE_RATE: decimal(0.25, 0, 1),
  CARRIER_MIN_LATENCY_MS: entero(1000, 0, 60000),
  CARRIER_MAX_LATENCY_MS: entero(3000, 0, 60000),
  CARRIER_SEED: z.string().optional(),
});

export interface PoliticaReintentos {
  /** INTENTOS TOTALES, no reintentos adicionales: 3 = tres llamadas como maximo. */
  maxAttempts: number;
  /** Timeout de cada intento por separado. */
  timeoutMs: number;
  /**
   * Techo de latencia del ciclo completo, esperas de backoff incluidas. Corta aunque
   * queden intentos disponibles. Sin esto, `maxAttempts * timeoutMs + backoff` puede
   * dejar al usuario esperando mucho mas de lo que nadie decidio conscientemente.
   */
  totalBudgetMs: number;
  /** Full jitter: espera = random(0, min(cap, base * 2^intento)). */
  backoffBaseMs: number;
  backoffCapMs: number;
}

export interface ConfigCarrier {
  failureRate: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Fijar la semilla hace reproducible la secuencia de fallos (evidencia estable). */
  seed?: string | undefined;
}

export interface ConfigLlm {
  provider: "mock" | "ollama" | "gemini";
  timeoutMs: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  geminiApiKey?: string | undefined;
  geminiModel: string;
}

export interface Config {
  port: number;
  host: string;
  llm: ConfigLlm;
  reintentos: PoliticaReintentos;
  carrier: ConfigCarrier;
}

export function cargarConfig(entorno: NodeJS.ProcessEnv = process.env): Config {
  const analizado = EsquemaEntorno.safeParse(entorno);
  if (!analizado.success) {
    const detalle = analizado.error.issues
      .map((problema) => `  ${problema.path.join(".")}: ${problema.message}`)
      .join("\n");
    throw new Error(`Configuracion invalida:\n${detalle}`);
  }
  const valores = analizado.data;

  if (valores.CARRIER_MIN_LATENCY_MS > valores.CARRIER_MAX_LATENCY_MS) {
    throw new Error(
      "Configuracion invalida: CARRIER_MIN_LATENCY_MS no puede superar a CARRIER_MAX_LATENCY_MS",
    );
  }

  // Aviso operativo, no un fallo: el presupuesto total manda sobre los intentos, y si es
  // mas corto que un solo intento nunca se reintentaria. Mejor decirlo al arrancar que
  // dejar que alguien lo descubra leyendo trazas.
  if (valores.PROVIDER_TOTAL_BUDGET_MS < valores.PROVIDER_TIMEOUT_MS) {
    console.warn(
      "[config] PROVIDER_TOTAL_BUDGET_MS es menor que PROVIDER_TIMEOUT_MS: " +
        "el presupuesto cortara el primer intento antes de que expire su propio timeout.",
    );
  }

  return Object.freeze({
    port: valores.PORT,
    host: valores.HOST,
    llm: {
      provider: valores.LLM_PROVIDER,
      timeoutMs: valores.LLM_TIMEOUT_MS,
      ollamaBaseUrl: valores.OLLAMA_BASE_URL,
      ollamaModel: valores.OLLAMA_MODEL,
      geminiApiKey: valores.GEMINI_API_KEY,
      geminiModel: valores.GEMINI_MODEL,
    },
    reintentos: {
      maxAttempts: valores.PROVIDER_MAX_ATTEMPTS,
      timeoutMs: valores.PROVIDER_TIMEOUT_MS,
      totalBudgetMs: valores.PROVIDER_TOTAL_BUDGET_MS,
      backoffBaseMs: valores.PROVIDER_BACKOFF_BASE_MS,
      backoffCapMs: valores.PROVIDER_BACKOFF_CAP_MS,
    },
    carrier: {
      failureRate: valores.CARRIER_FAILURE_RATE,
      minLatencyMs: valores.CARRIER_MIN_LATENCY_MS,
      maxLatencyMs: valores.CARRIER_MAX_LATENCY_MS,
      seed: valores.CARRIER_SEED,
    },
  });
}

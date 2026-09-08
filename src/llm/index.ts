/**
 * Interfaz unica de extraccion. La logica de negocio NO conoce al proveedor.
 *
 * Contrato deliberado: `extraer` devuelve `unknown` — JSON crudo tal como lo emitio el
 * modelo, sin validar. Validar es trabajo del guardrail determinista, no del adaptador.
 * Si un adaptador "arreglara" la salida antes de devolverla, el guardrail estaria
 * midiendo el arreglo en vez de al modelo.
 */
import type { ConfigLlm } from "../config.ts";
import { crearExtractorMock } from "./mock.ts";
import { crearExtractorOllama } from "./ollama.ts";
import { crearExtractorGemini } from "./gemini.ts";

export interface ExtractorLlm {
  /** Identificador corto que viaja en el contrato de salida y en las trazas. */
  readonly nombre: "mock" | "ollama" | "gemini";
  /** Descripcion con modelo concreto, p. ej. "ollama:llama3.2:3b". */
  readonly detalle: string;
  /** JSON crudo del modelo. Puede traer campos de mas, de menos o mal tipados. */
  extraer(mensaje: string, señal: AbortSignal): Promise<unknown>;
}

export function crearExtractor(config: ConfigLlm): ExtractorLlm {
  switch (config.provider) {
    case "mock":
      return crearExtractorMock();
    case "ollama":
      return crearExtractorOllama(config);
    case "gemini":
      return crearExtractorGemini(config);
    default: {
      // Exhaustividad comprobada por el compilador: un proveedor nuevo sin caso no compila.
      const inalcanzable: never = config.provider;
      throw new Error(`proveedor de LLM no soportado: ${String(inalcanzable)}`);
    }
  }
}

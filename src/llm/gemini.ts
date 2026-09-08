/**
 * Adaptador de Google AI Studio (Gemini Flash, capa gratuita).
 *
 * La clave SIEMPRE viene de una variable de entorno y jamas se versiona ni se imprime.
 *
 * Falla CERRADO: si se pide este proveedor y la clave no esta, el proceso no arranca.
 * Nada de `if (clave && ...)`, que degradaria en silencio a un camino sin autenticar.
 * Una guarda que depende de una variable de entorno y no la encuentra, deniega.
 */
import type { ConfigLlm } from "../config.ts";
import { descripcionDeCamposParaPrompt, jsonSchemaDeExtraccion } from "../schema.ts";
import { ErrorProveedor, reintentablePorStatus } from "../provider/cliente-resiliente.ts";
import type { ExtractorLlm } from "./index.ts";
import { construirPrompt } from "./ollama.ts";

/**
 * `responseSchema` de Gemini es un subconjunto de JSON Schema y rechaza
 * `additionalProperties`. Se poda aqui en vez de mantener dos esquemas a mano.
 */
function podarParaGemini(esquema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _descartado, ...resto } = esquema;
  return resto;
}

export function crearExtractorGemini(config: ConfigLlm): ExtractorLlm {
  const clave = config.geminiApiKey?.trim();
  if (!clave) {
    throw new Error(
      "LLM_PROVIDER=gemini pero falta GEMINI_API_KEY. " +
        "Consiguela en https://aistudio.google.com/apikey y ponla en .env (nunca en el repo). " +
        "Alternativa sin claves: LLM_PROVIDER=mock",
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.geminiModel)}:generateContent`;

  return {
    nombre: "gemini",
    detalle: `gemini:${config.geminiModel}`,
    async extraer(mensaje: string, señal: AbortSignal): Promise<unknown> {
      let respuesta: Response;
      try {
        respuesta = await fetch(url, {
          method: "POST",
          // La clave va en cabecera, no en la query: una URL termina en logs y en historiales.
          headers: { "Content-Type": "application/json", "x-goog-api-key": clave },
          signal: señal,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: construirPrompt(mensaje) }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json",
              responseSchema: podarParaGemini(jsonSchemaDeExtraccion()),
            },
          }),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ErrorProveedor("no se pudo contactar a Google AI Studio", {
          reintentable: true,
          causa: error,
        });
      }

      if (!respuesta.ok) {
        const cuerpo = await respuesta.text().catch(() => "");
        // El cuerpo de error puede repetir la peticion; se recorta y NUNCA se anexa la clave.
        throw new ErrorProveedor(`Gemini respondio ${respuesta.status}: ${cuerpo.slice(0, 300)}`, {
          status: respuesta.status,
          reintentable: reintentablePorStatus(respuesta.status),
        });
      }

      const sobre = (await respuesta.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      };
      const texto = sobre.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof texto !== "string") {
        throw new ErrorProveedor("Gemini devolvio una respuesta sin texto utilizable", {
          reintentable: false,
        });
      }

      try {
        return JSON.parse(texto);
      } catch (error) {
        throw new ErrorProveedor(`Gemini devolvio algo que no es JSON: ${texto.slice(0, 200)}`, {
          reintentable: false,
          causa: error,
        });
      }
    },
  };
}

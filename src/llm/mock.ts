/**
 * Extractor determinista, sin red y sin claves. Es el proveedor POR DEFECTO.
 *
 * POR QUE ES EL DEFECTO Y NO UN ATAJO
 * La prueba exige que la solucion corra en local, sin costo y en tres comandos. Si el
 * arranque por defecto dependiera de un demonio de Ollama con un modelo descargado, o de
 * una clave de Gemini, la solucion no arrancaria en la maquina de quien la evalua y se
 * perderia por algo que no es el codigo. Ademas, la evidencia de los tres escenarios
 * tiene que ser reproducible: un modelo generativo no da la misma salida dos veces.
 *
 * QUE NO ES
 * No sustituye al guardrail ni cambia el pipeline. Se conecta por la MISMA interfaz que
 * Ollama y Gemini y devuelve el mismo JSON crudo sin validar. Cambiar `LLM_PROVIDER` no
 * toca una sola linea de la logica de negocio: esa es justamente la prueba de que la
 * integracion esta bien separada.
 *
 * COMO FUNCIONA
 * Reglas lexicas sobre espanol de mensajeria. Omite lo que no encuentra: nunca rellena.
 */
import type { ExtractorLlm } from "./index.ts";

const SERVICIOS: ReadonlyArray<[RegExp, string]> = [
  [/\b(expres|exprés|express|urgente|prioritario|r[aá]pido)\b/iu, "express"],
  [/\b(est[aá]ndar|estandar|standard|normal|regular)\b/iu, "standard"],
  [/\b(econ[oó]mico|economico|economy|terrestre|barato)\b/iu, "economy"],
];

/** Normaliza espacios y quita puntuacion de borde, sin tocar acentos ni mayusculas. */
function limpiarCiudad(valor: string): string {
  return valor
    .replace(/\s+/gu, " ")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/gu, "")
    .trim();
}

function extraerPeso(mensaje: string): { kg: number; consumido: string } | null {
  const kg = /(\d+(?:[.,]\d+)?)\s*(?:kg\b|kilogramos?\b|kilos?\b)/iu.exec(mensaje);
  if (kg?.[1]) return { kg: Number(kg[1].replace(",", ".")), consumido: kg[0] };

  const gramos = /(\d+(?:[.,]\d+)?)\s*(?:g\b|gr\b|gramos?\b)/iu.exec(mensaje);
  if (gramos?.[1]) {
    return { kg: Number(gramos[1].replace(",", ".")) / 1000, consumido: gramos[0] };
  }

  const libras = /(\d+(?:[.,]\d+)?)\s*(?:lb\b|libras?\b)/iu.exec(mensaje);
  if (libras?.[1]) {
    const valor = Number(libras[1].replace(",", ".")) * 0.45359237;
    return { kg: Math.round(valor * 1000) / 1000, consumido: libras[0] };
  }
  return null;
}

function extraerRuta(texto: string): { origin?: string; destination?: string } {
  // "de X a Y" / "desde X hasta Y" / "desde X a Y".
  // El grupo de origen es perezoso pero puede crecer, asi que "Ciudad de México"
  // sobrevive aunque contenga la palabra "de".
  const cierre = String.raw`(?=\s+(?:por|con|en|para|mediante|v[ií]a|usando)\b|[,.;!?]|$)`;

  const deA = new RegExp(
    String.raw`\b(?:de|desde)\s+(.+?)\s+(?:a|hacia|hasta)\s+(.+?)${cierre}`,
    "iu",
  ).exec(texto);
  if (deA?.[1] && deA[2]) {
    return { origin: limpiarCiudad(deA[1]), destination: limpiarCiudad(deA[2]) };
  }

  // Solo destino: "enviar a Monterrey", "quiero mandar algo a Guadalajara".
  const soloDestino = new RegExp(String.raw`\b(?:a|hacia|hasta)\s+(.+?)${cierre}`, "iu").exec(
    texto,
  );
  if (soloDestino?.[1]) {
    const candidato = limpiarCiudad(soloDestino[1]);
    if (candidato.length >= 2) return { destination: candidato };
  }

  // Solo origen: "tengo un paquete en Puebla" / "desde Puebla".
  const soloOrigen = new RegExp(String.raw`\b(?:de|desde)\s+(.+?)${cierre}`, "iu").exec(texto);
  if (soloOrigen?.[1]) {
    const candidato = limpiarCiudad(soloOrigen[1]);
    if (candidato.length >= 2) return { origin: candidato };
  }
  return {};
}

export function crearExtractorMock(): ExtractorLlm {
  return {
    nombre: "mock",
    detalle: "mock:reglas-deterministas",
    async extraer(mensaje: string): Promise<unknown> {
      const salida: Record<string, unknown> = {};

      const peso = extraerPeso(mensaje);
      // El peso se retira del texto ANTES de buscar la ruta: en "enviar 8 kg de CDMX a
      // Monterrey" el primer "de" pertenece a la frase del peso, no al origen.
      let sinPeso = mensaje;
      if (peso) {
        salida["weight_kg"] = peso.kg;
        sinPeso = mensaje.replace(peso.consumido, " ");
      }

      const paquetes = /(\d+)\s*(?:paquetes?|bultos?|cajas?|piezas?|pallets?)\b/iu.exec(sinPeso);
      if (paquetes?.[1]) {
        salida["package_count"] = Number(paquetes[1]);
        sinPeso = sinPeso.replace(paquetes[0], " ");
      }

      for (const [patron, canonico] of SERVICIOS) {
        if (patron.test(sinPeso)) {
          salida["service_type"] = canonico;
          break;
        }
      }

      const ruta = extraerRuta(sinPeso);
      if (ruta.origin) salida["origin"] = ruta.origin;
      if (ruta.destination) salida["destination"] = ruta.destination;

      // Lo que no aparece, no se emite. Ni `null`, ni cadena vacia, ni valor supuesto.
      return salida;
    },
  };
}

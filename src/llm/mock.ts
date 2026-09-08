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
import { parsearNumero } from "../schema.ts";
import type { ExtractorLlm } from "./index.ts";

const SERVICIOS: ReadonlyArray<[RegExp, string]> = [
  [/\b(expres|exprés|express|urgente|prioritario|r[aá]pido)\b/iu, "express"],
  [/\b(est[aá]ndar|estandar|standard|normal|regular)\b/iu, "standard"],
  [/\b(econ[oó]mico|economico|economy|terrestre|barato)\b/iu, "economy"],
];

/**
 * Detecta el tipo de servicio RESPETANDO LA NEGACION.
 *
 * Fallo medido: `"5 kg de Puebla a Leon, NO urgente, que sea normal"` devolvia `express`,
 * porque la busqueda encontraba "urgente" y se detenia sin mirar lo que tenia delante. El
 * usuario habia dicho exactamente lo contrario.
 *
 * Se descarta cualquier coincidencia precedida de una negacion cercana y se sigue buscando.
 * Si todas estan negadas, no se devuelve nada: preguntar es mejor que invertir el sentido.
 */
function detectarServicio(texto: string): string | null {
  const NEGACION = /\b(no|nada\s+de|sin|nunca|tampoco)\s*$/iu;

  for (const [patron, canonico] of SERVICIOS) {
    const global = new RegExp(patron.source, "giu");
    let coincidencia: RegExpExecArray | null;
    while ((coincidencia = global.exec(texto)) !== null) {
      const antes = texto.slice(Math.max(0, coincidencia.index - 14), coincidencia.index);
      if (!NEGACION.test(antes)) return canonico;
    }
  }
  return null;
}

/** Normaliza espacios y quita puntuacion de borde, sin tocar acentos ni mayusculas. */
function limpiarCiudad(valor: string): string {
  return valor
    .replace(/\s+/gu, " ")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/gu, "")
    .trim();
}

/**
 * El numero se captura CON su signo y sus separadores, y lo interpreta `parsearNumero`.
 *
 * Antes el patron era `(\d+...)`, que no captura el menos: `"-5 kg"` producia `5` y el
 * sistema cotizaba un peso negativo como si fuera positivo. Y la conversion se hacia aqui
 * con `replace(",", ".")`, que convertia `"1,500"` en `1.5` — un error de factor mil.
 *
 * Ahora el adaptador solo RECONOCE la cifra; interpretarla es trabajo del guardrail, que
 * es quien sabe rechazar lo ambiguo. Un adaptador que interpreta es un adaptador que
 * decide, y decidir no le toca.
 */
const CIFRA = String.raw`([+-]?\d[\d.,]*)`;

function extraerPeso(mensaje: string): { kg: number; consumido: string } | null {
  const unidades: Array<[RegExp, (n: number) => number]> = [
    [new RegExp(String.raw`${CIFRA}\s*(?:kg\b|kilogramos?\b|kilos?\b)`, "iu"), (n) => n],
    [new RegExp(String.raw`${CIFRA}\s*(?:g\b|gr\b|gramos?\b)`, "iu"), (n) => n / 1000],
    [
      new RegExp(String.raw`${CIFRA}\s*(?:lb\b|libras?\b)`, "iu"),
      (n) => Math.round(n * 0.45359237 * 1000) / 1000,
    ],
  ];

  for (const [patron, aKilos] of unidades) {
    const encontrado = patron.exec(mensaje);
    if (!encontrado?.[1]) continue;
    const numero = parsearNumero(encontrado[1]);
    // Ambiguo, negativo o basura: se devuelve `null` y el campo queda ausente, que manda
    // el mensaje a NEEDS_INFO. Preguntar es mejor que adivinar un factor de mil.
    if (numero === null) return null;
    return { kg: aKilos(numero), consumido: encontrado[0] };
  }
  return null;
}

/**
 * Palabras que CIERRAN el nombre de una ciudad.
 *
 * Nacio de un fallo medido: con solo las preposiciones, `"de Puebla a Leon express"` daba
 * `destination = "Leon express"` — el nombre se tragaba la palabra siguiente y el sistema
 * cotizaba a una ciudad inexistente. Ahora tambien cierran las palabras de servicio y de
 * embalaje, que son las que en espanol suelen ir pegadas detras del destino.
 */
const PALABRAS_DE_CIERRE = [
  "por", "con", "en", "para", "mediante", "via", "vía", "usando",
  "express", "expres", "exprés", "urgente", "prioritario", "rapido", "rápido",
  "standard", "estandar", "estándar", "normal", "regular",
  "economy", "economico", "económico", "terrestre", "barato",
  "servicio", "paquete", "paquetes", "bulto", "bultos", "caja", "cajas",
].join("|");

/**
 * El nombre de una ciudad no cruza puntuacion de frase.
 *
 * Otro fallo medido: `"de Puebla, no se todavia a donde"` producia
 * `origin = "Puebla, no se todavia"` y `destination = "donde"`. Al prohibir la coma dentro
 * del nombre, ese patron ya no encaja y el mensaje cae —correctamente— en NEEDS_INFO.
 */
const CUERPO_CIUDAD = String.raw`[^,;:!?¡¿]+?`;

function extraerRuta(texto: string): { origin?: string; destination?: string } {
  // El grupo de origen es perezoso pero puede crecer, asi que "Ciudad de México"
  // sobrevive aunque contenga la palabra "de".
  const cierre = String.raw`(?=\s+(?:${PALABRAS_DE_CIERRE})\b|[,.;!?]|$)`;

  const deA = new RegExp(
    String.raw`\b(?:de|desde)\s+(${CUERPO_CIUDAD})\s+(?:a|hacia|hasta)\s+(${CUERPO_CIUDAD})${cierre}`,
    "iu",
  ).exec(texto);
  if (deA?.[1] && deA[2]) {
    return { origin: limpiarCiudad(deA[1]), destination: limpiarCiudad(deA[2]) };
  }

  // Solo destino: "enviar a Monterrey", "quiero mandar algo a Guadalajara".
  const soloDestino = new RegExp(
    String.raw`\b(?:a|hacia|hasta)\s+(${CUERPO_CIUDAD})${cierre}`,
    "iu",
  ).exec(texto);
  if (soloDestino?.[1]) {
    const candidato = limpiarCiudad(soloDestino[1]);
    if (candidato.length >= 2) return { destination: candidato };
  }

  // Solo origen: "tengo un paquete en Puebla" / "desde Puebla".
  const soloOrigen = new RegExp(
    String.raw`\b(?:de|desde)\s+(${CUERPO_CIUDAD})${cierre}`,
    "iu",
  ).exec(texto);
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

      const paquetes = new RegExp(
        String.raw`${CIFRA}\s*(?:paquetes?|bultos?|cajas?|piezas?|pallets?)\b`,
        "iu",
      ).exec(sinPeso);
      if (paquetes?.[1]) {
        const cantidad = parsearNumero(paquetes[1]);
        if (cantidad !== null) salida["package_count"] = cantidad;
        sinPeso = sinPeso.replace(paquetes[0], " ");
      }

      salida["service_type"] = detectarServicio(sinPeso) ?? undefined;
      if (salida["service_type"] === undefined) delete salida["service_type"];

      const ruta = extraerRuta(sinPeso);
      if (ruta.origin) salida["origin"] = ruta.origin;
      if (ruta.destination) salida["destination"] = ruta.destination;

      // Lo que no aparece, no se emite. Ni `null`, ni cadena vacia, ni valor supuesto.
      return salida;
    },
  };
}

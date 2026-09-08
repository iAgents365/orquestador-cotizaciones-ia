/**
 * FUENTE UNICA DE VERDAD DEL MODELO DE DATOS.
 *
 * Todo lo demas se DERIVA de `CAMPOS`: los tipos de TypeScript, el esquema laxo de
 * extraccion, el esquema estricto previo al proveedor, la lista de campos obligatorios,
 * los mensajes de `NEEDS_INFO` y la descripcion que se le manda al LLM.
 *
 * POR QUE ASI: en la sesion de validacion en vivo se pide "agrega un campo a la
 * extraccion". Si el nombre del campo viviera duplicado en una interfaz, un JSON Schema,
 * un prompt y una lista de obligatorios, ese cambio seria una caceria de inconsistencias.
 * Aqui es UNA entrada en este objeto y nada mas.
 */
import { z } from "zod";

// --- Normalizadores deterministas -------------------------------------------------
// El LLM devuelve lenguaje humano; el tipo canonico lo decide el codigo, no el modelo.

const TIPOS_DE_SERVICIO = ["express", "standard", "economy"] as const;
export type TipoServicio = (typeof TIPOS_DE_SERVICIO)[number];

const SINONIMOS_SERVICIO: Record<string, TipoServicio> = {
  express: "express",
  expres: "express",
  exprés: "express",
  urgente: "express",
  rapido: "express",
  rápido: "express",
  prioritario: "express",
  standard: "standard",
  estandar: "standard",
  estándar: "standard",
  normal: "standard",
  regular: "standard",
  economy: "economy",
  economico: "economy",
  económico: "economy",
  terrestre: "economy",
  barato: "economy",
};

const sinAcentos = (valor: string): string =>
  valor.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** "Exprés" / "URGENTE" / " express " -> "express". Desconocido -> falla la validacion. */
const servicioNormalizado = z.preprocess((valor) => {
  if (typeof valor !== "string") return valor;
  const clave = sinAcentos(valor.trim().toLowerCase());
  return SINONIMOS_SERVICIO[clave] ?? valor.trim().toLowerCase();
}, z.enum(TIPOS_DE_SERVICIO));

/** Acepta 8 y "8" y "8.5", rechaza "ocho". Sin coercion silenciosa de basura. */
const numeroPositivo = z.preprocess((valor) => {
  if (typeof valor !== "string") return valor;
  const limpio = valor.trim().replace(",", ".");
  if (limpio === "" || !/^\d+(\.\d+)?$/.test(limpio)) return valor;
  return Number(limpio);
}, z.number().positive().finite());

const enteroPositivo = z.preprocess((valor) => {
  if (typeof valor !== "string") return valor;
  const limpio = valor.trim();
  if (limpio === "" || !/^\d+$/.test(limpio)) return valor;
  return Number(limpio);
}, z.number().int().positive());

/**
 * MARCADORES DE AUSENCIA — una guarda que existe por un fallo medido, no por precaucion.
 *
 * Con decodificacion restringida el modelo NO puede omitir un campo cuyo tipo es string
 * si decide emitir la clave: tiene que escribir algo. Y cuando "algo" no existe, los
 * modelos pequenos escriben una excusa dentro del valor.
 *
 * Medido el 2026-09-07 con llama3.2:3b sobre "Necesito enviar 8 kg desde Ciudad de
 * Mexico por servicio expres" (sin destino):
 *
 *     { "destination": "(omitiendo este dato)", ... }
 *
 * Sin esta guarda, esa cadena pasaba la validacion de ciudad —tiene mas de 2 caracteres—
 * y el sistema habria COTIZADO un envio a una ciudad llamada "(omitiendo este dato)".
 * El guardrail habria dicho que si a un supuesto inventado por el modelo.
 *
 * Leccion general, y es la que importa: restringir la FORMA de la salida no impide que
 * el contenido sea una confesion de ausencia. Un esquema valida estructura; el
 * significado necesita su propia guarda.
 */
const MARCADORES_DE_AUSENCIA = [
  /^\s*[([{<]/u, // "(omitiendo este dato)", "[sin dato]", "<desconocido>"
  /\b(omit|desconoc|no\s+especific|sin\s+especific|no\s+indic|no\s+proporcion|no\s+mencion|por\s+definir|pendiente)/iu,
  /^\s*(n\s*\/?\s*a|na|null|none|nil|undefined|unknown|tbd|ninguno|ninguna|vacio|vacío|\?+|-+|_+)\s*$/iu,
];

export function pareceMarcadorDeAusencia(valor: string): boolean {
  return MARCADORES_DE_AUSENCIA.some((patron) => patron.test(valor));
}

const textoLibre = (minimo: number, maximo: number, etiqueta: string) =>
  z
    .string()
    .trim()
    .min(minimo, `${etiqueta} necesita al menos ${minimo} caracteres`)
    .max(maximo)
    .refine((valor) => !pareceMarcadorDeAusencia(valor), {
      message: "el modelo escribio un marcador de ausencia en vez de un valor real",
    });

const ciudad = textoLibre(2, 120, "una ciudad");

// --- El registro de campos --------------------------------------------------------

export interface DefinicionCampo {
  /** Validacion del valor cuando SI viene. */
  esquema: z.ZodTypeAny;
  /**
   * Tipo declarado para el JSON Schema que se le pasa al LLM como salida forzada
   * (`format` en Ollama, `responseSchema` en Gemini). Vive aqui, junto al resto de la
   * definicion, para que agregar un campo siga siendo UNA sola edicion.
   */
  tipoJson: "string" | "number" | "integer";
  /** Valores permitidos, si el campo es cerrado. */
  enumJson?: readonly string[];
  /**
   * `true`  -> si falta, el flujo se detiene con NEEDS_INFO.
   * `false` -> puede tener un default DECLARADO (ver `valorPorDefecto`).
   */
  obligatorio: boolean;
  /**
   * Default explicito para campos no obligatorios.
   *
   * La prueba prohibe "supuestos silenciosos". Un default declarado no es silencioso:
   * se documenta aqui, se anuncia en el contrato de salida dentro de `assumptions[]`
   * y se puede desactivar. Lo que nunca hacemos es rellenar con `null` ni inventar.
   */
  valorPorDefecto?: unknown;
  /** Se inyecta en el prompt del LLM. */
  descripcion: string;
  /** Frase humana para el mensaje de NEEDS_INFO. */
  faltante: string;
}

export const CAMPOS = {
  origin: {
    esquema: ciudad,
    tipoJson: "string",
    obligatorio: true,
    descripcion: "Ciudad o lugar de origen del envio, tal como la escribio el usuario.",
    faltante: "la ciudad de origen",
  },
  destination: {
    esquema: ciudad,
    tipoJson: "string",
    obligatorio: true,
    descripcion: "Ciudad o lugar de destino del envio, tal como la escribio el usuario.",
    faltante: "la ciudad de destino",
  },
  weight_kg: {
    esquema: numeroPositivo,
    tipoJson: "number",
    obligatorio: true,
    descripcion: "Peso total del envio en kilogramos, como numero. Si viene en gramos o libras, conviertelo a kg.",
    faltante: "el peso en kilogramos",
  },
  service_type: {
    esquema: servicioNormalizado,
    tipoJson: "string",
    enumJson: TIPOS_DE_SERVICIO,
    obligatorio: true,
    descripcion:
      'Tipo de servicio. Uno de: "express" (urgente, exprés, prioritario), "standard" (normal, estándar) o "economy" (económico, terrestre).',
    faltante: "el tipo de servicio",
  },
  package_count: {
    esquema: enteroPositivo,
    tipoJson: "integer",
    obligatorio: false,
    valorPorDefecto: 1,
    descripcion: "Numero de paquetes o bultos. Omitelo si el mensaje no lo dice; NO lo adivines.",
    faltante: "el numero de paquetes",
  },
} as const satisfies Record<string, DefinicionCampo>;

export type NombreCampo = keyof typeof CAMPOS;

export const NOMBRES_CAMPOS = Object.keys(CAMPOS) as NombreCampo[];

export const CAMPOS_OBLIGATORIOS = NOMBRES_CAMPOS.filter(
  (nombre) => CAMPOS[nombre].obligatorio,
);

// --- Esquemas derivados -----------------------------------------------------------

/**
 * NIVEL 1 — Candidato de extraccion.
 *
 * Estricto en TIPOS y en claves desconocidas, pero PERMITE OMISIONES: que el usuario
 * no diga el destino es un caso normal del negocio, no un fallo del extractor.
 *
 * `null` no se acepta a proposito. Ausencia significa "no venia en el mensaje"; un
 * `null` explicito seria el modelo afirmando un valor vacio, que es justo el supuesto
 * silencioso que la prueba prohibe.
 */
export const EsquemaCandidato = z
  .object(
    Object.fromEntries(
      NOMBRES_CAMPOS.map((nombre) => [nombre, CAMPOS[nombre].esquema.optional()]),
    ) as { [K in NombreCampo]: z.ZodOptional<(typeof CAMPOS)[K]["esquema"]> },
  )
  .strict();

export type CandidatoExtraccion = {
  [K in NombreCampo]?: z.infer<(typeof CAMPOS)[K]["esquema"]>;
};

/**
 * NIVEL 2 — Peticion completa.
 *
 * Todo obligatorio. Es la unica forma de dato que puede cruzar hacia el proveedor
 * externo: si un objeto es de este tipo, el guardrail ya se cumplio.
 */
export const EsquemaPeticionCompleta = z
  .object(
    Object.fromEntries(
      NOMBRES_CAMPOS.map((nombre) => [nombre, CAMPOS[nombre].esquema]),
    ) as { [K in NombreCampo]: (typeof CAMPOS)[K]["esquema"] },
  )
  .strict();

export type PeticionCompleta = {
  [K in NombreCampo]: z.infer<(typeof CAMPOS)[K]["esquema"]>;
};

// --- Entrada del webhook ----------------------------------------------------------

export const EsquemaPeticionEntrante = z.object({
  user_id: z.string().trim().min(1).max(120),
  channel: z.string().trim().min(1).max(60),
  message_text: z.string().trim().min(1).max(4000),
});

export type PeticionEntrante = z.infer<typeof EsquemaPeticionEntrante>;

// --- Descripcion de campos para el prompt del LLM ---------------------------------

/** Se deriva del registro: agregar un campo actualiza el prompt solo. */
export function descripcionDeCamposParaPrompt(): string {
  return NOMBRES_CAMPOS.map((nombre) => {
    const campo = CAMPOS[nombre];
    const marca = campo.obligatorio ? "obligatorio" : "opcional";
    return `- ${nombre} (${marca}): ${campo.descripcion}`;
  }).join("\n");
}

/**
 * JSON Schema para la salida forzada del LLM (`format` en Ollama, `responseSchema` en
 * Gemini). Tambien se deriva del registro.
 *
 * DECISION IMPORTANTE: aqui NINGUN campo va en `required`, ni siquiera los que el
 * negocio considera obligatorios.
 *
 * Forzar al modelo a emitir `destination` cuando el mensaje no menciona un destino no
 * consigue el destino: consigue que se lo invente, porque la decodificacion restringida
 * le prohibe omitirlo. La obligatoriedad es una regla de NEGOCIO y la aplica el
 * guardrail determinista despues, con el mensaje completo delante. Al modelo se le pide
 * solamente que no mienta sobre los tipos y que no agregue claves.
 */
export function jsonSchemaDeExtraccion(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const nombre of NOMBRES_CAMPOS) {
    const campo = CAMPOS[nombre];
    const propiedad: Record<string, unknown> = {
      type: campo.tipoJson,
      description: campo.descripcion,
    };
    if ("enumJson" in campo && campo.enumJson) {
      propiedad["enum"] = [...campo.enumJson];
    }
    properties[nombre] = propiedad;
  }
  return { type: "object", properties, additionalProperties: false };
}

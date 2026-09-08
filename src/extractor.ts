/**
 * EL GUARDRAIL. Aqui el LLM deja de mandar.
 *
 * Principio operativo: ningun modelo se autocertifica. El adaptador entrega JSON crudo;
 * este modulo decide, con codigo deterministico, si hay materia suficiente para llamar
 * al proveedor externo. La suficiencia es una regla de negocio y no se delega al modelo.
 *
 * Tres decisiones de diseno que vale la pena defender:
 *
 * 1. VALIDACION CAMPO A CAMPO, no del objeto entero. Si el modelo devuelve
 *    `weight_kg: "mucho"`, eso invalida ESE campo, no la extraccion completa. El campo
 *    pasa a tratarse como ausente y el usuario recibe una pregunta concreta, en vez de
 *    un error generico por una sola celda mal puesta.
 *
 * 2. AUSENCIA NO ES `null`. Una clave omitida significa "el mensaje no lo decia". Un
 *    `null` seria el modelo afirmando un vacio. Se tratan igual de cara al usuario, pero
 *    el `null` se anota como anomalia del modelo porque el esquema lo prohibe.
 *
 * 3. LOS DEFAULTS SE DECLARAN, NO SE SUSURRAN. `package_count` tiene default 1 porque el
 *    caso de exito del enunciado lo espera a partir de un mensaje que no menciona
 *    paquetes. Rellenarlo en silencio violaria "sin supuestos silenciosos"; devolver
 *    NEEDS_INFO contradiria el ejemplo canonico. La salida es hacerlo VISIBLE: el valor
 *    se aplica y se anuncia en `assumptions[]` del contrato de salida. Un supuesto
 *    declarado y auditable no es un supuesto silencioso.
 */
import {
  CAMPOS,
  CAMPOS_OBLIGATORIOS,
  NOMBRES_CAMPOS,
  type CandidatoExtraccion,
  type NombreCampo,
  type PeticionCompleta,
} from "./schema.ts";
import type { ExtractorLlm } from "./llm/index.ts";

export interface SupuestoDeclarado {
  campo: NombreCampo;
  valor: unknown;
  motivo: string;
}

export interface AnomaliaModelo {
  campo: string;
  problema: string;
}

export type ResultadoExtraccion =
  | {
      estado: "completo";
      peticion: PeticionCompleta;
      supuestos: SupuestoDeclarado[];
      anomalias: AnomaliaModelo[];
    }
  | {
      estado: "incompleto";
      faltantes: NombreCampo[];
      mensaje: string;
      parcial: CandidatoExtraccion;
      anomalias: AnomaliaModelo[];
    };

/** "la ciudad de destino" + "el peso" -> "Para continuar necesito la ciudad de destino y el peso." */
export function mensajeDeFaltantes(faltantes: NombreCampo[]): string {
  const frases = faltantes.map((nombre) => CAMPOS[nombre].faltante);
  if (frases.length === 0) return "Para continuar necesito algunos datos mas.";
  if (frases.length === 1) return `Para continuar necesito ${frases[0]}.`;
  const ultima = frases[frases.length - 1];
  return `Para continuar necesito ${frases.slice(0, -1).join(", ")} y ${ultima}.`;
}

/**
 * Convierte la salida cruda del modelo en un candidato validado.
 * No decide si esta completo: solo separa lo valido de lo que no lo es.
 */
export function validarCandidato(crudo: unknown): {
  candidato: CandidatoExtraccion;
  anomalias: AnomaliaModelo[];
} {
  const anomalias: AnomaliaModelo[] = [];

  if (crudo === null || typeof crudo !== "object" || Array.isArray(crudo)) {
    anomalias.push({
      campo: "(raiz)",
      problema: `se esperaba un objeto JSON y llego ${Array.isArray(crudo) ? "un arreglo" : typeof crudo}`,
    });
    return { candidato: {}, anomalias };
  }

  const entrada = crudo as Record<string, unknown>;
  const candidato: Record<string, unknown> = {};

  for (const nombre of NOMBRES_CAMPOS) {
    if (!(nombre in entrada)) continue;

    const valor = entrada[nombre];

    // El esquema prohibe `null`: ausencia se expresa omitiendo la clave.
    if (valor === null) {
      anomalias.push({ campo: nombre, problema: "llego null; se trata como ausente" });
      continue;
    }
    if (typeof valor === "string" && valor.trim() === "") {
      anomalias.push({ campo: nombre, problema: "llego cadena vacia; se trata como ausente" });
      continue;
    }

    const analizado = CAMPOS[nombre].esquema.safeParse(valor);
    if (analizado.success) {
      candidato[nombre] = analizado.data;
    } else {
      anomalias.push({
        campo: nombre,
        problema: `valor invalido (${analizado.error.issues[0]?.message ?? "no valido"}); se trata como ausente`,
      });
    }
  }

  // Claves que el modelo invento. Con decodificacion restringida no deberian aparecer;
  // si aparecen, se ignoran y se dejan anotadas.
  for (const clave of Object.keys(entrada)) {
    if (!(NOMBRES_CAMPOS as string[]).includes(clave)) {
      anomalias.push({ campo: clave, problema: "clave no declarada en el esquema; ignorada" });
    }
  }

  return { candidato: candidato as CandidatoExtraccion, anomalias };
}

/** Aplica los defaults DECLARADOS y devuelve cuales se aplicaron, para anunciarlos. */
export function aplicarDefaultsDeclarados(candidato: CandidatoExtraccion): {
  conDefaults: CandidatoExtraccion;
  supuestos: SupuestoDeclarado[];
} {
  const conDefaults: Record<string, unknown> = { ...candidato };
  const supuestos: SupuestoDeclarado[] = [];

  for (const nombre of NOMBRES_CAMPOS) {
    const campo = CAMPOS[nombre];
    const yaVino = conDefaults[nombre] !== undefined;
    if (yaVino) continue;
    if (campo.obligatorio) continue;
    if (!("valorPorDefecto" in campo) || campo.valorPorDefecto === undefined) continue;

    conDefaults[nombre] = campo.valorPorDefecto;
    supuestos.push({
      campo: nombre,
      valor: campo.valorPorDefecto,
      motivo: "el mensaje no lo especifica; se aplica el valor por defecto declarado del contrato",
    });
  }

  return { conDefaults: conDefaults as CandidatoExtraccion, supuestos };
}

export interface DependenciasExtraccion {
  extractor: ExtractorLlm;
  timeoutMs: number;
}

/**
 * Pipeline completo de la Fase 2.
 *
 * Si el LLM se cae o tarda de mas, NO se inventa una extraccion: se degrada a
 * "incompleto" pidiendo los campos obligatorios. Preguntarle al usuario es siempre
 * preferible a cotizar sobre datos que nadie confirmo.
 */
export async function extraerPeticion(
  mensaje: string,
  dependencias: DependenciasExtraccion,
): Promise<ResultadoExtraccion> {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), dependencias.timeoutMs);

  let crudo: unknown;
  const anomaliasPrevias: AnomaliaModelo[] = [];
  try {
    crudo = await dependencias.extractor.extraer(mensaje, controlador.signal);
  } catch (error) {
    anomaliasPrevias.push({
      campo: "(extractor)",
      problema: `el proveedor de LLM fallo: ${error instanceof Error ? error.message : String(error)}`,
    });
    crudo = {};
  } finally {
    clearTimeout(temporizador);
  }

  const { candidato, anomalias } = validarCandidato(crudo);
  const todasLasAnomalias = [...anomaliasPrevias, ...anomalias];

  const faltantes = CAMPOS_OBLIGATORIOS.filter((nombre) => candidato[nombre] === undefined);
  if (faltantes.length > 0) {
    return {
      estado: "incompleto",
      faltantes,
      mensaje: mensajeDeFaltantes(faltantes),
      parcial: candidato,
      anomalias: todasLasAnomalias,
    };
  }

  const { conDefaults, supuestos } = aplicarDefaultsDeclarados(candidato);

  return {
    estado: "completo",
    // Seguro: acabamos de comprobar que ningun obligatorio falta y los opcionales
    // con default ya se rellenaron.
    peticion: conDefaults as PeticionCompleta,
    supuestos,
    anomalias: todasLasAnomalias,
  };
}

/**
 * Comparador de modelos locales para la tarea de extraccion.
 *
 * POR QUE EXISTE: elegir el modelo es una decision de arquitectura, no un detalle de
 * instalacion. Este script la convierte en una medicion repetible en vez de una opinion.
 * Usa EL MISMO adaptador que produccion, asi que lo que mide es lo que se entrega.
 *
 *   npx tsx scripts/comparar-modelos.ts llama3.2:3b qwen2.5:3b
 *
 * El criterio de acierto no es "se parece": es campo a campo, y OMITIR un campo ausente
 * cuenta como acierto. Un modelo que rellena todo saca peor nota que uno que calla.
 */
import { writeFileSync } from "node:fs";

import { crearExtractorOllama } from "../src/llm/ollama.ts";
import { validarCandidato } from "../src/extractor.ts";
import type { NombreCampo } from "../src/schema.ts";

interface Caso {
  nombre: string;
  mensaje: string;
  /** `undefined` significa: el campo DEBE quedar ausente. */
  esperado: Partial<Record<NombreCampo, unknown>>;
  ausentes: NombreCampo[];
}

const CASOS: Caso[] = [
  {
    nombre: "canonico del enunciado",
    mensaje: "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés",
    esperado: {
      origin: "Ciudad de México",
      destination: "Monterrey",
      weight_kg: 8,
      service_type: "express",
    },
    ausentes: ["package_count"],
  },
  {
    nombre: "sin destino (debe quedar incompleto)",
    mensaje: "Necesito enviar 8 kg desde Ciudad de México por servicio exprés",
    esperado: { origin: "Ciudad de México", weight_kg: 8, service_type: "express" },
    ausentes: ["destination", "package_count"],
  },
  {
    nombre: "con bultos explicitos",
    mensaje: "Enviar 3 cajas de 12 kg de Guadalajara a Cancún, servicio económico",
    esperado: {
      origin: "Guadalajara",
      destination: "Cancún",
      weight_kg: 12,
      service_type: "economy",
      package_count: 3,
    },
    ausentes: [],
  },
  {
    nombre: "trampa: peso que parece cantidad",
    mensaje: "Mandar 5 kg a Tijuana urgente",
    esperado: { destination: "Tijuana", weight_kg: 5, service_type: "express" },
    ausentes: ["origin", "package_count"],
  },
];

/** Compara ciudades con tolerancia a acentos y mayusculas, no a inventos. */
function mismaCiudad(a: unknown, b: unknown): boolean {
  const normaliza = (v: unknown): string =>
    String(v)
      .normalize("NFD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .trim();
  return normaliza(a) === normaliza(b);
}

interface Resultado {
  modelo: string;
  aciertos: number;
  total: number;
  ms: number;
  detalle: string[];
}

async function evaluar(modelo: string): Promise<Resultado> {
  const extractor = crearExtractorOllama({
    provider: "ollama",
    timeoutMs: 120000,
    ollamaBaseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434",
    ollamaModel: modelo,
    geminiApiKey: undefined,
    geminiModel: "",
  });

  let aciertos = 0;
  let total = 0;
  const detalle: string[] = [];
  const inicio = Date.now();

  for (const caso of CASOS) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), 120000);
    let candidato: Record<string, unknown> = {};
    let fallo: string | null = null;
    try {
      const crudo = await extractor.extraer(caso.mensaje, controlador.signal);
      candidato = validarCandidato(crudo).candidato as Record<string, unknown>;
    } catch (error) {
      fallo = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(temporizador);
    }

    const lineas: string[] = [`  ${caso.nombre}`];
    if (fallo) {
      lineas.push(`    ERROR: ${fallo.slice(0, 120)}`);
      total += Object.keys(caso.esperado).length + caso.ausentes.length;
      detalle.push(...lineas);
      continue;
    }

    for (const [campo, valorEsperado] of Object.entries(caso.esperado)) {
      total += 1;
      const obtenido = candidato[campo];
      const bien =
        typeof valorEsperado === "string"
          ? mismaCiudad(obtenido, valorEsperado)
          : obtenido === valorEsperado;
      if (bien) aciertos += 1;
      else lineas.push(`    x ${campo}: esperaba ${JSON.stringify(valorEsperado)}, dio ${JSON.stringify(obtenido)}`);
    }
    for (const campo of caso.ausentes) {
      total += 1;
      if (candidato[campo] === undefined) aciertos += 1;
      else lineas.push(`    x ${campo}: debia OMITIRSE y dio ${JSON.stringify(candidato[campo])}`);
    }
    if (lineas.length === 1) lineas.push("    todo correcto");
    detalle.push(...lineas);
  }

  return { modelo, aciertos, total, ms: Date.now() - inicio, detalle };
}

async function principal(): Promise<void> {
  const modelos = process.argv.slice(2);
  if (modelos.length === 0) {
    console.error("uso: npx tsx scripts/comparar-modelos.ts <modelo> [<modelo>...]");
    process.exit(1);
  }

  const resultados: Resultado[] = [];
  for (const modelo of modelos) {
    console.log(`\n--- ${modelo} ---`);
    const resultado = await evaluar(modelo);
    resultado.detalle.forEach((linea) => console.log(linea));
    console.log(`  => ${resultado.aciertos}/${resultado.total} campos, ${(resultado.ms / 1000).toFixed(1)}s`);
    resultados.push(resultado);
  }

  resultados.sort((a, b) => b.aciertos / b.total - a.aciertos / a.total);

  const md = [
    "# Eleccion de modelo local — medicion, no opinion",
    "",
    "Generado por `npx tsx scripts/comparar-modelos.ts`. Cuatro mensajes, campo a campo.",
    "**Omitir un campo ausente cuenta como acierto**: rellenar de mas es el fallo que este",
    "sistema existe para impedir.",
    "",
    "| modelo | aciertos | % | tiempo |",
    "|---|---|---|---|",
    ...resultados.map(
      (r) =>
        `| \`${r.modelo}\` | ${r.aciertos}/${r.total} | ${((r.aciertos / r.total) * 100).toFixed(0)}% | ${(r.ms / 1000).toFixed(1)}s |`,
    ),
    "",
    "## Detalle",
    "",
    ...resultados.flatMap((r) => [`### \`${r.modelo}\``, "", "```", ...r.detalle, "```", ""]),
  ].join("\n");

  writeFileSync("evidencia/modelos.md", md, "utf8");
  console.log("\nescrito: evidencia/modelos.md");
}

void principal();

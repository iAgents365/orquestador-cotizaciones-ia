import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  aplicarDefaultsDeclarados,
  extraerPeticion,
  mensajeDeFaltantes,
  validarCandidato,
} from "../src/extractor.ts";
import { pareceMarcadorDeAusencia } from "../src/schema.ts";
import type { ExtractorLlm } from "../src/llm/index.ts";
import { crearExtractorMock } from "../src/llm/mock.ts";

/** Extractor de mentira: devuelve exactamente lo que le pasemos. */
function extractorFijo(salida: unknown): ExtractorLlm {
  return { nombre: "mock", detalle: "mock:fijo", extraer: async () => salida };
}

describe("validarCandidato: el modelo propone, el codigo dispone", () => {
  test("acepta lo valido y normaliza el tipo de servicio", () => {
    const { candidato } = validarCandidato({
      origin: "Ciudad de México",
      destination: "Monterrey",
      weight_kg: 8,
      service_type: "exprés",
    });
    assert.equal(candidato.service_type, "express");
    assert.equal(candidato.weight_kg, 8);
  });

  test("acepta numeros que llegan como texto", () => {
    const { candidato } = validarCandidato({ weight_kg: "8.5", package_count: "3" });
    assert.equal(candidato.weight_kg, 8.5);
    assert.equal(candidato.package_count, 3);
  });

  test("null se trata como ausente y se anota como anomalia", () => {
    const { candidato, anomalias } = validarCandidato({ destination: null });
    assert.equal(candidato.destination, undefined);
    assert.ok(anomalias.some((a) => a.campo === "destination"));
  });

  test("un campo con tipo malo NO tumba la extraccion entera", () => {
    const { candidato, anomalias } = validarCandidato({
      origin: "Puebla",
      weight_kg: "muchisimo",
    });
    assert.equal(candidato.origin, "Puebla", "el campo bueno debe sobrevivir");
    assert.equal(candidato.weight_kg, undefined);
    assert.equal(anomalias.length, 1);
  });

  test("una clave inventada se ignora y queda anotada", () => {
    const { candidato, anomalias } = validarCandidato({ origin: "Puebla", color: "rojo" });
    assert.equal((candidato as Record<string, unknown>)["color"], undefined);
    assert.ok(anomalias.some((a) => a.campo === "color"));
  });

  test("una raiz que no es objeto no revienta", () => {
    const { candidato, anomalias } = validarCandidato("esto no es un objeto");
    assert.deepEqual(candidato, {});
    assert.equal(anomalias[0]?.campo, "(raiz)");
  });
});

describe("marcadores de ausencia (fallo real medido con llama3.2:3b)", () => {
  test('"(omitiendo este dato)" NO es una ciudad valida', () => {
    const { candidato, anomalias } = validarCandidato({
      origin: "Ciudad de México",
      destination: "(omitiendo este dato)",
    });
    assert.equal(
      candidato.destination,
      undefined,
      "el modelo confeso una ausencia dentro del valor: eso no es un destino",
    );
    assert.ok(anomalias.some((a) => a.campo === "destination"));
  });

  test("reconoce las formas habituales de decir 'no se'", () => {
    for (const valor of [
      "(omitiendo este dato)",
      "[sin dato]",
      "N/A",
      "n/a",
      "desconocido",
      "no especificado",
      "sin especificar",
      "null",
      "unknown",
      "???",
      "---",
      "por definir",
    ]) {
      assert.ok(pareceMarcadorDeAusencia(valor), `deberia detectar: ${valor}`);
    }
  });

  test("no confunde ciudades reales con marcadores", () => {
    for (const ciudad of [
      "Ciudad de México",
      "Monterrey",
      "San Luis Potosí",
      "Naucalpan",
      "León",
      "Mérida",
      "Nuevo Laredo",
    ]) {
      assert.equal(pareceMarcadorDeAusencia(ciudad), false, `falso positivo con: ${ciudad}`);
    }
  });
});

describe("defaults declarados, nunca silenciosos", () => {
  test("package_count ausente toma 1 Y lo declara", () => {
    const { conDefaults, supuestos } = aplicarDefaultsDeclarados({
      origin: "A",
      destination: "B",
      weight_kg: 1,
      service_type: "express",
    });
    assert.equal(conDefaults.package_count, 1);
    assert.equal(supuestos.length, 1);
    assert.equal(supuestos[0]?.campo, "package_count");
  });

  test("si el usuario SI dijo la cantidad, no se declara ningun supuesto", () => {
    const { conDefaults, supuestos } = aplicarDefaultsDeclarados({
      origin: "A",
      destination: "B",
      weight_kg: 1,
      service_type: "express",
      package_count: 4,
    });
    assert.equal(conDefaults.package_count, 4);
    assert.deepEqual(supuestos, []);
  });

  test("los campos OBLIGATORIOS jamas reciben default", () => {
    const { conDefaults } = aplicarDefaultsDeclarados({ origin: "A" });
    assert.equal(conDefaults.destination, undefined);
    assert.equal(conDefaults.weight_kg, undefined);
    assert.equal(conDefaults.service_type, undefined);
  });
});

describe("mensajes de NEEDS_INFO", () => {
  test("uno solo", () => {
    assert.equal(mensajeDeFaltantes(["destination"]), "Para continuar necesito la ciudad de destino.");
  });
  test("varios se enumeran con 'y' final", () => {
    assert.equal(
      mensajeDeFaltantes(["destination", "weight_kg"]),
      "Para continuar necesito la ciudad de destino y el peso en kilogramos.",
    );
  });
});

describe("extraerPeticion de punta a punta", () => {
  const deps = (extractor: ExtractorLlm) => ({ extractor, timeoutMs: 2000 });

  test("mensaje canonico del enunciado queda COMPLETO", async () => {
    const resultado = await extraerPeticion(
      "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés",
      deps(crearExtractorMock()),
    );
    assert.equal(resultado.estado, "completo");
    if (resultado.estado !== "completo") return;
    assert.equal(resultado.peticion.origin, "Ciudad de México");
    assert.equal(resultado.peticion.destination, "Monterrey");
    assert.equal(resultado.peticion.weight_kg, 8);
    assert.equal(resultado.peticion.service_type, "express");
    assert.equal(resultado.peticion.package_count, 1);
    assert.equal(resultado.supuestos.length, 1, "el default de package_count debe declararse");
  });

  test("sin destino se detiene ANTES del proveedor", async () => {
    const resultado = await extraerPeticion(
      "Necesito enviar 8 kg por servicio exprés",
      deps(crearExtractorMock()),
    );
    assert.equal(resultado.estado, "incompleto");
    if (resultado.estado !== "incompleto") return;
    assert.ok(resultado.faltantes.includes("destination"));
  });

  test("si el LLM se cae, se pregunta al usuario en vez de inventar", async () => {
    const roto: ExtractorLlm = {
      nombre: "mock",
      detalle: "mock:roto",
      extraer: async () => {
        throw new Error("proveedor de LLM caido");
      },
    };
    const resultado = await extraerPeticion("lo que sea", deps(roto));
    assert.equal(resultado.estado, "incompleto");
    if (resultado.estado !== "incompleto") return;
    assert.equal(resultado.faltantes.length, 4, "los cuatro obligatorios quedan pendientes");
    assert.ok(resultado.anomalias.some((a) => a.campo === "(extractor)"));
  });

  test("un modelo que alucina un destino-marcador no consigue cotizar", async () => {
    const alucinado = extractorFijo({
      origin: "Ciudad de México",
      destination: "(omitiendo este dato)",
      weight_kg: 8,
      service_type: "express",
    });
    const resultado = await extraerPeticion("da igual", deps(alucinado));
    assert.equal(resultado.estado, "incompleto");
  });
});

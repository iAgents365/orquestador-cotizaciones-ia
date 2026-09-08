import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { cargarConfig } from "../src/config.ts";
import { construirServidor } from "../src/server.ts";

/** Levanta el servidor en un puerto efimero y devuelve una funcion para llamarlo. */
async function conServidor(entorno: Record<string, string>) {
  const config = cargarConfig({
    ...process.env,
    LOG_LEVEL: "silent",
    CARRIER_SEED: "prueba-fija",
    ...entorno,
  });
  const app = construirServidor({ ...config, host: "127.0.0.1" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const direccion = app.server.address();
  if (typeof direccion === "string" || direccion === null) throw new Error("sin puerto");
  const base = `http://127.0.0.1:${direccion.port}`;

  return {
    base,
    async cotizar(mensaje: string, cabeceras: Record<string, string> = {}) {
      const respuesta = await fetch(`${base}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...cabeceras },
        body: JSON.stringify({
          user_id: "candidate-001",
          channel: "webchat",
          message_text: mensaje,
        }),
      });
      return { http: respuesta.status, cuerpo: (await respuesta.json()) as Record<string, unknown> };
    },
    cerrar: () => app.close(),
  };
}

const CANONICO = "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés";

describe("los tres escenarios exigidos", () => {
  test("1. exito: QUOTED con la respuesta del carrier normalizada", async () => {
    const servidor = await conServidor({ CARRIER_FAILURE_RATE: "0" });
    try {
      const { http, cuerpo } = await servidor.cotizar(CANONICO);
      assert.equal(http, 200);
      assert.equal(cuerpo["status"], "QUOTED");

      const quote = cuerpo["quote"] as Record<string, unknown>;
      assert.equal(quote["origin"], "Ciudad de México");
      assert.equal(quote["destination"], "Monterrey");
      assert.equal(quote["weight_kg"], 8);
      assert.equal(quote["service_type"], "express");
      assert.equal(quote["package_count"], 1);
      assert.equal(quote["currency"], "MXN", "normalizado: el carrier manda 'mxn'");
      assert.equal(quote["provider"], "mock-carrier");
      assert.equal(typeof quote["amount"], "number", "normalizado: el carrier manda '560.00'");

      // El default aplicado se ANUNCIA. Ese es el contrato contra los supuestos silenciosos.
      const supuestos = cuerpo["assumptions"] as Array<Record<string, unknown>>;
      assert.equal(supuestos.length, 1);
      assert.equal(supuestos[0]?.["field"], "package_count");
    } finally {
      await servidor.cerrar();
    }
  });

  test("2. incompleto: NEEDS_INFO y CERO llamadas al proveedor", async () => {
    const servidor = await conServidor({ CARRIER_FAILURE_RATE: "0" });
    try {
      const { http, cuerpo } = await servidor.cotizar(
        "Necesito enviar 8 kg desde Ciudad de México por servicio exprés",
      );
      assert.equal(http, 200);
      assert.equal(cuerpo["status"], "NEEDS_INFO");
      assert.deepEqual(cuerpo["missing_fields"], ["destination"]);

      const meta = cuerpo["meta"] as Record<string, unknown>;
      assert.equal(
        meta["provider_attempts"],
        0,
        "el guardrail debe cortar ANTES de gastar una llamada al carrier",
      );
    } finally {
      await servidor.cerrar();
    }
  });

  test("3. caida: PROVIDER_UNAVAILABLE, 503 estructurado y sin filtrar el error interno", async () => {
    const servidor = await conServidor({
      CARRIER_FAILURE_RATE: "1",
      CARRIER_MIN_LATENCY_MS: "10",
      CARRIER_MAX_LATENCY_MS: "40",
      PROVIDER_BACKOFF_BASE_MS: "10",
      PROVIDER_BACKOFF_CAP_MS: "40",
    });
    try {
      const { http, cuerpo } = await servidor.cotizar(CANONICO);
      assert.equal(http, 503);
      assert.equal(cuerpo["status"], "PROVIDER_UNAVAILABLE");

      const meta = cuerpo["meta"] as Record<string, unknown>;
      assert.equal(meta["provider_attempts"], 3, "debe haber agotado los 3 intentos");

      // Nada de fontaneria hacia afuera.
      const texto = JSON.stringify(cuerpo);
      for (const filtracion of ["stack", "504", "429", "ErrorProveedor", "at Object"]) {
        assert.ok(!texto.includes(filtracion), `la respuesta filtra "${filtracion}"`);
      }
    } finally {
      await servidor.cerrar();
    }
  });
});

describe("contrato de entrada y bordes", () => {
  test("un cuerpo invalido da 400 con los campos que fallaron", async () => {
    const servidor = await conServidor({});
    try {
      const respuesta = await fetch(`${servidor.base}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "x" }),
      });
      const cuerpo = (await respuesta.json()) as Record<string, unknown>;
      assert.equal(respuesta.status, 400);
      assert.equal(cuerpo["status"], "BAD_REQUEST");
      assert.ok(Array.isArray(cuerpo["errors"]));
    } finally {
      await servidor.cerrar();
    }
  });

  test("un JSON roto da 400, NO un falso PROVIDER_UNAVAILABLE", async () => {
    // Regresion: el manejador generico devolvia 503 para CUALQUIER excepcion, asi que un
    // cuerpo mal formado salia como "el proveedor no esta disponible" y mandaba a quien
    // integra a perseguir una caida inexistente.
    const servidor = await conServidor({});
    try {
      const respuesta = await fetch(`${servidor.base}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"user_id": roto}',
      });
      const cuerpo = (await respuesta.json()) as Record<string, unknown>;
      assert.equal(respuesta.status, 400);
      assert.equal(cuerpo["status"], "BAD_REQUEST");
      assert.notEqual(
        cuerpo["status"],
        "PROVIDER_UNAVAILABLE",
        "la culpa es del cliente: no se disfraza de caida del proveedor",
      );
    } finally {
      await servidor.cerrar();
    }
  });

  test("Idempotency-Key: dos envios devuelven la MISMA cotizacion, no dos", async () => {
    const servidor = await conServidor({ CARRIER_FAILURE_RATE: "0" });
    try {
      const clave = "clic-doble-del-usuario";
      const [primera, segunda] = await Promise.all([
        servidor.cotizar(CANONICO, { "Idempotency-Key": clave }),
        servidor.cotizar(CANONICO, { "Idempotency-Key": clave }),
      ]);

      assert.equal(primera.cuerpo["status"], "QUOTED");
      assert.equal(segunda.cuerpo["status"], "QUOTED");

      const refA = (primera.cuerpo["quote"] as Record<string, unknown>)["quote_reference"];
      const refB = (segunda.cuerpo["quote"] as Record<string, unknown>)["quote_reference"];
      assert.equal(refA, refB, "dos clics simultaneos no pueden producir dos cotizaciones");
    } finally {
      await servidor.cerrar();
    }
  });

  test("sin Idempotency-Key, cada peticion es independiente", async () => {
    const servidor = await conServidor({ CARRIER_FAILURE_RATE: "0" });
    try {
      const primera = await servidor.cotizar(CANONICO);
      const segunda = await servidor.cotizar(CANONICO);
      const refA = (primera.cuerpo["quote"] as Record<string, unknown>)["quote_reference"];
      const refB = (segunda.cuerpo["quote"] as Record<string, unknown>)["quote_reference"];
      assert.notEqual(refA, refB);
    } finally {
      await servidor.cerrar();
    }
  });
});

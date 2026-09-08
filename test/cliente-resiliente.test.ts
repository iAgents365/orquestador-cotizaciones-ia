import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ErrorAgotado,
  ErrorProveedor,
  ejecutarConReintentos,
  esperaConFullJitter,
  esReintentable,
  leerRetryAfter,
  reintentablePorStatus,
} from "../src/provider/cliente-resiliente.ts";
import type { PoliticaReintentos } from "../src/config.ts";

const POLITICA: PoliticaReintentos = {
  maxAttempts: 3,
  timeoutMs: 1000,
  totalBudgetMs: 10000,
  backoffBaseMs: 100,
  backoffCapMs: 2000,
};

/** Reloj y espera falsos: las pruebas no esperan de verdad, pero el tiempo SI avanza. */
function relojFalso(inicio = 0) {
  let ahora = inicio;
  return {
    ahora: () => ahora,
    avanzar: (ms: number) => {
      ahora += ms;
    },
    dormir: async (ms: number) => {
      ahora += ms;
    },
  };
}

describe("clasificacion de errores", () => {
  test("5xx, 408, 425 y 429 se reintentan; el resto de 4xx no", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(reintentablePorStatus(status), true, `${status} deberia reintentarse`);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(reintentablePorStatus(status), false, `${status} NO deberia reintentarse`);
    }
  });

  test("un abort (timeout) se considera reintentable", () => {
    const error = Object.assign(new Error("cancelado"), { name: "AbortError" });
    assert.equal(esReintentable(error), true);
  });

  test("un error de negocio sin marca no se reintenta", () => {
    assert.equal(esReintentable(new Error("cualquier cosa")), false);
  });
});

describe("Retry-After", () => {
  test("acepta segundos", () => {
    assert.equal(leerRetryAfter("3"), 3000);
  });

  test("acepta fecha HTTP y nunca devuelve negativo", () => {
    const ahora = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(leerRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", ahora), 5000);
    assert.equal(leerRetryAfter("Thu, 01 Jan 2025 00:00:00 GMT", ahora), 0);
  });

  test("una cabecera basura no rompe: devuelve undefined y manda el backoff propio", () => {
    assert.equal(leerRetryAfter("pronto"), undefined);
    assert.equal(leerRetryAfter(null), undefined);
  });
});

describe("full jitter", () => {
  test("la espera nunca supera min(cap, base * 2^intento)", () => {
    for (let intento = 0; intento < 8; intento += 1) {
      const techo = Math.min(POLITICA.backoffCapMs, POLITICA.backoffBaseMs * 2 ** intento);
      // azar()=0.999... es el peor caso posible.
      const espera = esperaConFullJitter(intento, POLITICA, () => 0.9999999);
      assert.ok(espera < techo || techo === 0, `intento ${intento}: ${espera} >= ${techo}`);
    }
  });

  test("con azar()=0 la espera es cero: full jitter reparte desde 0, no desde el techo", () => {
    assert.equal(esperaConFullJitter(3, POLITICA, () => 0), 0);
  });

  test("el techo respeta el cap y no crece indefinidamente", () => {
    const espera = esperaConFullJitter(20, POLITICA, () => 0.5);
    assert.ok(espera <= POLITICA.backoffCapMs);
  });
});

describe("politica de reintentos", () => {
  test("exito al primer intento: no hay espera ni fallos", async () => {
    const resultado = await ejecutarConReintentos(async () => "ok", POLITICA, relojFalso());
    assert.equal(resultado.valor, "ok");
    assert.equal(resultado.intentos, 1);
    assert.deepEqual(resultado.fallos, []);
  });

  test("maxAttempts son llamadas TOTALES, no reintentos adicionales", async () => {
    let llamadas = 0;
    const reloj = relojFalso();
    await assert.rejects(
      ejecutarConReintentos(
        async () => {
          llamadas += 1;
          throw new ErrorProveedor("504", { status: 504, reintentable: true });
        },
        POLITICA,
        { ...reloj, azar: () => 0.5 },
      ),
      (error: unknown) => error instanceof ErrorAgotado && error.motivo === "intentos",
    );
    assert.equal(llamadas, 3, "con maxAttempts=3 deben ser 3 llamadas, no 4");
  });

  test("maxAttempts=1 no reintenta nunca (el live-tweak extremo no rompe nada)", async () => {
    let llamadas = 0;
    await assert.rejects(
      ejecutarConReintentos(
        async () => {
          llamadas += 1;
          throw new ErrorProveedor("503", { status: 503, reintentable: true });
        },
        { ...POLITICA, maxAttempts: 1 },
        relojFalso(),
      ),
      ErrorAgotado,
    );
    assert.equal(llamadas, 1);
  });

  test("un error NO reintentable corta en el primer intento", async () => {
    let llamadas = 0;
    await assert.rejects(
      ejecutarConReintentos(
        async () => {
          llamadas += 1;
          throw new ErrorProveedor("422", { status: 422, reintentable: false });
        },
        POLITICA,
        relojFalso(),
      ),
      (error: unknown) => error instanceof ErrorAgotado && error.motivo === "no-reintentable",
    );
    assert.equal(llamadas, 1, "un 422 repetido daria 422: no se gasta latencia del usuario");
  });

  test("recupera si un intento intermedio tiene exito", async () => {
    let llamadas = 0;
    const resultado = await ejecutarConReintentos(
      async () => {
        llamadas += 1;
        if (llamadas < 3) throw new ErrorProveedor("504", { status: 504, reintentable: true });
        return "recuperado";
      },
      POLITICA,
      { ...relojFalso(), azar: () => 0.5 },
    );
    assert.equal(resultado.valor, "recuperado");
    assert.equal(resultado.intentos, 3);
    assert.equal(resultado.fallos.length, 2);
  });

  test("el presupuesto total corta aunque queden intentos disponibles", async () => {
    const reloj = relojFalso();
    let llamadas = 0;
    await assert.rejects(
      ejecutarConReintentos(
        async () => {
          llamadas += 1;
          reloj.avanzar(4000); // cada intento consume casi todo el presupuesto
          throw new ErrorProveedor("504", { status: 504, reintentable: true });
        },
        { ...POLITICA, maxAttempts: 5, totalBudgetMs: 5000 },
        { ...reloj, azar: () => 0.5 },
      ),
      (error: unknown) => error instanceof ErrorAgotado && error.motivo === "presupuesto",
    );
    assert.ok(llamadas < 5, `el presupuesto debio cortar antes de 5 intentos, hubo ${llamadas}`);
  });

  test("Retry-After del proveedor manda sobre el backoff calculado", async () => {
    const reloj = relojFalso();
    const esperas: number[] = [];
    let llamadas = 0;
    await ejecutarConReintentos(
      async () => {
        llamadas += 1;
        if (llamadas === 1) {
          throw new ErrorProveedor("429", {
            status: 429,
            reintentable: true,
            retryAfterMs: 1500,
          });
        }
        return "ok";
      },
      POLITICA,
      {
        ahora: reloj.ahora,
        // azar() = 0 daria espera 0 si mandara el jitter; si espera 1500, mando Retry-After.
        azar: () => 0,
        dormir: async (ms: number) => {
          esperas.push(ms);
          reloj.avanzar(ms);
        },
      },
    );
    assert.deepEqual(esperas, [1500]);
  });
});

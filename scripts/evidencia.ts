/**
 * Genera la evidencia de los TRES escenarios exigidos, ejecutandolos de verdad contra el
 * servidor por HTTP. No hay salidas escritas a mano.
 *
 *   npm run evidencia
 *
 * Cada escenario levanta el servidor con SU configuracion, porque la diferencia entre el
 * caso feliz y la caida del proveedor es precisamente un parametro de configuracion:
 *
 *   exito      -> CARRIER_FAILURE_RATE=0   (el carrier nunca falla)
 *   incompleto -> da igual: se corta antes de llegar al carrier
 *   caida      -> CARRIER_FAILURE_RATE=1   (el carrier siempre falla)
 *
 * La semilla del carrier se fija para que la secuencia sea reproducible: quien evalue
 * debe poder obtener lo mismo, no una corrida con suerte.
 */
import { writeFileSync } from "node:fs";

import { cargarConfig, type Config } from "../src/config.ts";
import { construirServidor } from "../src/server.ts";

interface Escenario {
  id: string;
  titulo: string;
  descripcion: string;
  cuerpo: { user_id: string; channel: string; message_text: string };
  entorno: Record<string, string>;
  esperado: string;
}

const ESCENARIOS: Escenario[] = [
  {
    id: "1-exito",
    titulo: "Caso exitoso — cotizacion procesada",
    descripcion:
      "Mensaje completo. El guardrail deja pasar, el carrier responde y la respuesta cruda se normaliza al contrato.",
    cuerpo: {
      user_id: "candidate-001",
      channel: "webchat",
      message_text:
        "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés",
    },
    entorno: { CARRIER_FAILURE_RATE: "0", CARRIER_MIN_LATENCY_MS: "1000", CARRIER_MAX_LATENCY_MS: "3000" },
    esperado: "QUOTED",
  },
  {
    id: "2-incompleto",
    titulo: "Informacion incompleta — clarificacion determinista",
    descripcion:
      "Falta la ciudad de destino. El flujo se DETIENE antes de llamar al proveedor: fijate en que `provider_attempts` es 0.",
    cuerpo: {
      user_id: "candidate-001",
      channel: "webchat",
      message_text: "Necesito enviar 8 kg desde Ciudad de México por servicio exprés",
    },
    entorno: { CARRIER_FAILURE_RATE: "0" },
    esperado: "NEEDS_INFO",
  },
  {
    id: "3-caida",
    titulo: "Caida del proveedor externo — degradacion elegante",
    descripcion:
      "El carrier falla el 100% de las veces. Se agotan los 3 intentos con backoff y el usuario recibe un estado accionable, nunca un 500 crudo ni un stack.",
    cuerpo: {
      user_id: "candidate-001",
      channel: "webchat",
      message_text:
        "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés",
    },
    entorno: {
      CARRIER_FAILURE_RATE: "1",
      CARRIER_MIN_LATENCY_MS: "50",
      CARRIER_MAX_LATENCY_MS: "150",
      PROVIDER_TIMEOUT_MS: "1000",
      PROVIDER_TOTAL_BUDGET_MS: "8000",
    },
    esperado: "PROVIDER_UNAVAILABLE",
  },
];

interface Capturado {
  escenario: Escenario;
  httpStatus: number;
  respuesta: unknown;
  ms: number;
}

async function correr(escenario: Escenario): Promise<Capturado> {
  const config: Config = cargarConfig({
    ...process.env,
    ...escenario.entorno,
    CARRIER_SEED: process.env["CARRIER_SEED"] ?? "promass-2026",
  });

  // Puerto efimero para no chocar con un servidor ya levantado. La URL del carrier se
  // resuelve sola tras `listen`, asi que no hace falta conocerla de antemano.
  const app = construirServidor({ ...config, host: "127.0.0.1" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const direccion = app.server.address();
  if (typeof direccion === "string" || direccion === null) {
    throw new Error("no se pudo determinar el puerto efimero");
  }

  const inicio = Date.now();
  try {
    const respuesta = await fetch(`http://127.0.0.1:${direccion.port}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(escenario.cuerpo),
    });
    const cuerpo: unknown = await respuesta.json();
    return { escenario, httpStatus: respuesta.status, respuesta: cuerpo, ms: Date.now() - inicio };
  } finally {
    await app.close();
  }
}

function bloque(valor: unknown): string {
  return "```json\n" + JSON.stringify(valor, null, 2) + "\n```";
}

async function principal(): Promise<void> {
  const capturados: Capturado[] = [];

  for (const escenario of ESCENARIOS) {
    process.stdout.write(`\n=== ${escenario.titulo} ===\n`);
    const capturado = await correr(escenario);
    const obtenido = (capturado.respuesta as { status?: string }).status;
    const ok = obtenido === escenario.esperado;
    console.log(`HTTP ${capturado.httpStatus} · status=${obtenido} · ${capturado.ms} ms · ${ok ? "OK" : "INESPERADO"}`);
    console.log(JSON.stringify(capturado.respuesta, null, 2));
    if (!ok) {
      console.error(`\nFALLO: se esperaba ${escenario.esperado} y se obtuvo ${String(obtenido)}`);
      process.exitCode = 1;
    }
    capturados.push(capturado);
    writeFileSync(
      `evidencia/${capturado.escenario.id}.json`,
      JSON.stringify(
        {
          peticion: capturado.escenario.cuerpo,
          entorno: capturado.escenario.entorno,
          http_status: capturado.httpStatus,
          respuesta: capturado.respuesta,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const md = [
    "# Evidencia de los tres escenarios",
    "",
    "Generada por `npm run evidencia`. Nada aqui esta escrito a mano: cada bloque es la",
    "respuesta real del servidor a una peticion HTTP real.",
    "",
    `Proveedor de LLM: \`${process.env["LLM_PROVIDER"] ?? "mock"}\` · semilla del carrier: \`${process.env["CARRIER_SEED"] ?? "promass-2026"}\``,
    "",
    ...capturados.flatMap((capturado) => [
      `## ${capturado.escenario.titulo}`,
      "",
      capturado.escenario.descripcion,
      "",
      `Configuracion del escenario: \`${Object.entries(capturado.escenario.entorno)
        .map(([clave, valor]) => `${clave}=${valor}`)
        .join(" ")}\``,
      "",
      "**Peticion**",
      "",
      bloque(capturado.escenario.cuerpo),
      "",
      `**Respuesta** — HTTP ${capturado.httpStatus}, ${capturado.ms} ms`,
      "",
      bloque(capturado.respuesta),
      "",
    ]),
  ].join("\n");

  writeFileSync("evidencia/README.md", md, "utf8");
  console.log("\nEscrito: evidencia/README.md y evidencia/*.json");
}

void principal();

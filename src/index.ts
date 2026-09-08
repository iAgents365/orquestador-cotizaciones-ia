/** Punto de entrada. Carga configuracion, levanta el servidor y cierra con orden. */
import { cargarConfig } from "./config.ts";
import { construirServidor } from "./server.ts";

async function principal(): Promise<void> {
  const config = cargarConfig();
  const app = construirServidor(config);

  await app.listen({ port: config.port, host: config.host });

  app.log.info(
    {
      llm: config.llm.provider,
      politica: config.reintentos,
      carrier_failure_rate: config.carrier.failureRate,
    },
    "orquestador de cotizaciones listo",
  );

  for (const señal of ["SIGINT", "SIGTERM"] as const) {
    process.once(señal, () => {
      app.log.info(`${señal} recibida, cerrando`);
      void app.close().then(() => process.exit(0));
    });
  }
}

principal().catch((error: unknown) => {
  // Un fallo de arranque se dice claro y se sale distinto de cero. Arrancar a medias
  // con una configuracion invalida es peor que no arrancar.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

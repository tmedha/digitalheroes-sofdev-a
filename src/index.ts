import { loadConfig } from "./config.js";
import { createServices } from "./services.js";
import { buildServer } from "./server.js";

/**
 * Process entrypoint. Kept separate from `buildServer` so tests can boot the
 * application without binding a port or installing signal handlers.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const app = await buildServer({ config, services });

  // Platform schedulers send SIGTERM and expect the process to stop accepting
  // connections while letting in-flight requests finish.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: "shutdown.start", signal }, "shutting down");

    const forceExit = setTimeout(() => {
      app.log.error({ event: "shutdown.timeout" }, "graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await app.close();
      services.close();
      app.log.info({ event: "shutdown.complete" }, "shutdown complete");
      process.exit(0);
    } catch (error) {
      app.log.error({ event: "shutdown.failed", err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", (signal) => void shutdown(signal));
  process.on("SIGINT", (signal) => void shutdown(signal));

  // A crash with an unhandled rejection should be loud and logged, not silent.
  process.on("unhandledRejection", (reason) => {
    app.log.error({ event: "process.unhandled_rejection", err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (error) => {
    app.log.fatal({ event: "process.uncaught_exception", err: error }, "uncaught exception");
    process.exit(1);
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    {
      event: "server.started",
      port: config.PORT,
      env: config.NODE_ENV,
      cacheTtlMs: config.CACHE_TTL_MS,
      maxConcurrentAudits: config.MAX_CONCURRENT_AUDITS,
      rateLimit: `${config.RATE_LIMIT_MAX}/${config.RATE_LIMIT_WINDOW_MS}ms`,
    },
    "url-audit-service ready",
  );
}

main().catch((error: unknown) => {
  console.error("Failed to start url-audit-service:", error);
  process.exit(1);
});

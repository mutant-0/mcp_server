import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createHttpHandler } from "./http-handler.js";
import { createLogger } from "./logger.js";
import { SERVER_NAME } from "./server.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const handler = await createHttpHandler(config, logger);
  const port = Number(process.env.PORT ?? 8080);

  const server = createServer(handler);

  server.on("error", (error) => {
    logger.fatal({ err: error }, "server error");
    process.exit(1);
  });

  server.listen(port, () => {
    logger.info({ port, devMode: config.MUTANT_DEV_MODE }, `${SERVER_NAME} listening`);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});

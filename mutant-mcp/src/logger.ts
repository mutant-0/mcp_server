import { pino, type Logger } from "pino";

export type AppLogger = Logger;

/**
 * Structured JSON logger. Redacts bearer tokens and any authorization headers so
 * no credentials or health/genetic data can leak into CloudWatch logs.
 */
export function createLogger(level: string): AppLogger {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "headers.authorization",
        "req.headers.authorization",
        "token",
        "*.token",
        "accessToken",
        "*.accessToken",
      ],
      censor: "[REDACTED]",
    },
  });
}

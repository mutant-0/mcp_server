import { pino, type Logger } from "pino";

export type AppLogger = Logger;

/** Minimal destination shape pino accepts; lets tests capture log lines. */
export interface LogSink {
  write(chunk: string): void;
}

/**
 * Structured JSON logger. Redacts bearer tokens and any authorization headers so
 * no credentials or health/genetic data can leak into CloudWatch logs.
 *
 * Genotype payloads are never logged by the tools themselves; the redaction list
 * is the second line of defence for anything that logs a raw request object.
 */
export function createLogger(level: string, sink?: LogSink): AppLogger {
  const options = {
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
        "snps",
        "*.snps",
        "wgs_variant_calls",
        "*.wgs_variant_calls",
      ],
      censor: "[REDACTED]",
    },
  };
  return sink ? pino(options, sink) : pino(options);
}

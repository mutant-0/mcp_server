import { pino, type Logger } from "pino";

export type AppLogger = Logger;

/** Minimal destination shape pino accepts; lets tests capture log lines. */
export interface LogSink {
  write(chunk: string): void;
}

/**
 * Structured JSON logger. Redacts bearer tokens and any authorization headers so
 * no credentials leak, and redacts the sensitive tool-argument fields as
 * defence in depth.
 *
 * The privacy boundary is the audit schema in `./audit.ts`, which never records
 * an argument value; this list is a second line of defence for anything that logs
 * a raw request or backend object. A finite redaction list cannot make an
 * arbitrary object safe, so it is not relied on as the boundary.
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
        "analysis_context",
        "*.analysis_context",
        "upload_meta",
        "*.upload_meta",
        "file_name",
        "*.file_name",
      ],
      censor: "[REDACTED]",
    },
  };
  return sink ? pino(options, sink) : pino(options);
}

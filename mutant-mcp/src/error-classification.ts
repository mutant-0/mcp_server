/**
 * Bounded classification for thrown values.
 *
 * A caught error's `message` and `stack` are data: an SDK or a backend failure
 * can embed a query, a genotype, a filename, or a token in either. Production
 * logs record a fixed code and, where a human needs to tell two failures apart,
 * the error's *name* — never the message or stack. Inspect nested causes and SDK
 * error shapes at the call site and map them here rather than copying them.
 */

/** Map a thrown value to a bounded, non-data-bearing code. */
export function classifyThrownError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "AbortError":
      return "ABORTED";
    case "TimeoutError":
      return "TIMEOUT";
    case "SyntaxError":
      return "MALFORMED_RESPONSE";
    case "TypeError":
      return "TYPE_ERROR";
    case "RangeError":
      return "RANGE_ERROR";
    case "ZodError":
      return "VALIDATION_FAILED";
    default:
      return "UNEXPECTED_ERROR";
  }
}

/**
 * A safe error name for logs: the constructor name when it is a bounded
 * identifier, otherwise the generic `Error`. The message and stack are never
 * returned.
 */
export function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

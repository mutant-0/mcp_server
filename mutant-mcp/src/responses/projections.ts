import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Per-tool response projection (PRIV-03).
 *
 * `structuredContent` is the authoritative payload the host and the model read,
 * and the response builder used to forward whatever the backend returned. The
 * per-tool output schemas are intentionally `looseObject`s (so an additive
 * backend field never fails validation), which also means an unexpected debug,
 * internal, or account-identifying field would be forwarded verbatim. A loose
 * validation schema is not a projection.
 *
 * The projection here derives an allowlist from each tool's own output schema:
 * a value is walked against its schema and only declared keys survive. Arrays are
 * projected element-wise, nullable/optional/default wrappers are unwrapped, and a
 * discriminated union is projected with the branch that validates. Deliberately
 * open subtrees (`z.record(z.string(), z.unknown())`, e.g. the SNP catalog's
 * marker map) are kept as-is, because the schema declares them as opaque
 * application data.
 *
 * Because the allowlist is the declared contract, the projection cannot drift
 * from the schemas: a field the backend legitimately adds must be added to the
 * schema, which is the review surface this ticket exists to create.
 */

interface SchemaLike {
  def?: { type?: string };
  shape?: Record<string, SchemaLike>;
  element?: SchemaLike;
  options?: readonly SchemaLike[];
  valueType?: SchemaLike;
  unwrap?: () => SchemaLike;
  safeParse?: (value: unknown) => { success: boolean };
}

/** Wrapper schemas that delegate to an inner schema. */
const WRAPPER_TYPES = new Set(["optional", "nullable", "default", "prefault", "catch", "readonly"]);

function asSchemaLike(schema: unknown): SchemaLike | null {
  return typeof schema === "object" && schema !== null ? (schema as SchemaLike) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a value against a schema, keeping only declared fields. Returns the
 * value unchanged when the schema shape is not understood (a passthrough type or
 * an opaque record), and `undefined` when the schema demands an object/array and
 * the value is not one, so an unexpected shape is dropped rather than forwarded.
 */
export function projectValue(schema: unknown, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const node = asSchemaLike(schema);
  const type = node?.def?.type;
  if (!node || !type) return value;

  if (WRAPPER_TYPES.has(type)) {
    const inner = typeof node.unwrap === "function" ? node.unwrap() : undefined;
    return inner ? projectValue(inner, value) : value;
  }

  switch (type) {
    case "object": {
      if (!isPlainObject(value)) return undefined;
      const shape = node.shape;
      if (!shape) return value;
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        if (!(key in value)) continue;
        const field = projectValue(shape[key], value[key]);
        if (field !== undefined) projected[key] = field;
      }
      return projected;
    }
    case "array": {
      if (!Array.isArray(value)) return undefined;
      const element = node.element;
      if (!element) return value;
      return value.map((entry) => projectValue(element, entry));
    }
    case "union": {
      const options = node.options;
      if (!options) return value;
      for (const option of options) {
        if (option.safeParse?.(value).success) return projectValue(option, value);
      }
      // No branch validated: the value does not belong to this contract.
      return undefined;
    }
    case "record": {
      if (!isPlainObject(value)) return undefined;
      const valueType = node.valueType;
      if (!valueType) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, projectValue(valueType, entry)]),
      );
    }
    default:
      // Scalars, literals, enums, dates, and other passthrough types.
      return value;
  }
}

/**
 * `_meta` keys a tool result may carry. The UI descriptors, the per-tool
 * security scheme advertisement, and the auth challenge are the only sanctioned
 * keys; anything else is dropped so metadata cannot become a data-exfiltration
 * channel (moving a field into metadata is not a substitute for excluding it).
 */
const RESULT_META_KEYS = new Set([
  "ui",
  "ui/resourceUri",
  "openai/outputTemplate",
  "mutant",
  "securitySchemes",
  "mcp/www_authenticate",
]);

function projectMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(meta)) {
    if (RESULT_META_KEYS.has(key)) projected[key] = meta[key];
  }
  return projected;
}

/**
 * Project a tool result's `structuredContent` (against the tool's output schema)
 * and prune its `_meta` to the sanctioned keys. `content` is already a separate
 * deterministic projection (see `presentation/content.ts`) and is left as-is.
 */
export function projectToolResult(result: CallToolResult, outputSchema: unknown): CallToolResult {
  const projected: CallToolResult = { ...result };
  if (result.structuredContent !== undefined) {
    projected.structuredContent = projectValue(
      outputSchema,
      result.structuredContent,
    ) as Record<string, unknown>;
  }
  if (result._meta !== undefined) {
    projected._meta = projectMeta(result._meta) ?? {};
  }
  return projected;
}

/**
 * Processing-without-usable-analysis state handling (contract 3.0.0).
 *
 * `PROCESSING_INITIAL` and `REFRESH_PROCESSING_NO_USABLE_ANALYSIS` are the two
 * states where no usable analysis exists yet and the Apps SDK component owns the
 * experience: it polls on its own and paints progress, so the model must not
 * narrate status, suggest questions, or promise capabilities that do not exist.
 *
 * This module is the one shared predicate and the one place the target-state
 * model-facing text lives, so the status tool, the app-only polling tool, and the
 * content builder cannot disagree about which states are processing states.
 */
import type { ToolResponse } from "../contract.js";

/** The two states where no usable analysis exists yet. */
const PROCESSING_WITHOUT_USABLE_ANALYSIS = new Set<string>([
  "PROCESSING_INITIAL",
  "REFRESH_PROCESSING_NO_USABLE_ANALYSIS",
]);

/**
 * Exact, non-instructional model-facing text for each target state. Deliberately
 * a single short sentence: no call to action, no polling hint, and no claim about
 * what will become available.
 */
export const PROCESSING_STATUS_TEXT: Record<string, string> = {
  PROCESSING_INITIAL: "Analysis is processing.",
  REFRESH_PROCESSING_NO_USABLE_ANALYSIS: "Analysis refresh is processing.",
};

/** True for the two states where no usable analysis exists yet. */
export function isProcessingWithoutUsableAnalysis(state: unknown): boolean {
  return typeof state === "string" && PROCESSING_WITHOUT_USABLE_ANALYSIS.has(state);
}

/** The model-facing text for a target state, or `null` when it is not one. */
export function processingStatusText(state: unknown): string | null {
  return isProcessingWithoutUsableAnalysis(state)
    ? (PROCESSING_STATUS_TEXT[state as string] ?? null)
    : null;
}

/**
 * Drop the polling `next_action` from a component-owned status response.
 *
 * The backend always emits a `next_action` for the processing states so the
 * model has a deterministic recovery path. When the component owns polling, that
 * hint is noise the model must not act on or repeat, so the app-only polling
 * channel removes it. Every other state and shape is returned unchanged.
 */
export function withoutPollingHints(response: ToolResponse): ToolResponse {
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return response;
  if (!isProcessingWithoutUsableAnalysis((data as Record<string, unknown>).experience_state)) {
    return response;
  }
  const { next_action: _drop, ...rest } = data as Record<string, unknown>;
  return { ...response, data: rest };
}

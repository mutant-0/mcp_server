/**
 * Deterministic, model-facing `content` builders (MCP contract v2.0, §5 and §8).
 *
 * Each tool's text content is assembled on the server from the typed
 * `structuredContent` data. It never serializes that data as JSON: the envelope
 * stays authoritative in `structuredContent`, while `content` carries only the
 * decision-relevant facts, within the contract's per-tool budgets.
 */
import type { ToolName, ToolResponse } from "../contract.js";
import { processingStatusText } from "./processing.js";

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Human-facing scores are rounded; full precision stays in structuredContent. */
function rounded(value: unknown): number | null {
  const n = asNumber(value);
  return n === null ? null : Math.round(n * 10) / 10;
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Bound a single prose field so long catalog copy cannot blow the budget. */
function clampText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

function errorContent(response: ToolResponse): string {
  const error = response.error;
  const lines = [
    `error: ${error?.code ?? "UNKNOWN"}`,
    error?.message ?? "Unknown error",
  ];
  const nextAction = asRecord(error?.next_action);
  const nextTool = nextAction ? asText(nextAction.tool) : null;
  if (nextTool) {
    const reason = asText(nextAction?.reason);
    lines.push(reason ? `Next: call ${nextTool} (${reason}).` : `Next: call ${nextTool}.`);
  }
  return lines.join("\n");
}

/** Plain-language sentence for the canonical experience state. */
const EXPERIENCE_SENTENCES: Record<string, string> = {
  NO_DNA: "No DNA data has been imported for this account yet.",
  READY: "Your current DNA analysis is ready.",
  READY_REFRESH_AVAILABLE:
    "Your current DNA analysis is ready, and a newer platform version is available; refreshing is optional and your current results remain usable.",
  READY_REFRESH_PROCESSING:
    "Your current DNA analysis is ready while a refreshed analysis is being generated.",
  PROCESSING_FAILED: "The analysis could not be served and must be regenerated.",
};

function statusContent(data: JsonObject): string {
  const experience = asText(data.experience_state) ?? "";

  // The two no-usable-analysis processing states are component-owned: the model
  // gets one non-instructional sentence, never a next-action hint. Describing
  // future capabilities or asking the user to keep checking would duplicate what
  // the card already does.
  const processingText = processingStatusText(experience);
  if (processingText) return processingText;

  const parts: string[] = [];
  parts.push(
    EXPERIENCE_SENTENCES[experience] ??
      "DNA data is on file, but no analysis is available yet.",
  );

  if (experience === "READY" || experience === "READY_REFRESH_AVAILABLE") {
    parts.push("For an overview, open the analysis card with show_analysis_overview.");
  } else {
    const nextAction = asRecord(data.next_action);
    const nextTool = nextAction ? asText(nextAction.tool) : null;
    if (nextTool) parts.push(`Next: call ${nextTool}.`);
  }

  return parts.join(" ");
}

function hypothesisLine(entry: unknown): string | null {
  const item = asRecord(entry);
  if (!item) return null;
  const rank = asNumber(item.rank);
  const name = asText(item.name);
  if (!name) return null;
  const summary = asText(item.summary);
  const head = rank !== null ? `#${rank} ${name}` : name;
  return summary ? `${head}: ${summary}` : head;
}

function contextContent(data: JsonObject): string {
  const coverage = asRecord(data.coverage);
  const contract = asRecord(data.interpretation);
  const access = asRecord(data.access);
  const markers = coverage ? asNumber(coverage.analyzed_markers) : null;
  const parts: string[] = [];

  const purpose = contract ? asText(contract.purpose) : null;
  const readiness =
    markers !== null
      ? `Your DNA analysis is ready and assessed ${markers} markers.`
      : "Your DNA analysis is ready.";
  parts.push(purpose ? `${readiness} ${purpose}` : readiness);

  const previews = asList(data.preview)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .slice(0, 3);
  if (previews.length > 0) {
    const lines = previews.map((preview, index) => {
      const rank = asNumber(preview.rank) ?? index + 1;
      const name = clampText(asText(preview.name) ?? "Untitled finding", 120);
      const summary = asText(preview.summary);
      return summary ? `${rank}. ${name} - ${clampText(summary, 200)}` : `${rank}. ${name}`;
    });
    parts.push(`Your highest-ranked findings are:\n${lines.join("\n")}`);
  }

  // Access scope, stated by the server so the model cannot imply the previews
  // are the whole analysis.
  const scopeMessage = access ? asText(access.scope_message) : null;
  if (scopeMessage) parts.push(scopeMessage);

  // The most important interpretation boundary; never the whole contract.
  const boundary = asText(asList(contract?.limitations)[0]);
  if (boundary) parts.push(boundary);

  parts.push(
    "You can ask me to explain one finding, compare the three, or search accessible hypotheses by topic.",
  );

  return parts.join("\n\n");
}

function listContent(data: JsonObject): string {
  const lines = asList(data.items)
    .map(hypothesisLine)
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return "No health hypotheses matched.";
  const parts = [`${lines.length} health ${lines.length === 1 ? "hypothesis" : "hypotheses"}:`];
  for (const line of lines) parts.push(line);
  if (asText(data.next_cursor)) parts.push("More results are available.");
  return parts.join("\n");
}

/**
 * Concise, decision-relevant explanation (~150-220 words) in three sections:
 * What it means, Why it appeared, What could clarify it. Everything else the
 * explanation could say (module list, retained patterns, key genes, converging
 * patterns, stronger/weakening prose, the guardrail list, exact scores) stays in
 * `structuredContent` and is reachable through `get_supporting_evidence`.
 */
function detailsContent(data: JsonObject): string {
  const hypothesis = asRecord(data.hypothesis);
  const explanation = asRecord(data.explanation);
  const confirmation = asRecord(data.confirmation);
  const architecture = asRecord(data.support_architecture);
  const interpretation = asRecord(data.score_interpretation);
  const sections: string[] = [];

  // What it means: the headline, grounded in the canonical bottom line.
  const name = hypothesis ? asText(hypothesis.name) : null;
  const bottomLine =
    asText(data.bottom_line) ?? (explanation ? asText(explanation.bottom_line) : null);
  const meaning = [name ? `${name}.` : null, bottomLine ? clampText(bottomLine, 240) : null]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (meaning) sections.push(`What it means: ${meaning}`);

  // Why it appeared: architecture first, then the ranking rationale. Both are
  // canonical backend projections, never re-derived here.
  const whyParts: string[] = [];
  const architectureSummary = architecture ? asText(architecture.summary) : null;
  if (architectureSummary) whyParts.push(clampText(architectureSummary, 240));
  const whyRanked = explanation ? asText(explanation.why_ranked) : null;
  if (whyRanked) whyParts.push(clampText(whyRanked, 240));
  if (whyParts.length > 0) sections.push(`Why it appeared: ${whyParts.join(" ")}`);

  // What could clarify it: the interpretation boundary, any material data gap,
  // and at most two primary checks. Uncertainty is never dropped for brevity.
  const clarifyParts: string[] = [];
  const boundary = explanation ? asText(explanation.interpretation_boundary) : null;
  if (boundary) clarifyParts.push(clampText(boundary, 240));
  const dataGap = interpretation ? asText(interpretation.data_gap_effect) : null;
  if (dataGap) clarifyParts.push(clampText(dataGap, 200));
  const checks = asList(confirmation?.primary_checks)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .map((check) => {
      const label = asText(check.short_name) ?? asText(check.id);
      if (!label) return null;
      const role = asText(check.role);
      return role ? `${label} (${role})` : label;
    })
    .filter((check): check is string => check !== null)
    .slice(0, 2);
  if (checks.length > 0) clarifyParts.push(`Useful checks: ${joinNatural(checks)}.`);
  if (clarifyParts.length > 0) sections.push(`What could clarify it: ${clarifyParts.join(" ")}`);

  if (sections.length === 0) {
    return name ? `Finding: ${name}.` : "Finding details are not available.";
  }
  return sections.join("\n\n");
}

function evidenceContent(data: JsonObject): string {
  const kind = asText(data.kind) ?? "evidence";
  const items = asList(data.items);
  if (items.length === 0) {
    if (asText(data.source_state) === "not_provided") {
      return "No stored sources are available for this finding.";
    }
    return `No ${kind} evidence is available for this finding.`;
  }
  const parts = [`${items.length} ${kind} ${items.length === 1 ? "item" : "items"}.`];
  if (kind === "patterns") {
    for (const entry of items.slice(0, 5)) {
      const pattern = asRecord(entry);
      const name = pattern ? asText(pattern.name) : null;
      if (!name) continue;
      const state = pattern ? asText(pattern.state) : null;
      const impact = pattern ? rounded(pattern.impact_points) : null;
      const suffix = [state, impact !== null ? `${impact} impact points` : null]
        .filter((part): part is string => part !== null)
        .join(", ");
      parts.push(suffix ? `${name} (${suffix})` : name);
    }
  } else if (kind === "variants") {
    const ids = items
      .map((entry) => {
        const variant = asRecord(entry);
        return variant ? asText(variant.rsid) : null;
      })
      .filter((id): id is string => id !== null)
      .slice(0, 8);
    if (ids.length > 0) parts.push(ids.join(", "));
  } else if (kind === "modules") {
    for (const entry of items.slice(0, 5)) {
      const module = asRecord(entry);
      const name = module
        ? asText(module.module_name) ?? asText(module.module_id)
        : null;
      if (!name) continue;
      const status = module ? asText(module.scoring_status) : null;
      const retained = module ? rounded(module.retained_support) : null;
      const suffix = [
        status,
        retained !== null ? `${retained} retained points` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(", ");
      parts.push(suffix ? `${name} (${suffix})` : name);
    }
  } else if (kind === "tests") {
    for (const entry of items.slice(0, 6)) {
      const test = asRecord(entry);
      const name = test ? asText(test.name) : null;
      if (name) parts.push(name);
    }
  } else if (kind === "sources") {
    const titles = items
      .map((entry) => {
        const source = asRecord(entry);
        return source ? asText(source.title) : null;
      })
      .filter((title): title is string => title !== null)
      .slice(0, 5);
    if (titles.length > 0) parts.push(titles.join("; "));
  }
  if (asText(data.next_cursor)) parts.push("More evidence is available.");
  return parts.join(" ");
}

function geneticContextContent(data: JsonObject): string {
  const markers = asList(data.markers);
  const parts = [`${markers.length} analyzed ${markers.length === 1 ? "marker" : "markers"}.`];
  const rsids = markers
    .map((entry) => {
      const marker = asRecord(entry);
      return marker ? asText(marker.rsid) : null;
    })
    .filter((id): id is string => id !== null)
    .slice(0, 10);
  if (rsids.length > 0) parts.push(rsids.join(", "));
  const modules = asList(data.modules);
  if (modules.length > 0) {
    parts.push(`${modules.length} module ${modules.length === 1 ? "summary" : "summaries"} included.`);
  }
  if (asText(data.next_cursor)) parts.push("More markers are available.");
  return parts.join(" ");
}

function reportContent(data: JsonObject): string {
  const status = asText(data.status) ?? "processing";
  return `DNA import accepted; analysis status: ${status}.`;
}

/**
 * Build the deterministic model-facing text for one tool result. Never a
 * serialized copy of `structuredContent`; errors are reported without it too.
 */
export function buildContent(operation: ToolName | undefined, response: ToolResponse): string {
  if (!response.ok) return errorContent(response);
  const data = asRecord(response.data);
  if (!data) return "No data returned.";
  switch (operation) {
    case "get_analysis_status":
    case "poll_analysis_status":
      return statusContent(data);
    case "get_analysis_context":
      return contextContent(data);
    case "list_health_hypotheses":
      return listContent(data);
    case "explain_health_hypothesis":
      return detailsContent(data);
    case "get_supporting_evidence":
      return evidenceContent(data);
    case "get_genetic_context":
      return geneticContextContent(data);
    case "show_dna_import":
      return "DNA import component displayed.";
    case "show_analysis_overview":
      return "Analysis overview card displayed.";
    case "show_analysis_followups":
      return "Follow-up card displayed.";
    case "get_snp_catalog":
      return "SNP catalog returned for the DNA import component.";
    case "create_report":
      return reportContent(data);
    default:
      return "Request completed.";
  }
}

/**
 * Deterministic, model-facing `content` builders (MCP contract v2.0, §5 and §8).
 *
 * Each tool's text content is assembled on the server from the typed
 * `structuredContent` data. It never serializes that data as JSON: the envelope
 * stays authoritative in `structuredContent`, while `content` carries only the
 * decision-relevant facts, within the contract's per-tool budgets.
 */
import type { ToolName, ToolResponse } from "../contract.js";

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
  if (error?.next_action) lines.push(error.next_action);
  return lines.join("\n");
}

function statusContent(data: JsonObject): string {
  const dna = asText(data.dna_status) ?? "unknown";
  const analysis = asText(data.analysis_status) ?? "unknown";
  const parts: string[] = [];

  if (dna === "missing") {
    parts.push("No DNA data has been imported for this account yet.");
  } else if (analysis === "ready") {
    parts.push("Your current DNA analysis is ready.");
  } else if (analysis === "processing") {
    parts.push("Your DNA analysis is still processing.");
  } else if (analysis === "failed") {
    parts.push("Your last DNA analysis did not complete.");
  } else {
    parts.push("DNA data is on file, but no analysis is available yet.");
  }

  const regeneration = asRecord(data.regeneration);
  if (data.regenerate === true && regeneration) {
    if (regeneration.required === true) {
      parts.push("A refreshed analysis is required, so DNA must be resubmitted.");
    } else if (regeneration.current_results_usable !== false) {
      parts.push(
        "A newer platform version is also available; resubmitting your DNA is optional, " +
          "and your current results remain usable.",
      );
    } else {
      parts.push("A refreshed analysis is available.");
    }
  }

  const nextAction = asRecord(data.next_action);
  const nextTool = nextAction ? asText(nextAction.tool) : null;
  if (analysis === "ready") {
    parts.push("For an overview, open the analysis card with show_analysis_overview.");
  } else if (nextTool) {
    parts.push(`Next: call ${nextTool}.`);
  }

  return parts.join(" ");
}

function hypothesisLine(entry: unknown): string | null {
  const item = asRecord(entry);
  if (!item) return null;
  const rank = asNumber(item.rank);
  const title = asText(item.title);
  if (!title) return null;
  const bottom = asText(item.bottom_line);
  const head = rank !== null ? `#${rank} ${title}` : title;
  return bottom ? `${head}: ${bottom}` : head;
}

function contextContent(data: JsonObject): string {
  const coverage = asRecord(data.coverage);
  const contract = asRecord(data.interpretation_contract);
  const access = asRecord(data.access_summary);
  const markers = coverage ? asNumber(coverage.analyzed_markers) : null;
  const parts: string[] = [];

  const purpose = contract ? asText(contract.purpose) : null;
  const readiness =
    markers !== null
      ? `Your DNA analysis is ready and assessed ${markers} markers.`
      : "Your DNA analysis is ready.";
  parts.push(purpose ? `${readiness} ${purpose}` : readiness);

  const previews = asList(data.top_hypotheses)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .slice(0, 3);
  if (previews.length > 0) {
    const lines = previews.map((preview, index) => {
      const rank = asNumber(preview.rank) ?? index + 1;
      const title = clampText(asText(preview.title) ?? "Untitled finding", 120);
      const bottom = asText(preview.bottom_line);
      return bottom ? `${rank}. ${title} - ${clampText(bottom, 200)}` : `${rank}. ${title}`;
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

function detailsContent(data: JsonObject): string {
  const hypothesis = asRecord(data.hypothesis);
  const explanation = asRecord(data.explanation);
  const confirmation = asRecord(data.confirmation);
  const parts: string[] = [];

  // 1. Bottom line.
  const bottomLine = explanation ? asText(explanation.bottom_line) : null;
  if (bottomLine) parts.push(bottomLine);

  // 2. Support architecture (module-first). The legacy fallback summary is
  // included verbatim rather than fabricating a breadth claim.
  const architecture = asRecord(data.support_architecture);
  const architectureSummary = architecture
    ? asText(architecture.summary)
    : null;
  if (architectureSummary) {
    parts.push(`Evidence architecture: ${architectureSummary}`);
  }

  // 3. Top module contributions (already capped at three by the backend).
  const modules = asList(data.module_contributions)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null);
  const moduleSummaries = modules
    .map((module) => asText(module.summary))
    .filter((summary): summary is string => summary !== null)
    .slice(0, 3);
  if (moduleSummaries.length > 0) {
    parts.push(`Module contributions: ${moduleSummaries.join(" ")}`);
  }

  // 4. Retained pattern contributions.
  const patterns = asList(data.pattern_contributions)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null);
  if (patterns.length > 0) {
    const patternLines = patterns
      .map((pattern) => {
        const name = asText(pattern.pattern_name) ?? asText(pattern.pattern_id);
        if (!name) return null;
        const state = asText(pattern.state);
        return state ? `${name} (${state})` : name;
      })
      .filter((line): line is string => line !== null)
      .slice(0, 3);
    if (patternLines.length > 0) {
      parts.push(`Retained patterns: ${joinNatural(patternLines)}.`);
    }
  } else {
    // Legacy analyses only expose the pattern names nested in the explanation.
    const legacyNames = asList(explanation?.top_contributing_patterns)
      .map((entry) => asRecord(entry))
      .filter((entry): entry is JsonObject => entry !== null)
      .map((pattern) => asText(pattern.name))
      .filter((name): name is string => name !== null)
      .slice(0, 2);
    if (legacyNames.length > 0) {
      parts.push(`The strongest contributing patterns were ${joinNatural(legacyNames)}.`);
    }
  }

  // 4b. Converging patterns are a separate, priority-only family. Reported
  // separately and never described as adding to module or pattern support.
  const converging = asList(data.converging_pattern_contributions)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .map((entry) => asText(entry.pattern_id))
    .filter((name): name is string => name !== null)
    .slice(0, 3);
  if (converging.length > 0) {
    parts.push(`Converging patterns adjusted priority only: ${joinNatural(converging)}.`);
  }

  // 5. One or two key scoring genes/variants, only from contributing modules.
  // Context-only and zero-weight markers never appear here.
  const scoringGenes: string[] = [];
  for (const module of modules) {
    for (const gene of asList(module.top_scoring_genes)) {
      const name = asText(gene);
      if (name && !scoringGenes.includes(name)) scoringGenes.push(name);
    }
    if (scoringGenes.length >= 2) break;
  }
  if (scoringGenes.length > 0) {
    parts.push(`The key scoring drivers were ${joinNatural(scoringGenes.slice(0, 2))}.`);
  }
  // Keep the dual-role boundary explicit whenever patterns participated.
  if (patterns.length > 0) {
    parts.push(
      "Pattern participation is separate from module scoring: a variant can participate in a retained pattern without contributing module points.",
    );
  }

  // 6. Interpretation boundary.
  const boundary = explanation ? asText(explanation.interpretation_boundary) : null;
  if (boundary) parts.push(boundary);

  // 7. Minimal confirmation.
  const checks = asList(confirmation?.primary_checks)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .map((check) => {
      const name = asText(check.short_name) ?? asText(check.id);
      const role = asText(check.role);
      if (!name) return null;
      return role ? `${name} (${role})` : name;
    })
    .filter((check): check is string => check !== null)
    .slice(0, 2);
  if (checks.length > 0) {
    parts.push(`The smallest useful confirmation plan is ${joinNatural(checks)}.`);
  }

  // 8. Strengthening/weakening evidence and an action-changing guardrail.
  const stronger = confirmation ? asText(confirmation.stronger_support) : null;
  if (stronger) parts.push(stronger);
  const weakening = confirmation ? asText(confirmation.weakening_evidence) : null;
  if (weakening) parts.push(weakening);

  const guardrail = asText(asList(data.guardrails)[0]);
  if (guardrail) parts.push(guardrail);

  if (parts.length === 0) {
    const title = hypothesis ? asText(hypothesis.title) : null;
    return title ? `Finding: ${title}.` : "Finding details are not available.";
  }
  return parts.join(" ");
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
    case "get_snp_catalog":
      return "SNP catalog returned for the DNA import component.";
    case "create_report":
      return reportContent(data);
    default:
      return "Request completed.";
  }
}

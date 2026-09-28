/**
 * State-aware prompt suggestions (MCP contract 3.0.0, §6).
 *
 * Suggestions are derived from the canonical `experience_state` and the
 * capability flags, never from the removed `analysis_status`/`regenerate` fields.
 * They are user-visible natural language: never internal commands such as
 * `call_explain_health_hypothesis(id=...)`.
 *
 * Each chip also carries a structured `action` bound to the snapshot it was
 * rendered from (`{ analysis_version, hypothesis_id, intent }`), so a follow-up
 * click references the exact revision the user was looking at. At most five are
 * returned, ordered by likely usefulness.
 */
import type { PromptAction, PromptSuggestion, ToolName, ToolResponse } from "../contract.js";

type JsonObject = Record<string, unknown>;

const MAX_SUGGESTIONS = 5;

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function action(
  intent: PromptSuggestion["intent"],
  analysisVersion: string | null,
  hypothesisId?: string | null,
): PromptAction {
  return {
    ...(analysisVersion ? { analysis_version: analysisVersion } : {}),
    ...(hypothesisId ? { hypothesis_id: hypothesisId } : {}),
    intent,
  };
}

function statusPrompts(data: JsonObject, analysisVersion: string | null): PromptSuggestion[] {
  const experience = asText(data.experience_state);
  const capabilities = asRecord(data.capabilities);
  const canQuery = capabilities?.can_query_analysis === true;
  const out: PromptSuggestion[] = [];

  if (experience === "NO_DNA") {
    out.push({
      id: "import-format",
      label: "Accepted files",
      prompt: "What DNA file formats can I import, and how does the import work?",
      intent: "import_help",
      action: action("import_help", null),
    });
    out.push({
      id: "import-privacy",
      label: "Is my DNA private?",
      prompt: "How is my DNA file handled during import, and is it kept private?",
      intent: "import_help",
      action: action("import_help", null),
    });
    return out.slice(0, MAX_SUGGESTIONS);
  }

  if (canQuery) {
    out.push({
      id: "top-findings",
      label: "My top findings",
      prompt: "What are my top health hypotheses?",
      intent: "overview",
      action: action("overview", analysisVersion),
    });
    out.push({
      id: "explain-first",
      label: "Explain #1",
      prompt: "Explain my #1 finding in plain English.",
      intent: "explain",
      action: action("explain", analysisVersion),
    });
    if (
      experience === "READY_REFRESH_AVAILABLE" ||
      experience === "READY_REFRESH_PROCESSING"
    ) {
      out.push({
        id: "why-refresh",
        label: "Why refresh?",
        prompt: "Why is a refreshed analysis available, and what might change?",
        intent: "regeneration",
        action: action("regeneration", analysisVersion),
      });
      if (experience === "READY_REFRESH_AVAILABLE") {
        out.push({
          id: "start-refresh",
          label: "Refresh analysis",
          prompt: "I'd like to refresh my analysis with the newer platform.",
          intent: "regeneration",
          action: action("regeneration", analysisVersion),
        });
      }
    }
    out.push({
      id: "compare-top",
      label: "Compare top 3",
      prompt: "Compare my top three findings.",
      intent: "comparison",
      action: action("comparison", analysisVersion),
    });
    out.push({
      id: "clinician-questions",
      label: "Ask my clinician",
      prompt: "What should I ask my clinician about my top findings?",
      intent: "clinician_questions",
      action: action("clinician_questions", analysisVersion),
    });
    return out.slice(0, MAX_SUGGESTIONS);
  }

  if (
    experience === "PROCESSING_INITIAL" ||
    experience === "REFRESH_PROCESSING_NO_USABLE_ANALYSIS"
  ) {
    // Component-owned: no suggested prompts. The card owns the processing
    // experience and the model must not offer to describe what will become
    // available.
    return out.slice(0, MAX_SUGGESTIONS);
  }

  if (experience === "PROCESSING_FAILED") {
    out.push({
      id: "regenerate",
      label: "Regenerate analysis",
      prompt: "My analysis could not be served. What do I need to do to regenerate it?",
      intent: "regeneration",
      action: action("regeneration", analysisVersion),
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function contextPrompts(data: JsonObject, analysisVersion: string | null): PromptSuggestion[] {
  const access = asRecord(data.access);
  const isFull = access ? asText(access.hypothesis_scope) === "all" : false;
  const previews = Array.isArray(data.preview) ? data.preview : [];
  const firstPreview = asRecord(previews[0]);
  const firstId = firstPreview ? asText(firstPreview.id) : null;

  const out: PromptSuggestion[] = [
    {
      id: "explain-first",
      label: "Explain #1",
      prompt: "Explain my #1 finding in plain English.",
      intent: "explain",
      action: action("explain", analysisVersion, firstId),
    },
    {
      id: "compare-top-three",
      label: "Compare top 3",
      prompt: "Compare my top three findings and explain how they differ.",
      intent: "comparison",
      action: action("comparison", analysisVersion, firstId),
    },
    {
      id: "compare-medical-records",
      label: "Compare with my history",
      prompt:
        "Which of my top three Mutant findings seems most relevant to the health history I've shared? What supports or argues against each? If I have not shared any health history in this conversation, ask me what I want to share before comparing; do not imply access to records I have not provided, and do not assume symptoms or test results I have not given you.",
      intent: "comparison",
      action: action("comparison", analysisVersion),
    },
  ];

  if (isFull) {
    out.push({
      id: "search-all",
      label: "Search all findings",
      prompt: "Search my complete analysis for findings by topic.",
      intent: "overview",
      action: action("overview", analysisVersion),
    });
    out.push({
      id: "compare-all",
      label: "Compare all findings",
      prompt:
        "Compare all findings in my complete Mutant analysis with medical records you can actually access in this conversation, including connected health records if available. First check what records are accessible; do not infer access from my account or claim to have read records you cannot see. If none are accessible, ask me to provide records here. Keep genetic findings separate from my clinical records.",
      intent: "comparison",
      action: action("comparison", analysisVersion),
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function detailsPrompts(data: JsonObject, analysisVersion: string | null): PromptSuggestion[] {
  const hypothesis = asRecord(data.hypothesis);
  const id = hypothesis ? asText(hypothesis.id) : null;
  const name = hypothesis ? asText(hypothesis.name) : null;
  const ref = name ? `"${name}"` : "top";
  const base: PromptSuggestion[] = [
    {
      id: "why-ranked",
      label: "Why this rank?",
      prompt: `Why did my ${ref} finding rank where it did?`,
      intent: "explain",
      action: action("explain", analysisVersion, id),
    },
    {
      id: "support-architecture",
      label: "Broad or concentrated?",
      prompt: `Is the genetic support for my ${ref} finding broad or concentrated?`,
      intent: "explain",
      action: action("explain", analysisVersion, id),
    },
    {
      id: "module-contributions",
      label: "Which modules?",
      prompt: `Which biological modules contributed to my ${ref} finding, and which were contextual only?`,
      intent: "evidence",
      action: action("evidence", analysisVersion, id),
    },
    {
      id: "supporting-evidence",
      label: "Supporting evidence",
      prompt: `Which variants and patterns support my ${ref} finding?`,
      intent: "evidence",
      action: action("evidence", analysisVersion, id),
    },
    {
      id: "strengthen-weaken",
      label: "What changes it?",
      prompt: `What would strengthen or weaken my ${ref} finding?`,
      intent: "evidence",
      action: action("evidence", analysisVersion, id),
    },
  ];
  return base.slice(0, MAX_SUGGESTIONS);
}

/** Attach state-aware suggestions to a successful result's typed data. */
export function withSuggestedPrompts(response: ToolResponse, operation: ToolName): ToolResponse {
  if (!response.ok || !response.data) return response;
  const data = asRecord(response.data);
  if (!data) return response;

  let prompts: PromptSuggestion[];
  switch (operation) {
    case "get_analysis_status":
      prompts = statusPrompts(data, response.analysis_version);
      break;
    case "get_analysis_context":
      prompts = contextPrompts(data, response.analysis_version);
      break;
    case "explain_health_hypothesis":
      prompts = detailsPrompts(data, response.analysis_version);
      break;
    default:
      return response;
  }
  if (prompts.length === 0) return response;
  return {
    ...response,
    data: { ...data, suggested_prompts: prompts.slice(0, MAX_SUGGESTIONS) },
  };
}

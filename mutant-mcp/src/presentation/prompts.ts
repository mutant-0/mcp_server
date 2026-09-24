/**
 * State-aware prompt suggestions (MCP contract v2.0, §6).
 *
 * Suggestions are derived from the current typed result so the widget can offer
 * natural next questions. They are user-visible natural language: never internal
 * commands such as `call_explain_health_hypothesis(id=...)`. At most five are
 * returned, ordered by likely usefulness.
 */
import type { PromptSuggestion, ToolName, ToolResponse } from "../contract.js";

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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusPrompts(data: JsonObject): PromptSuggestion[] {
  const dna = asText(data.dna_status);
  const analysis = asText(data.analysis_status);
  const out: PromptSuggestion[] = [];

  if (dna === "missing") {
    out.push({
      id: "import-format",
      label: "Accepted files",
      prompt: "What DNA file formats can I import, and how does the import work?",
      intent: "import_help",
    });
    out.push({
      id: "import-privacy",
      label: "Is my DNA private?",
      prompt: "How is my DNA file handled during import, and is it kept private?",
      intent: "import_help",
    });
    return out.slice(0, MAX_SUGGESTIONS);
  }

  if (analysis === "ready") {
    out.push({
      id: "top-findings",
      label: "My top findings",
      prompt: "What are my top health hypotheses?",
      intent: "overview",
    });
    out.push({
      id: "explain-first",
      label: "Explain #1",
      prompt: "Explain my #1 finding in plain English.",
      intent: "explain",
    });
    if (data.regenerate === true) {
      out.push({
        id: "why-refresh",
        label: "Why refresh?",
        prompt: "Why is a refreshed analysis available, and what might change?",
        intent: "regeneration",
      });
      out.push({
        id: "start-refresh",
        label: "Refresh analysis",
        prompt: "I'd like to refresh my analysis with the newer platform.",
        intent: "regeneration",
      });
    }
    out.push({
      id: "compare-top",
      label: "Compare top 3",
      prompt: "Compare my top three findings.",
      intent: "comparison",
    });
    out.push({
      id: "clinician-questions",
      label: "Ask my clinician",
      prompt: "What should I ask my clinician about my top findings?",
      intent: "clinician_questions",
    });
    return out.slice(0, MAX_SUGGESTIONS);
  }

  if (analysis === "processing") {
    out.push({
      id: "what-happens",
      label: "What happens next?",
      prompt: "What happens while my analysis is processing, and what will I be able to see?",
      intent: "import_help",
    });
    return out.slice(0, MAX_SUGGESTIONS);
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function contextPrompts(data: JsonObject): PromptSuggestion[] {
  const access = asRecord(data.access_summary);
  const isFull = access ? asText(access.hypothesis_scope) === "all" : false;
  const locked = access ? asNumber(access.locked) : null;

  const out: PromptSuggestion[] = [
    {
      id: "explain-first",
      label: "Explain #1",
      prompt: "Explain my #1 finding in plain English.",
      intent: "explain",
    },
    {
      id: "compare-top-three",
      label: "Compare top 3",
      prompt: "Compare my top three findings and explain how they differ.",
      intent: "comparison",
    },
    {
      id: "compare-medical-records",
      label: "Compare with my records",
      prompt:
        "Compare my accessible Mutant findings with medical records you can actually access in this conversation, including connected health records if available. First check what records are accessible; do not infer access from my account or claim to have read records you cannot see. If none are accessible, ask me to provide records here. Do not assume symptoms or test results I have not given you.",
      intent: "comparison",
    },
  ];

  if (isFull) {
    out.push({
      id: "search-all",
      label: "Search all findings",
      prompt: "Search my complete analysis for findings by topic.",
      intent: "overview",
    });
    out.push({
      id: "compare-all",
      label: "Compare all findings",
      prompt:
        "Compare all findings in my complete Mutant analysis with medical records you can actually access in this conversation, including connected health records if available. First check what records are accessible; do not infer access from my account or claim to have read records you cannot see. If none are accessible, ask me to provide records here. Keep genetic findings separate from my clinical records.",
      intent: "comparison",
    });
  } else if (locked !== null && locked > 0) {
    out.push({
      id: "full-scope",
      label: "Compare all with Full",
      prompt:
        "How would Mutant Full let me compare all ranked hypotheses with my medical records? Explain what it unlocks beyond my accessible top three without revealing locked findings.",
      intent: "overview",
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function detailsPrompts(data: JsonObject): PromptSuggestion[] {
  const hypothesis = asRecord(data.hypothesis);
  const id = hypothesis ? asText(hypothesis.id) : null;
  const title = hypothesis ? asText(hypothesis.title) : null;
  const ref = title ? `"${title}"` : "top";
  const base: PromptSuggestion[] = [
    {
      id: "why-ranked",
      label: "Why this rank?",
      prompt: `Why did my ${ref} finding rank where it did?`,
      intent: "explain",
    },
    {
      id: "support-architecture",
      label: "Broad or concentrated?",
      prompt: `Is the genetic support for my ${ref} finding broad or concentrated?`,
      intent: "explain",
    },
    {
      id: "module-contributions",
      label: "Which modules?",
      prompt: `Which biological modules contributed to my ${ref} finding, and which were contextual only?`,
      intent: "evidence",
    },
    {
      id: "supporting-evidence",
      label: "Supporting evidence",
      prompt: `Which variants and patterns support my ${ref} finding?`,
      intent: "evidence",
    },
    {
      id: "strengthen-weaken",
      label: "What changes it?",
      prompt: `What would strengthen or weaken my ${ref} finding?`,
      intent: "evidence",
    },
  ];
  return base
    .map((suggestion) => (id ? { ...suggestion, hypothesis_id: id } : suggestion))
    .slice(0, MAX_SUGGESTIONS);
}

/** Attach state-aware suggestions to a successful result's typed data. */
export function withSuggestedPrompts(response: ToolResponse, operation: ToolName): ToolResponse {
  if (!response.ok || !response.data) return response;
  const data = asRecord(response.data);
  if (!data) return response;

  let prompts: PromptSuggestion[];
  switch (operation) {
    case "get_analysis_status":
      prompts = statusPrompts(data);
      break;
    case "get_analysis_context":
      prompts = contextPrompts(data);
      break;
    case "explain_health_hypothesis":
      prompts = detailsPrompts(data);
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

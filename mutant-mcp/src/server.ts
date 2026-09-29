import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MutantUserContext } from "./auth/user-context.js";
import type { MutantBackendClient } from "./clients/mutant-lambda-client.js";
import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import { registerAnalysisFollowupsUi } from "./ui/analysis-followups/resource.js";
import { registerDnaImportUi } from "./ui/dna-import/resource.js";

export const SERVER_NAME = "mutant-mcp";
export const SERVER_VERSION = "1.0.0";

export const SERVER_INSTRUCTIONS = [
  "Mutant Genomics MCP server for the connected account's current saved analysis.",
  "Entry prompts in a fresh conversation may be any of \"Which of my Mutant findings best fits the health history or records I've shared here?\", \"Show my current Mutant findings.\", or \"Help me add my DNA data to Mutant.\". Call get_analysis_status first for every one of them, because readiness is unknown, then follow its experience_state and capabilities: a ready broad-results prompt opens show_analysis_overview; a ready comparison prompt uses the accessible findings and only the health history or records actually present in this ChatGPT conversation, and when none were shared it asks what the user wants to share without inventing symptoms, laboratory results, or a records connection; NO_DNA opens show_dna_import; a processing state shows only the current processing experience with no promised future results and no extra polling instructions. Never pass the user's health-history prose as the list_health_hypotheses query argument; only catalog-topic keywords may be sent to search tools.",
  "Routing: call get_analysis_status first when readiness is unknown. Read its experience_state and capabilities instead of inferring readiness. When experience_state is NO_DNA, call show_dna_import in the same turn. When experience_state is READY_REFRESH_AVAILABLE or READY_REFRESH_PROCESSING, its result already opens the Apps SDK card with the refresh option; let the card present it and do not write a prose recap or open a second card. For any broad opening question (for example \"What are my top hypotheses?\", \"What did Mutant find?\", \"Show my results\", or a general overview), call get_analysis_status, then when capabilities.can_show_overview is true call show_analysis_overview in the same turn and let its card show the accessible findings and hints. A broad opening question is never answered with list_health_hypotheses and never with a prose list of the same findings. Do not narrate status after rendering the card, and do not restate the ranked list the card already shows.",
  "While no usable analysis exists (experience_state PROCESSING_INITIAL or REFRESH_PROCESSING_NO_USABLE_ANALYSIS), do not call analysis, overview, hypothesis, evidence, or genetic-context tools, do not describe or speculate about future capabilities, genes, modules, rsIDs, variants, hypotheses, scores, or patterns, and never promise what will become available. The DNA import component owns that state and polls its own app-only poll_analysis_status tool, so do not poll get_analysis_status, do not tell the user to keep asking for updates, and do not add unsolicited processing narration. If the user explicitly asks, answer briefly using only the current status payload.",
  "After the overview card has rendered, a specific analysis question uses get_analysis_context for the interpretation contract, boundaries, and access scope, list_health_hypotheses for browsing, searching, or comparisons, and explain_health_hypothesis for one finding in depth. Do not render the overview card again for a specific question, do not emit a second competing list of the same findings, and do not re-answer the broad overview question in prose. Pass the displayed analysis_version from a card or prompt suggestion back on follow-up calls so the same revision is answered.",
  "A list_health_hypotheses search returns a server-authored search_scope describing what it covered. When a catalog-topic query returns no items, report that scope once as the factual answer: a Free no_match_in_accessible_scope means only that the accessible top three did not match and says nothing about whether the topic is present in the locked ranked set, so never state or imply that a locked finding does or does not exist and never promise Full will find it; state the wider-search sentence only when broader_ranked_search_available is true; a Full miss is limited to the catalog search fields (name, summary, plain-language summary, and type), not all biological evidence. Do not compare unseen scores, invent mechanisms, or pitch an upgrade, and keep query to catalog-topic keywords only.",
  "Decide the compact follow-up card (`show_analysis_followups`) from the user's requested task, never from which data tools you called while answering. Show the card only when the user explicitly asked to explain, interpret, or understand one identified finding (by rank or name, including a deliberate click on an Explain action), or to compare two or more accessible findings (for example \"Compare my top three\"). Only then, when the host supports Apps SDK UI, call show_analysis_followups once per answer with that same analysis_version and the hypothesis ids the answer covered (at most three). Do not infer eligibility because explain_health_hypothesis or list_health_hypotheses was used as supporting research. Do not show the card for an open-ended topic or symptom question (for example \"What can you say about my thyroid issues?\" or \"What about histamine?\") even if the answer discusses one ranked finding or called explain_health_hypothesis to check it; nor for a catalog search, a no-match answer, an evidence or marker lookup, a broad result overview, a processing or import or recovery turn, a finding mentioned incidentally, or a request that already asks to compare findings with the user's health history or records (its history action would only repeat the action just performed). When the card is eligible its actions must be relevant and must not repeat the question just answered; if neither server-selected action is a relevant next step, omit the card rather than showing generic buttons. Keep the answer itself in ChatGPT, do not repeat the card's labels or restate the findings, and if the host cannot render UI or the call is rejected as stale or out of scope, the answer still stands.",
  "Never ask the user for an analysis ID; the current analysis is resolved from the connection.",
  "Never ask the user to paste DNA data, genotypes, or file contents into the conversation, and never repeat genotypes back to them.",
  "Use priority_score only for ordering and genetic_support only for strength within the analyzed evidence; neither is a disease probability or a diagnosis. Do not present catalog clinical correlation as evidence from the user's own records.",
  "Attribute personal history, symptoms, laboratory results, medications, and prior reactions to the user only when the user or an authorized context source supplied them. Catalog cofactors, confounders, cautions, symptom context, and guardrails are general guidance: never restate them as the user's history or experience (for example, a general caution about starting a supplement abruptly is not 'given your history of reacting poorly'). Keep any user context separate from genetic evidence, and never send personal history to Mutant for personalization.",
  "Pattern-led support describes how support was calculated, not that it is broadly distributed. Use the canonical support_architecture dominant driver, its contribution share, and participating-variant counts; a single-marker dominant pattern is concentrated evidence, not broad marker support.",
  "Keep coverage scopes separate: marker-call completeness (assessment.marker_coverage), pattern evaluability, and hypothesis assessability (assessment.assessability). A missing marker does not make an assessment unusable, and a qualifying match does not erase a material gap.",
  "Keep labs, symptoms, and medical history in the conversation; send only catalog-topic keywords to search tools.",
  "Analysis lifecycle states (not ready, processing, plan-limited, scope-limited, hypothesis not found, empty evidence, regeneration required, rate limited, snapshot changed) arrive as structured errors with a next_action. Follow next_action.tool instead of retrying the same call.",
  "Fetch context again before combining results that report different analysis_version values.",
  "Respect access limits reported by the server; locked results are returned as structured errors.",
].join(" ");

/**
 * Builds a fresh, fully-configured MCP server for a single request. The user
 * context is captured in tool closures so identity can never be spoofed via
 * tool arguments. Stateless by design: no state is shared across requests.
 */
export function createMcpServer(
  ctx: MutantUserContext,
  config: AppConfig,
  requestId = "unknown",
  client?: MutantBackendClient,
  logger?: AppLogger,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // The DNA import Apps SDK component is served as an MCP resource, so the
        // server must advertise the capability or a host will not request it.
        resources: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, ctx, config, client, requestId, logger ?? silentLogger());
  registerDnaImportUi(server, config);
  registerAnalysisFollowupsUi(server, config);
  return server;
}

/**
 * Fallback logger for callers that do not pass one (tests, embedding). Tool
 * handlers always log; this keeps that unconditional without a null check.
 */
function silentLogger(): AppLogger {
  return {
    child: () => silentLogger(),
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  } as unknown as AppLogger;
}

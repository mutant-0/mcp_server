import type { ToolResponse } from "../contract.js";
import { withSuggestedPrompts } from "../presentation/prompts.js";
import { withValidatedPlanNotice } from "../presentation/plan-notice.js";
import { explainHealthHypothesisInputSchema, explainHypothesisOutputSchema } from "../schemas/index.js";
import { respond } from "./respond.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "./types.js";

export const explainHealthHypothesisTool: MutantToolDefinition = {
  name: "explain_health_hypothesis",
  title: "Explain Health Hypothesis",
  description:
    "Scoring v3.4 uses only scoped module evidence and retained storm support, counting shared evidence once. Converging patterns explain relationships without a separate ranking bonus; perfect storms can contribute support. Use the saved components for historical reports, which may include a converging-pattern bonus. Confidence modulates genetic priority; Evo 2 remains an adjustment to existing weights, not independent evidence. " +
    "Explain one ranked Mutant finding. Use when the user asks what a finding means, why it " +
    "ranked, how strong it is, what supports it, what would strengthen or weaken it, or asks " +
    'questions such as "What is the B12 one?" or "Explain my #1 finding." Returns a concise, ' +
    "grounded explanation: what it means, why it appeared (evidence architecture and ranking), " +
    "and what could clarify it (the interpretation boundary, any material data gap, and at most " +
    "two primary confirmation checks). Explain the support architecture before individual genes " +
    "or variants. Pattern-led support describes how support was calculated, not that it is " +
    "broadly distributed; use the dominant driver, its share, and participating-variant counts " +
    "rather than implying breadth. Support is specific to this hypothesis's declared mechanism " +
    "and qualifying relevant markers, not every variant in a linked module. Genetic confidence " +
    "reflects marker coverage and evidence quality, independently of risk direction. A provisional " +
    "storm is a partial rule match, not a complete pattern or independent proof; disclose missing " +
    "markers as unmeasured, never as non-risk or supporting calls, and do not count a shared marker " +
    "twice. Use get_supporting_evidence when the user asks for detailed " +
    "modules, patterns, variants, sources, tests, or exact scores. " +
    "Personal history, symptoms, laboratory results, medications, and prior reactions may be " +
    "attributed to the user only when the user or an authorized context source supplied them; " +
    "catalog cofactors, confounders, cautions, and guardrails are general guidance and must " +
    "never be restated as the user's history or experience. Keep genetic findings distinct " +
    "from symptoms or test results the user has not reported. Use priority_score to order " +
    "investigations and genetic_support for hypothesis-specific strength within the analyzed " +
    "evidence; neither estimates disease probability. An exact ClinGen condition curation can " +
    "strengthen the evidence assessment only when the variant and inheritance fit this claim; " +
    "a related condition curation is context and cannot validate a different functional claim. " +
    "ClinGen curation alone does not create user-specific genetic support. Name non-ClinGen " +
    "evidence by its actual cited source, such as a human association or replication cohort, " +
    "functional assay, clinical phenotype study, or ancestry study. Well-supported functional " +
    "claims can have strong evidence without ClinGen curation; never imply a curation or " +
    "independent validation that the stored citations do not show. For an Explain request, when " +
    "the saved result says Evo 2 weighting " +
    "reached this finding's score (hypothesis.evo2.affected_score and explanation.evo2_note), " +
    "briefly explain what Evo 2 is: a research AI model trained on DNA sequences. Mutant uses " +
    "precomputed, modeled sequence-context estimates to adjust the existing weights of selected " +
    "SNPs " +
    "before calculating its internal score. Use the returned How Evo 2 was used summary; " +
    "do not present the model estimate as an observed effect, independent proof, or a disease-risk " +
    "estimate, and never turn " +
    "the weight multiplier into a risk percentage. Only when the request itself asked to explain this finding (by rank " +
    "or name, including a deliberate \"Explain\" click), when the host supports Apps SDK UI, " +
    "call show_analysis_followups once with the same analysis_version and this hypothesis id so " +
    "the card can offer the next question; do not call it when this tool was supporting " +
    "research for an open-ended topic or symptom question. Keep the explanation itself in the " +
    "conversation and do not restate the card.",
  scope: "analysis.read",
  inputSchema: explainHealthHypothesisInputSchema,
  outputSchema: explainHypothesisOutputSchema,
  annotations: readOnlyAnnotations,
  handler: async (args, runtime) => {
    const response: ToolResponse = await runtime.client.invoke(
      "explain_health_hypothesis",
      args,
      runtime.user,
      runtime.requestId,
    );
    return respond(
      withSuggestedPrompts(withValidatedPlanNotice(response, runtime.config), "explain_health_hypothesis"),
      runtime,
      { operation: "explain_health_hypothesis" },
    );
  },
};

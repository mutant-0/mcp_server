# Mutant MCP contract (2.0.0)

This document describes the implemented contract between the MCP Lambda
(`mutant-mcp`) and the report-generator backend (`report-generator/mcp`). The
backend is authoritative for every business rule and returns the typed `data`
shapes; the Lambda is a thin, authenticated transport that adds only the
MCP-facing presentation (`content`, `suggested_prompts`, widget `_meta`).

Version 2.0.0 is a breaking revision. The detail tool is named
**`explain_health_hypothesis`** (there is no `get_hypothesis_details` alias).

## Transport and authentication

- MCP Streamable HTTP (JSON responses), stateless.
- OAuth 2.1 authorization code with PKCE `S256`.
- `GET /.well-known/oauth-protected-resource[/<resource-path>]` and `GET [<mount>]/.well-known/oauth-protected-resource[/<resource-path>]` — RFC 9728 protected-resource metadata. The custom domain maps `.well-known` to this API, so the document resolves at the host root as well as under the mount key. RFC 9728 locates the document at the resource origin, not by suffixing the resource URI: for resource `https://dev-api.mutantbiotech.com/mcp` the canonical URL is `https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp`, and that is the exact URL the `401` challenge advertises. `authorization_servers` lists the MCP host origin — the origin that serves the RFC 8414 document — **not** the Cognito issuer, whose custom domain `404`s the well-known path.
- `GET /.well-known/oauth-authorization-server` and `GET [<mount>]/.well-known/oauth-authorization-server` — authorization-server metadata mirrored from the Cognito OIDC discovery document (ensures `code_challenge_methods_supported: ["S256"]`). Its `issuer` is the MCP host origin, matching the origin serving the document; `authorization_endpoint`/`token_endpoint` remain on the Cognito custom domain, and token `iss` claims are still validated against `MUTANT_OAUTH_ISSUER`.
- Requests without a valid token receive `401` with a `WWW-Authenticate: Bearer resource_metadata="…", error="…", error_description="…"` challenge. A token missing the scope a tool requires receives `403` with `error="insufficient_scope"`.
- Tokens are verified for signature, issuer, expiry, `token_use == "access"`, authorized `client_id`, required scope, and (when the issuer emits one) the resource indicator.
- Identity is `sub` only. **No tool accepts an analysis id, account, or plan.**

### Scopes

One bearer token authorizes one connection, and the connection serves both the
analysis tools and the DNA import flow. Two scopes are supported, and **scope
authorization happens per tool** (see `src/tools/scope-guard.ts`):

| Scope | Granted tools |
|---|---|
| `<resource>/analysis.read` | the seven analysis tools |
| `<resource>/dna.import` | `show_dna_import`, `get_snp_catalog`, `create_report` |

Both are advertised in protected-resource metadata, authorization-server
metadata, every `WWW-Authenticate` challenge, and each tool's
`_meta.securitySchemes`. A token must carry at least one of them to reach the MCP
endpoint; calling a tool whose scope is absent returns `INSUFFICIENT_SCOPE` with
`error.required_scope` set, and the tool-level `_meta["mcp/www_authenticate"]`
challenge advertises that scope so the host re-consents instead of failing
opaquely. `dna.import` is deliberately separate from `analysis.read` because
importing DNA creates user data.

## Envelope

Every tool returns the same envelope as `structuredContent`, plus a single text
content block that summarizes it. `isError` is set from `ok`.

```json
{
  "contract_version": "2.0.0",
  "analysis_version": "rev42-v3.0.0",
  "ok": true,
  "data": { "…": "tool-specific" },
  "error": null
}
```

```json
{
  "contract_version": "2.0.0",
  "analysis_version": null,
  "ok": false,
  "data": null,
  "error": {
    "code": "PLAN_ACCESS_REQUIRED",
    "message": "This request is outside your Free top-three analysis.",
    "retryable": false,
    "required_plan": "mutant_full",
    "upgrade_url": "https://mutantgenomics.com/cart"
  }
}
```

### `content` is a deterministic summary, not a JSON mirror

The single text block is assembled from the typed `data` by
`src/presentation/content.ts`, one builder per tool, within the contract's
per-tool budgets (status ≈ 80–500 chars; context ≈ 400–1,200; list ≈ 150–900;
details ≈ 700–2,500; evidence/genetic context ≈ 300–2,000). It **never**
serializes `structuredContent`, never leaks the envelope, and never contains
genotypes except where the tool legitimately returns markers
(`get_genetic_context`). Human-facing scores are rounded in prose; full
precision stays in `data`. Errors render as a short code/message/next-action
block without the envelope.

### `_meta` is widget-only

`_meta` carries only the auth challenge (`mcp/www_authenticate`), the Apps SDK
UI descriptor, the security schemes, and widget hydration state (currently
`mutant.mode` for `show_dna_import`). No tool data, genotypes, or account state
is placed in `_meta`.

`analysis_version` is opaque. It changes when returned content changes
(account cache revision + scoring config version). Clients that cache must
compare it and refetch context before mixing versions.

## Prompt suggestions

`get_analysis_status`, `get_analysis_context`, and `explain_health_hypothesis`
add a `suggested_prompts` array to their `data`
(`src/presentation/prompts.ts`). Each entry is:

```json
{
  "id": "why-refresh",
  "label": "Why refresh?",
  "prompt": "Why is a refreshed analysis available, and what might change?",
  "intent": "regeneration"
}
```

- At most **five**, ordered by likely usefulness.
- State-aware: DNA missing (import format/privacy), ready (overview/explain/
  compare/clinician), processing (what happens next), regeneration available
  (why refresh / start refresh), analysis context (explain #1 / compare top
  three / compare with medical records shared in the chat, plus compare-all
  for Full or a Full-scope prompt for Free accounts with locked findings),
  hypothesis detail (why ranked / evidence /
  confirmation / what changes it / clinician).
- `prompt` is exact user-visible natural language. It must never contain an
  internal command, a tool name, or a raw hypothesis id. `explain_health_hypothesis`
  suggestions may carry a `hypothesis_id` **field** for the host's convenience,
  but it is never embedded in the prose.
- These fields are added at the MCP boundary, not by the backend. The backend
  owns the typed facts; the Lambda owns the presentation.

## Tools

Each tool maps to a distinct user goal. The routing contract is:

| Tool | Responsibility |
|---|---|
| `get_analysis_status` | Establish connection, DNA readiness, analysis readiness, entitlement, and regeneration state. |
| `show_analysis_overview` | Open the ready-analysis Apps SDK card with accessible findings and hints. |
| `get_analysis_context` | Supply interpretation rules, boundaries, access scope, compact top-hypothesis preview, and useful next questions for specific analysis questions. |
| `list_health_hypotheses` | Browse, search, sort, paginate, and compare accessible hypotheses. |
| `explain_health_hypothesis` | Explain one hypothesis in depth. |
| `get_supporting_evidence` | Expand one evidence category for one hypothesis. |
| `get_genetic_context` | Answer marker-, gene-, or module-level questions. |

Call `get_analysis_status` first. For a general overview when the analysis is
ready, call `show_analysis_overview` and let the card present results. For a
specific question, call `get_analysis_context` after status reports ready, then
use `list_health_hypotheses` for subsequent
browsing, searching, sorting, pagination, and comparison; use
`explain_health_hypothesis` or `get_supporting_evidence` for a single finding.

### `get_analysis_status`

Input: `{}`. A successful call even with no analysis.

```json
{
  "dna_status": "missing",
  "analysis_status": "unavailable",
  "entitlement": {
    "plan": "mutant_free",
    "hypothesis_scope": "top_3",
    "genetic_context_scope": "hypothesis_markers"
  },
  "capabilities": {
    "clinical_correlation": true,
    "supporting_evidence": true,
    "search_all_hypotheses": false,
    "independent_genetic_exploration": false
  },
  "regenerate": false,
  "next_action": {
    "tool": "show_dna_import",
    "reason": "DNA data is required before an analysis can be generated."
  },
  "upgrade": { "label": "Unlock Full Analysis", "url": "https://mutantgenomics.com/cart" }
}
```

- `dna_status` is `missing | available`. `missing` means no DNA data has been
  received, so `show_dna_import` is the next action.
- `analysis_status` is `unavailable | processing | ready | failed`. The internal
  `none` maps to `unavailable`; every in-flight word (`queued`, `pending`,
  `running`, `in_progress`) maps to `processing` so an analysis that exists is
  never reported as no DNA data.
- `entitlement` is the effective plan and scope.
  `genetic_context_scope` is `hypothesis_markers` for Free and
  `all_analyzed_markers` for Full. `access_expires_at` is present only when
  access is scheduled to end (never a renewal date).
- `capabilities` mirrors the plan's feature gates.
- `regenerate` is **always present**, `true` only when the platform/catalog/
  scoring revision is newer than the account's. It is never inferred from the
  mere existence of a report.
- `analysis` is present whenever an analysis exists:
  `{ "generated_at": …, "scoring_engine_version"?: …, "catalog_version"?: … }`.
  The version fields are resolved lazily only for a ready analysis.
- `next_action` is an object `{ tool, reason, arguments? }` (a `ToolAction`):
  `show_dna_import` when DNA is missing, `get_analysis_context` when ready,
  `get_analysis_status` while processing, and `show_dna_import` with
  `arguments: { mode: "regenerate" }` when a required refresh is the only path.
  The MCP presentation uses `show_analysis_overview` for an initial ready-state
  overview; the backend's `next_action` remains unchanged for data exploration.
- `optional_actions` is present when regeneration is available but **not
  required**: a list of `ToolAction`s the user may choose (currently the
  `show_dna_import` refresh).

When a refresh exists (`regenerate: true`), `regeneration` is included:

```json
{
  "recommended": true,
  "required": false,
  "reason_code": "platform_update",
  "reason": "A newer analysis pipeline can evaluate additional patterns.",
  "requires_dna_resubmission": true,
  "current_results_usable": true,
  "current_analysis_version": "rev41-v3.0.0",
  "action": {
    "tool": "show_dna_import",
    "reason": "Refresh the analysis with the newer platform.",
    "arguments": { "mode": "regenerate" }
  }
}
```

- `required` is `true` and `current_results_usable` is `false` when the current
  analysis `failed`, so resubmission is the only path.
- `reason_code` is `platform_update` today. The other contract reason codes are
  reserved and are not reported until the engine can justify them.
- `requires_dna_resubmission` is always `true`: the platform cannot rescore a
  stored raw file the account no longer holds.

While `analysis_status` is `processing`, the DNA import component polls this
tool itself (about every 7 seconds, up to 10 minutes) after it creates a report.
The model should not tell the user to keep asking whether processing has
finished, and should not narrate the status while that component is on screen.

### `get_analysis_context`

Input: `{}`. The first analysis tool called after status reports the analysis is
ready. It bootstraps the overall experience: the versioned interpretation
contract, coverage, access scope, a compact preview of the top three hypotheses,
and next-question prompts. It is not a listing tool.

```json
{
  "interpretation_contract": {
    "version": "2.1",
    "purpose": "Mutant returns ranked, genetically supported health hypotheses for exploration and clinical discussion, not diagnoses.",
    "response_rules": ["… (1-6)"],
    "evidence_explanation_rules": {
      "organizing_level": "modules_then_patterns_then_variants",
      "rules": ["… (1-9)"],
      "module_first_instruction": "When explaining a hypothesis, do not begin with a gene or SNP. First state whether support is multi-module, single-module, pattern-led, or concentrated in one locus. Explain the contributing modules and retained patterns next. Mention individual genes and variants only after their actual scoring route is clear. If one driver dominates, disclose that concentration prominently."
    },
    "score_semantics": {
      "priority_score": "…",
      "genetic_support": "…",
      "genetic_evidence": "…",
      "coverage_confidence": "…",
      "pattern_convergence": "…",
      "module_support": "Genetic support from the underlying biological modules.",
      "pattern_support": "Additional retained support from cross-module patterns, comparable to module_support on the same 0-100 scale."
    },
    "evidence_boundaries": {
      "genetics_is_not_diagnosis": true,
      "genetic_support_does_not_establish_current_status": true,
      "clinical_correlation_is_catalog_guidance": true,
      "clinical_correlation_is_not_user_record_evidence": true
    },
    "health_context_usage": {
      "allowed": true,
      "performed_by": "chatgpt",
      "sent_to_mutant": false,
      "purpose": "relevance_filtering"
    },
    "presentation_order": [
      "bottom_line",
      "support_architecture",
      "module_contributions",
      "pattern_contributions",
      "key_scoring_genes_and_variants",
      "interpretation_boundary",
      "minimal_confirmation",
      "strengthening_and_weakening_evidence",
      "action_changing_guardrail"
    ],
    "limitations": ["…", "…"]
  },
  "coverage": { "analyzed_markers": 1240, "classification": "moderate" },
  "access_summary": {
    "plan": "mutant_free",
    "hypothesis_scope": "top_3",
    "total_ranked": 12,
    "returned": 3,
    "unlocked": 3,
    "locked": 9,
    "scope_message": "Your top three ranked hypotheses are fully unlocked. Mutant Full can search 9 additional ranked hypotheses."
  },
  "top_hypotheses": [ /* up to three HypothesisPreview, rank order */ ],
  "upgrade": { "label": "Unlock Full Analysis", "url": "https://mutantgenomics.com/cart" },
  "suggested_prompts": [ /* added by the Lambda, max 5 */ ]
}
```

- `interpretation_contract` is server-owned and versioned (`"2.1"`). It is
  global product behavior, never per-hypothesis catalog prose and never
  LLM-generated. `response_rules` is 1-6 unique strings; `limitations` is 0-4
  unique strings; the boundary flags are literal `true`; `score_semantics` has
  exactly the seven published keys; `presentation_order` is the fixed order
  above.
- `evidence_explanation_rules` is the module-first contract: `organizing_level`
  is `modules_then_patterns_then_variants`, `rules` carries the nine presentation
  rules, and `module_first_instruction` is the stable server instruction the
  model must apply to every hypothesis explanation. It is global behavior, not
  per-hypothesis content, and is never echoed into `content`.
- `coverage.classification` is optional.
- `access_summary.hypothesis_scope` is `top_3` for Free and `all` for Full.
  `unlocked` is the count of accessible hypotheses; `locked` is the count the
  current plan cannot reach (zero for Full). `scope_message` states the actual
  scope and never implies the three previews are the whole of a Full analysis.
- `upgrade` is present only for a Free account whose analysis has `locked > 0`.
  Full never receives upgrade messaging.
- Free never exposes locked hypothesis ids, titles, scores, ranks, or tags.

For Full, `scope_message` reads: "Your complete ranked analysis is available.
This response previews the top three; use hypothesis search or listing to
explore the rest."

#### `HypothesisPreview`

The compact preview returned only by `get_analysis_context`:

```json
{
  "id": "RC_A",
  "rank": 1,
  "title": "Alpha",
  "bottom_line": "…",
  "priority_score": 90.0,
  "genetic_evidence": "strong",
  "coverage_confidence": "high",
  "pattern_convergence": "strong"
}
```

- At most three records, in authoritative rank order. Free returns its three
  unlocked hypotheses; Full also receives only the first three here.
- Deliberately narrower than `HypothesisSummary`: no `genetic_support_score`, no
  context tags, and no patterns, variants, tests, sources, or clinical detail.
  The two DTOs are separate types so the context response cannot accumulate
  list-only fields.

#### `HypothesisSummary`

The richer browse/search DTO owned by `list_health_hypotheses`:

```json
{
  "id": "RC_A",
  "rank": 1,
  "title": "Alpha",
  "bottom_line": "…",
  "priority_score": 90.0,
  "genetic_support_score": 80.0,
  "genetic_evidence": "strong",
  "coverage_confidence": "high",
  "pattern_convergence": "strong"
}
```

- `genetic_evidence`, `coverage_confidence`, and `pattern_convergence` pass the
  engine's published vocabulary through unchanged. No thresholds or scores are
  invented.
- `genetic_support_score` is the raw support score; it is intentionally absent
  from `HypothesisPreview`.
- `bottom_line` is the curated `presentation.bottom_line` when present, else the
  catalog `summary` or the hypothesis `user_description`.

#### Model-facing `content`

`get_analysis_context` `content` is deterministic prose, never JSON:

```text
Your DNA analysis is ready and assessed {analyzed_markers} markers. {purpose}

Your highest-ranked findings are:
1. {title} - {bottom_line}
2. {title} - {bottom_line}
3. {title} - {bottom_line}

{scope_message}

{first limitation}

You can ask me to explain one finding, compare the three, or search accessible hypotheses by topic.
```

It carries the readiness/coverage sentence, the access scope, the preview list,
the single most important interpretation boundary, and the next-question line.
It never repeats the full contract, never serializes `structuredContent`, and
stays under ~1,500 characters (titles and bottom lines are bounded).

### `list_health_hypotheses`

Input: `{ query?, limit? (1–20, default 10), cursor? }`. The `module_id` argument
was **removed** in v2. `query` matches hypothesis titles/summaries only.

Output:

```json
{
  "items": [ /* HypothesisSummary[] */ ],
  "next_cursor": "…"
}
```

`next_cursor` is present only when more items remain; there is no `page`
wrapper. Free returns its frozen top three in rank order; Full returns the whole
set.

### `explain_health_hypothesis`

Input: `{ hypothesis_id }`. The explanation-ready projection, with no nested
variant records, no full test records, and no bespoke prose. It is organized
module-first: the server states whether support is broad or concentrated, then
the contributing modules, then retained patterns, then the key scoring drivers.

```json
{
  "hypothesis": {
    "id": "RC_A",
    "rank": 1,
    "title": "Alpha",
    "assessment_state": "assessed",
    "scores": {
      "priority": 90.0,
      "genetic_support": 80.0,
      "coverage": "high",
      "convergence": "strong"
    }
  },
  "explanation": {
    "bottom_line": "…",
    "why_ranked": "It ranked #1 because it has strong genetic support, high coverage and 2 contributing pathway patterns.",
    "interpretation_boundary": "…",
    "top_contributing_patterns": [
      {
        "id": "P1",
        "name": "…",
        "state": "matched",
        "coverage": 0.8,
        "impact_points": 12.5,
        "requires_clinical_confirmation": false,
        "summary": "…"
      }
    ]
  },
  "score_breakdown": {
    "priority_score": 90.0,
    "genetic_support": 80.0,
    "module_support": 40.0,
    "pattern_support": 32.0,
    "converging_pattern_adjustment": 5.0
  },
  "support_architecture": {
    "classification": "locus_concentrated",
    "contributing_module_count": 1,
    "module_scoring_gene_count": 2,
    "module_scoring_variant_count": 2,
    "pattern_participating_gene_count": 2,
    "pattern_participating_variant_count": 2,
    "dominant_driver": {
      "type": "gene",
      "id": "CYP19A1",
      "name": "CYP19A1",
      "contribution_fraction": 0.71
    },
    "summary": "Support is concentrated: CYP19A1 supplies 71% of the retained genetic support."
  },
  "module_contributions": [
    {
      "module_id": "steroid",
      "module_name": "Sex Hormone Transport & Availability",
      "scoring_status": "active",
      "role": "primary",
      "retained_support": 40.0,
      "module_support_fraction": 1.0,
      "module_scoring_gene_count": 2,
      "module_scoring_variant_count": 2,
      "top_scoring_genes": ["CYP19A1", "SHBG"],
      "summary": "Sex Hormone Transport & Availability contributed 40 support points from 2 scoring variants across 2 genes.",
      "caveats": []
    }
  ],
  "pattern_contributions": [
    {
      "pattern_id": "STORM_A",
      "pattern_name": "…",
      "state": "matched",
      "retained_support": 32.0,
      "module_ids": ["steroid"],
      "participating_gene_count": 2,
      "participating_variant_count": 2,
      "summary": "Retained matched pattern with 2 contributing variants."
    }
  ],
  "converging_pattern_contributions": [
    {
      "pattern_id": "CONV_1",
      "state": "observed",
      "structural_fit": 0.9,
      "pattern_confidence": 0.8,
      "contribution": 5.0
    }
  ],
  "clinical_context": {
    "common_cofactors": ["…"],
    "common_confusers": ["…"],
    "subtypes": [{ "name": "…", "distinction": "…" }]
  },
  "confirmation": {
    "primary_checks": [{ "id": "…", "short_name": "…", "role": "…" }],
    "stronger_support": "…",
    "partial_support": "…",
    "weakening_evidence": "…"
  },
  "guardrails": ["…"],
  "related_hypotheses": [{ "id": "RC_B", "title": "…", "relationship": "related" }],
  "suggested_prompts": [ /* added by the Lambda, max 5 */ ]
}
```

- `explanation.why_ranked` is **always** assembled from the live rank, scores,
  and contributing pattern count; it is never stored prose and can never drift
  from the payload.
- `explanation.bottom_line` and `interpretation_boundary` prefer curated
  `presentation` copy, then the catalog, and are omitted when no source exists.
- `explanation.top_contributing_patterns` lists at most three matched or
  provisional patterns, strongest impact first.
- `score_breakdown` carries the retained component scores on the comparable
  0-100 genetic-support scale. It is read from the engine's retained
  `scoring_trace` when present, and falls back to the stored totals for legacy
  analyses.
- `support_architecture`, `module_contributions` (max 3 by retained support),
  and `pattern_contributions` (max 3 by retained support) come from the retained
  `scoring_trace`. They are never reconstructed by the adapter. See
  [Module-aware explanations](#module-aware-explanations).
- `converging_pattern_adjustment` is a separate priority-only family and is
  never summed into `module_support` or `pattern_support`.
- `clinical_context` is bounded (5 / 5 / 4). `subtypes[].distinction` comes from
  the catalog `signature` (falling back to lab/clinical corroboration).
- `confirmation.primary_checks` lists at most two tests in priority order.
  `stronger_support` / `partial_support` / `weakening_evidence` prefer curated
  `presentation` copy, then the tests catalog, and are omitted when absent.
- `guardrails` is deduped and capped at four. `related_hypotheses` appears only
  when the catalog declares related drivers.
- Removed in v2: default `user_context`, `confidence_notes`, `module_context`,
  per-pattern `variants[]`, and full `clinical_correlation` test records. Those
  move to `get_supporting_evidence` (`kind: "tests"` for assay guidance).

### `get_supporting_evidence`

Input: `{ hypothesis_id, kind? ("patterns" | "variants" | "modules" |
"sources" | "tests"), pattern_id?, include_context?, limit? (1–20), cursor? }`.
Defaults to `patterns`.

Output: `{ kind, items, next_cursor?, source_state? }`.

- `patterns` → `PatternEvidence`:

  ```json
  {
    "id": "P1",
    "name": "…",
    "state": "matched",
    "pattern_type": "context_gate",
    "contribution_status": "contributes",
    "impact_points": 12.5,
    "coverage": 0.8,
    "requires_clinical_confirmation": false,
    "summary": "…",
    "marker_ids": ["rs4680"]
  }
  ```

  `contribution_status` is `contributes | context_only | excluded`, mapped from
  the resolved contribution. `marker_ids` are references only (no nested variant
  records) and cover the full pattern. With `pattern_id`, only that pattern is
  returned.

- `variants` → deduped `VariantEvidence`, one row per rsID with all pattern
  memberships nested. A variant's module-scoring role and its pattern
  participation are reported separately (the dual-role model):

  ```json
  {
    "rsid": "rs4680",
    "gene": "COMT",
    "genotype": "AG",
    "call_status": "called",
    "contribution_status": "contributes",
    "module_role": { "status": "contributes", "retained_contribution": 12.5 },
    "pattern_memberships": [
      {
        "pattern_id": "P1",
        "role": "core",
        "pattern_name": "…",
        "pattern_state": "matched",
        "pattern_contributes": true
      }
    ]
  }
  ```

  `call_status` is `called | not_called | not_scored`;
  `contribution_status` is `contributes | context_only | excluded`; membership
  `role` is `core | supporting | context`. `module_role.status` is
  `contributes | no_score_contribution | not_scored | not_assessed`, so a
  zero-weight module variant can still be a retained-pattern participant
  without either role being flattened. A marker in several patterns appears
  once, preferring its called genotype/status. Fields the stored data cannot
  support are omitted rather than invented.

- `modules` → the expanded module scoring trace (the concise module breakdown is
  already in `explain_health_hypothesis`):

  ```json
  {
    "module_id": "histamine",
    "module_name": "Histamine",
    "scoring_status": "active",
    "hypothesis_role": "primary",
    "raw_module_score": 55.0,
    "hypothesis_weight": 1.0,
    "retained_support": 40.0,
    "module_support_fraction": 1.0,
    "module_scoring_gene_count": 1,
    "module_scoring_variant_count": 1,
    "summary": "Histamine contributed 40 support points from 1 scoring variant across 1 gene.",
    "caveats": [],
    "scoring_drivers": [
      {
        "rsid": "rs11558538",
        "gene": "HNMT",
        "module_contribution_status": "contributes",
        "retained_contribution": 40.0,
        "pattern_memberships": [{ "pattern_id": "STORM_A", "pattern_name": "…", "role": "core" }]
      }
    ]
  }
  ```

  Scoring drivers are returned by default. Contextual, non-contributing markers
  are returned only with `include_context: true`, under `contextual_markers`;
  they are never presented as module score drivers. No genotypes or full variant
  effect detail are nested here — those stay behind `kind: "variants"`.

- `tests` → `TestEvidence` (the only place full assay guidance is returned):

  ```json
  {
    "id": "ferritin",
    "name": "Ferritin",
    "purpose": "…",
    "interpretation_notes": ["…"],
    "limitations": ["…"]
  }
  ```

- `sources` → stored citation records
  (`id`, `title`, `publisher_or_journal`, `year`, `type`, `key_points`, `url`);
  `source_state: "not_provided"` when the catalog has none. Sources are never
  synthesized. These records are returned as stored: no publisher/identifier
  fields are invented where the library has none.

Access before expansion: a Free request for a locked hypothesis returns
`PLAN_ACCESS_REQUIRED` (indistinguishable from a nonexistent hypothesis). An
unknown `pattern_id` returns `PATTERN_NOT_FOUND`.

### `get_genetic_context`

Input:
`{ hypothesis_id?, module_id?, gene?, rsids?, include_modules?, limit? (1–50),
cursor? }`.

- Free: `hypothesis_id` is required (`HYPOTHESIS_SCOPE_REQUIRED` otherwise) and
  must be accessible; selectors are limited to that hypothesis's stored evidence.
- Full: at least one of `hypothesis_id`, `module_id`, `gene`, or `rsids` is
  required.

Output:

```json
{
  "markers": [ /* VariantEvidence, deduped by rsID */ ],
  "modules": [ /* only when include_modules is true or module-scoped */ ],
  "next_cursor": "…"
}
```

- Markers are aggregated by rsID: the former `(rsid, module_id, pattern_id)`
  dedupe is replaced by one row per rsID carrying a single nested
  `pattern_memberships` list. When a hypothesis scopes the call and a retained
  trace exists, each row also carries `module_role`, mirroring
  `kind: "variants"`.
- `modules` summarises module support and is returned only when
  `include_modules` is true or the request is module-scoped. Each row carries
  `score_state` (`scored | not_scored | retired`) and `score`. When a hypothesis
  scopes the call, the row also carries the relationship (`role`,
  `effective_role`, `role_group` of `base | supporting | context`, `weight`,
  `genetic_confidence`, `anchor`, `contributes`) plus `support` and
  `contribution_pct`. `context` modules are explanatory and report
  `support = 0` even when they have their own `score`.
- The v1 top-level module-support totals
  (`combined_module_support`, `module_base_support`, `module_supporting_lift`)
  are no longer part of `data`; the widget derives what it needs from `modules`.

## DNA import

Three DNA import tools and one shared UI resource. The raw DNA file is parsed in the user's browser;
only catalog-matched variants are submitted. The MCP layer adds no genetics: it
validates shape and size, forwards the payload with a server-derived identity, and
returns a narrowed response.

### `show_analysis_overview`

Input: `{}`. Scope `analysis.read`. No backend call. This MCP-only display tool
mounts the shared Apps SDK card when a ready analysis is opened for a general
overview. Its result contains only `{ "ui_rendered": true, "mode": "overview" }`
and the UI descriptor. The card reads current status, then loads accessible
findings and the context hints automatically. The model should let the card
present these results rather than repeating the context preview in prose.

### `show_dna_import`

Input: `{ mode?: "initial" | "regenerate" }`. Scope `dna.import`. No backend call.

The model calls this immediately whenever `get_analysis_status` reports
`dna_status="missing"`. It calls it with `mode: "regenerate"` only when
regeneration is required or the user explicitly asks to refresh. The mode never
triggers a resubmission by itself.

Visibility `["model", "app"]`. The result carries **no** routing state, no
genetic data, and no account state, because the component reads the authoritative
state itself on mount:

```json
{ "ui_rendered": true, "mode": "initial" }
```

The selected mode is echoed in the typed data and in widget-only
`_meta.mutant.mode`. That is deliberate: any status echoed here would be stale
the moment the user picks a file, and the model would have to reconcile it.
After calling this tool the model must not restate DNA status, analysis status,
or import instructions.

The component reads the mode back from the result (`data.mode`) and, for
`regenerate`, opens the DNA resubmission flow rather than the ready card. That is
what makes a refresh terminate: the mode is the one piece of routing state the
component needs, and it must be honored in a host that updates the running view
as well as in one that mounts a fresh one.

The result and the tool descriptor both carry the UI descriptor, so a host can
mount the component from either:

```json
{
  "ui": { "resourceUri": "ui://mutant/dna-import/v1.html", "visibility": ["model", "app"] },
  "ui/resourceUri": "ui://mutant/dna-import/v1.html",
  "openai/outputTemplate": "ui://mutant/dna-import/v1.html"
}
```

### `get_snp_catalog`

Input: `{}`. Scope `dna.import`. Visibility `["app"]` only — it is callable from
the component but hidden from the model's tool list, because the catalog is
application data, not model context. Proxies `operation: "get_snp_catalog"` and
returns the catalog **unchanged** under `data` (no summarizing, no filtering).

The catalog is allowed a larger response than the default cap
(`MUTANT_SNP_CATALOG_MAX_BYTES`, default 2 MB). Oversize responses map to
`RESPONSE_TOO_LARGE`; upstream transport failures map to `CATALOG_UNAVAILABLE`
(`app_code: "catalog_unavailable"`, `retryable` carried over). Logs record
version, byte size, and marker count — never catalog contents.

### `create_report`

Input: `{ snps, wgs_variant_calls?, upload_meta?, analysis_context?, report_id?, import_request_id }`.
Scope `dna.import`. Visibility `["app"]`. Write annotations
(`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`).

The schema uses `z.strictObject` so identity-bearing or scoping fields
(`account_id`, `user_id`, `email`, `sub`, `analysis_id`) are **rejected** as
`INVALID_ARGUMENT` rather than silently ignored. Identity always comes from the
verified token.

- `snps`: `{ "^rs\\d+$": "^[ACGT]{2}$" }`, at most 20 000 entries.
- `wgs_variant_calls`: `{ rsID: { schema_version, source_format, genome_build, records[] } }`, at most 500 entries, at most 1 000 records each. Records stay opaque: no variant semantics are re-implemented here.
- `upload_meta`: `{ provider, file_name, file_size_bytes }` — provenance only.
- `analysis_context`: optional, request-only `{ sex_chromosome_pattern?: "XX"|"XY"|"unknown"|"ambiguous", sex_chromosome_confidence?: "high"|"medium"|"low"|"unknown" }` (strict nested object; unknown nested keys are rejected). The component sends it only for a **high-confidence** `XX`/`XY` detection. The backend consumes it in memory while evaluating sex-specific perfect-storm conditions and **never** persists, caches, queues, logs, traces, or echoes it; both the raw context and any normalized sex value are discarded after scoring. A missing or non-high-confidence context is treated as unknown.
- `report_id`: optional report selector slug; omit to target the account's primary report. Not an identity claim.
- `import_request_id`: 8–128 character idempotency key, generated once per import attempt. The backend enforces idempotency on `(user_id, import_request_id)`, so a retry returns the existing analysis instead of creating another.

Handlers run in this order: request-size cap (`MUTANT_MAX_REQUEST_BYTES`, default
5 MiB — below the 6 MiB synchronous `lambda:InvokeFunction` ceiling) →
`PAYLOAD_TOO_LARGE`; then `operation: "create_report"`; then a response narrowed
to `{ analysis_id, status }`. Genotypes are never echoed back. Logs record counts,
byte sizes, `import_request_id`, `analysis_id`, upstream status, and duration —
never the payload and never `analysis_context`.

Upstream failures are remapped to the component-facing codes below so the UI does
not parse backend messages.

### UI resource `ui://mutant/dna-import/v1.html`

This URI is deliberately **stable and unversioned**. ChatGPT resolves a widget
through a stored template snapshot keyed by the template pointer, so changing the
URI does not bust a CSS cache — it makes the app hard-fail with
`Failed to fetch template` (`{"detail":"HTML asset not found"}`) until OpenAI
re-ingests the template. Layout and CSS changes therefore ship inside the same
document under this one URI.

Served by `resources/read` as a single self-contained `text/html;profile=mcp-app`
document, identical for every authenticated account. Its `_meta.ui.csp` is
**empty**: the component has no document origin to load assets from and reaches
the server only through the host bridge (`tools/call`), so it declares neither
`connectDomains` nor `resourceDomains`. The raw DNA file never leaves the iframe.

The component (`src/ui/dna-import/main.tsx` mounts `app.tsx`) owns the whole
asynchronous lifecycle. On mount it calls `get_snp_catalog` and
`get_analysis_status` in parallel, which is how a rerender or a reopened panel
resumes an in-flight analysis instead of starting a new one: `processing` opens
the progress card and resumes polling, `ready` opens the completion card, and
`failed` opens the recovery card. It parses the selected file with the vendored
shared processor (`src/ui/dna-import/parseFile.ts` over `src/ui/genomics/*`, synced
from `front-end-web/src/genomics`), filters to catalog-matched variants, and
submits via `create_report` with one `crypto.randomUUID()` per attempt.

After a successful `create_report` the component polls `get_analysis_status`
itself (about every 7 seconds, up to 10 minutes) and stops on `ready`, `failed`,
unmount, a new import, or the ceiling. It shows an elapsed timer measured from
`created_at` (falling back to its own clock), never a countdown, percentage, or
estimated time remaining.

When the analysis is ready the same card becomes the completion view, offering
either `View my top 3 findings`, which calls `list_health_hypotheses` from the
component and renders the summaries inline, or `Ask ChatGPT about my results` /
`Explain this finding`, which hand off to ChatGPT only when the user asks for
interpretation. The handoff is feature-detected and delivered as a real
follow-up turn, never rendered inside the card: on ChatGPT it uses
`window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true })`, on
MCP Apps hosts it uses the `ui/message` bridge (`App.sendMessage`), and when
neither is available (or the host rejects it) the card shows a user-visible error
instead. It applies the host's theme and CSS variables (`useHostStyles`).

Two v2 additions to the completion view:

- **Prompt chips.** After loading findings, the component fetches
  `get_analysis_context` and renders its `suggested_prompts` as chips. Clicking
  one sends the exact `prompt` prose through the same host follow-up path. The
  chip label is shown; the prose is never rendered inside the card. Free accounts
  with an upgrade URL from the status or context response also see an
  `Upgrade to Mutant Full` action that asks the host to open that URL.
- **Refresh banner.** When `get_analysis_status` reports `regenerate: true` with
  a usable current analysis, the card shows a refresh banner explaining that the
  current results remain usable and why resubmission is requested. Choosing the
  refresh action renders the component with `mode: "regenerate"`; the component
  reads that mode from the `show_dna_import` result and opens the DNA
  resubmission flow instead of the ready card, so the refresh is never re-offered
  in a loop. A required refresh (failed analysis) is handled by the recovery card
  instead.

Because `_meta.ui.csp` cannot declare `worker-src`, parsing prefers a Web Worker
started from a `blob:` URL and falls back to the same parser on the main thread if
the host's composed `script-src` blocks it. The document is therefore built in two
esbuild passes (`scripts/build-ui.mjs`): the worker as its own IIFE, inlined into
the component as a string. No CSP domain is added for either path, and the
document stays self-contained at roughly 650 KB (of which ~14 KB is the worker).

## Pagination

`list_health_hypotheses`, `get_supporting_evidence`, and `get_genetic_context`
paginate with an opaque `next_cursor` returned alongside the items (no `page`
wrapper). Cursors are HMAC-signed and bound to the account, analysis version,
tool, normalized selectors, page size, effective access scope, and an expiry.
They never contain raw account ids or findings.

- A cursor from a different analysis returns `ANALYSIS_CHANGED`.
- A tampered, expired, or selector-mismatched cursor returns `INVALID_CURSOR`.

## Error codes

The v2 envelope keeps the existing specific error vocabulary. Only
`get_analysis_status` uses the object-shaped `next_action`/`optional_actions`
(in `data`); the `error.next_action` string field is unchanged.

| Code | Meaning |
|---|---|
| `AUTHENTICATION_REQUIRED` / `INSUFFICIENT_SCOPE` | Transport-level OAuth failures. |
| `ACCOUNT_NOT_AVAILABLE` | The connected account cannot be served. |
| `ANALYSIS_NOT_FOUND`, `ANALYSIS_NOT_READY`, `ANALYSIS_FAILED` | No / pending / failed analysis. |
| `ANALYSIS_CHANGED` | Cursor bound to a different analysis version. |
| `PLAN_ACCESS_REQUIRED` | Free request outside the top three (includes `required_plan` + `upgrade_url`). |
| `HYPOTHESIS_SCOPE_REQUIRED` | Free `get_genetic_context` without an accessible hypothesis. |
| `HYPOTHESIS_NOT_FOUND`, `PATTERN_NOT_FOUND` | Unknown id within the accessible scope. |
| `INVALID_ARGUMENT`, `INVALID_CURSOR` | Bad input / cursor. |
| `RATE_LIMITED`, `SERVICE_UNAVAILABLE` | Retryable (`retry_after_seconds`). |
| `DATA_INCOMPATIBLE`, `RESPONSE_TOO_LARGE` | Saved data cannot be safely projected / response cap hit. |
| `PAYLOAD_TOO_LARGE` | `create_report` payload exceeded `MUTANT_MAX_REQUEST_BYTES`. |
| `CATALOG_UNAVAILABLE` | `get_snp_catalog` could not reach the backend; retryable. |
| `INVALID_DNA_PAYLOAD` | Submitted variants failed backend validation. |
| `UNSUPPORTED_FORMAT` | The backend does not accept the submitted source format. |
| `UNSUPPORTED_GENOME_BUILD` | Sequencing input used a build the backend cannot place. |
| `REPORT_GENERATION_FAILED` | Analysis creation failed after the payload was accepted. |

The component-facing codes (`error.app_code`, from `APP_ERROR_CODES`) map onto
these with stable lowercase names: `unauthorized`, `insufficient_scope`,
`payload_too_large`, `catalog_unavailable`, `invalid_dna_payload`,
`unsupported_format`, `unsupported_genome_build`, `report_generation_failed`, and
`service_unavailable` (the fallback).

`ANALYSIS_NOT_READY` additionally carries `error.reason`, because one code covers
two conditions with opposite remedies. A regeneration bumps the account revision
when it *starts* but writes the saved causes payload when it *finishes*, so a call
in between sees a pending payload; that clears on its own. A changed scoring
engine never clears without regenerating.

| `error.reason` | Meaning | `retryable` |
|---|---|---|
| `analysis_payload_pending` | No saved payload yet; a regeneration may be running. | `true` |
| `analysis_payload_stale` | Payload predates the account's latest revision, or its fragments are mid-rewrite. | `true` |
| `analysis_engine_changed` | Payload was produced by a different scoring engine and will never be served. | `false` |
| `analysis_payload_empty` | Saved payload carries no hypotheses. | `false` |
| `analysis_user_version_unavailable` | The account's cache revision could not be read, so the lookup was skipped. | `true` |
| `analysis_cache_unavailable` | The cache read itself failed. | `true` |

The two permanent reasons set `next_action` to the app so the user can regenerate,
and deliberately omit `retry_after_seconds` — polling cannot clear either. The
backend logs the same value as
`[MCP][COLD_CACHE] user=<8 chars> report=<id> reason=<reason>`.

Two further app codes are derived by the DNA import component from the analysis
lifecycle rather than returned by any tool: `analysis_failed` when the analysis
reaches a failed state, and `analysis_timeout` when polling stops without a
terminal state. They let the component classify its recovery states without
surfacing backend exceptions to the user.

## Vocabulary mapping

Engine vocabularies are mapped to the contract's published vocabulary:

| Contract | Engine value |
|---|---|
| `genetic_evidence: weak` | engine `genetic_evidence: limited` |
| `coverage_confidence: low` | engine `coverage_confidence: limited` |
| `pattern_convergence: weak` | engine `pattern_convergence: none` |
| `call_status: not_called` | `missing_genotype` / `unresolved_genotype` / `not_in_analyzed_catalog` |
| `contribution_status: context_only` | `module_score_status: not_scored` |
| `pattern contribution_status: context_only` | pattern requires clinical confirmation without a resolved contribution |
| pattern `state: not_matched` | `not_assessable` / `missing` |
| membership `role: core` | curated `required` / `core` |

`genetic_confidence.level` and `assessment_state` pass through as the engine's
authoritative enums. No scores or thresholds are computed by the MCP layer.

## Module-aware explanations

Hypothesis explanations are pathway-level, not single-SNP. The engine emits a
retained `scoring_trace` per hypothesis; the MCP layer only projects it and
never estimates contributions from raw catalog weights.

### Module-first rule

`get_analysis_context` returns `evidence_explanation_rules`
(`organizing_level: "modules_then_patterns_then_variants"`). ChatGPT must:

1. Start with the plain-English meaning and whether support is broad or
   concentrated.
2. Name the contributing biological modules and their retained support.
3. Name the retained cross-module patterns.
4. Only then mention the individual genes and variants that actually scored, and
   state the route by which each contributed.
5. Disclose a dominant single locus prominently rather than describing it as
   broad pathway convergence.

### Score semantics

`module_support` and `pattern_support` share the same 0-100 genetic-support
scale, so they are directly comparable. `pattern_support` is the engine's
`storm_lift`. The converging-pattern family
(`converging_pattern_adjustment`) is priority-only and must **never** be summed
into either value.

### `SupportArchitecture`

```ts
type SupportArchitectureClassification =
  | "single_locus"
  | "locus_concentrated"
  | "multi_gene_single_module"
  | "multi_module"
  | "pattern_led"
  | "unknown";

interface SupportArchitecture {
  classification: SupportArchitectureClassification;
  contributing_module_count?: number;
  module_scoring_gene_count?: number;
  module_scoring_variant_count?: number;
  pattern_participating_gene_count?: number;
  pattern_participating_variant_count?: number;
  dominant_driver?: {
    type: "module" | "pattern" | "gene" | "variant" | null;
    id: string | null;
    name: string | null;
    contribution_fraction?: number;
  };
  summary: string;
}
```

The classification is deterministic. A gene or variant at or above the
concentration threshold (default 60%) of the final retained support makes the
result `locus_concentrated` (or `single_locus` when it is the only one); a
pattern that dominates makes it `pattern_led`; otherwise the module and gene
counts choose `multi_gene_single_module` or `multi_module`.

### Contribution schemas

```ts
interface ModuleContribution {
  module_id: string | null;
  module_name: string | null;
  scoring_status: "active" | "partially_active" | "context_only" | "retired" | null;
  role: "primary" | "supporting" | "context" | null;
  retained_support: number | null;
  module_support_fraction?: number | null;
  module_scoring_gene_count: number;
  module_scoring_variant_count: number;
  top_scoring_genes: string[];
  summary: string | null;
  caveats: string[];
}

interface PatternContribution {
  pattern_id: string | null;
  pattern_name: string | null;
  state: "matched" | "provisional" | null;
  retained_support: number | null;
  module_ids: string[];
  participating_gene_count: number;
  participating_variant_count: number;
  summary: string | null;
}

interface ScoreBreakdown {
  priority_score: number | null;
  genetic_support: number | null;
  module_support: number | null;
  pattern_support: number | null;
  converging_pattern_adjustment: number | null;
}

interface ConvergingPatternContribution {
  pattern_id: string | null;
  state: string | null;
  structural_fit: number | null;
  pattern_confidence: number | null;
  contribution: number | null;
}
```

A module's `scoring_status` is derived from its catalog, never a display name.
`active` means every positive-weight marker scores; `partially_active` means
part of the catalog is deliberately excluded; `context_only` and `retired`
cannot contribute module support. A contradictory catalog (`retired` /
`context_only` with a nonzero weight, or a declared status disagreeing with the
derived one) fails analysis validation rather than silently contributing.

### Dual-role variants

Module scoring and pattern participation are separate layers for the same
variant. `kind: "variants"` reports both: `module_role`
(`contributes | no_score_contribution | not_scored | not_assessed`) and
`pattern_memberships[]` (with `pattern_name`, `pattern_state`,
`pattern_contributes`). A zero-weight or context-only variant is never a module
scoring driver, but it may still be a retained-pattern participant.

### Examples

Locus-concentrated (one gene dominates a single module):

```json
{
  "classification": "locus_concentrated",
  "contributing_module_count": 1,
  "module_scoring_gene_count": 2,
  "dominant_driver": { "type": "gene", "id": "CYP19A1", "contribution_fraction": 0.71 },
  "summary": "Support is concentrated: CYP19A1 supplies 71% of the retained genetic support."
}
```

Multi-module (broad support spread across pathway modules):

```json
{
  "classification": "multi_module",
  "contributing_module_count": 3,
  "module_scoring_gene_count": 4,
  "dominant_driver": { "type": "gene", "id": "MTHFR", "contribution_fraction": 0.28 },
  "summary": "Support is distributed across 3 contributing modules and 4 scoring genes."
}
```

### Legacy analyses

An analysis generated before the retained trace existed returns the explicit
fallback rather than a reconstructed breakdown:

```json
{
  "support_architecture": {
    "classification": "unknown",
    "summary": "This analysis predates module-contribution tracing. Regenerate it to see the module breakdown."
  },
  "module_contributions": [],
  "pattern_contributions": []
}
```

`score_breakdown` still carries the stored component totals. Nothing in the
adapter fabricates a trace.

### Model behavior evaluations

Run these against both a single-locus and a truly multi-module fixture so the
assistant does not overcorrect by calling every result broad:

| Prompt | Required answer behavior |
|---|---|
| "Explain this finding." | Start with meaning and support architecture, then modules and patterns; do not begin with an SNP. |
| "Which modules caused this to rank?" | Name contributing modules and retained support; distinguish context modules. |
| "Is this mostly one gene?" | Use architecture counts and dominant-driver data. |
| "How much does CYP19A1 contribute?" | Separate module points from pattern participation. |
| "Which SNP is responsible?" | Reject single-SNP framing unless classification is `single_locus`; explain the evidence structure. |

Content assertions: a locus-concentrated result must contain phrases
mechanically equivalent to "support is concentrated" and the dominant gene or
locus name; a multi-module result must name at least two contributing modules
and must not claim one SNP explains the result unless the dominant-driver data
supports it.

### Catalog regression note

The plan's Steroid fixture described a retired-or-active contradiction that does
not match the shipped `modules_v2/steroid.json`. That fixture was treated as
stale; the generic `scoring_status` validation above is the enforcement
mechanism, and the Steroid catalog was intentionally not rewritten.

### OpenAI tool guidance

Tools should map to distinct user goals and return concise, relevant structured
outputs:

- [Define tools](https://developers.openai.com/plugins/plan/tools)
- [Plugin reference](https://developers.openai.com/plugins/reference)

## Interpretation guardrails

`interpretation_contract` (returned at the top of `get_analysis_context`)
carries the purpose, response rules, score semantics, literal evidence
boundaries, and global limitations. It states that scores are model support, not
diagnosis; that genetic support does not establish current status; that missing
calls are not reassuring; that catalog clinical correlation is guidance, not
evidence from the user's records; and that different `analysis_version` values
must not be silently combined. Health-context relevance is performed by ChatGPT
(`performed_by: "chatgpt"`) and is never sent to Mutant.

The static MCP server instructions route tools; they do not replace
`interpretation_contract`. The contract supplies the analysis-specific
interpretation and scope that travel with the current result.

## Acceptance tests

The contract is covered by:

- `report-generator/test/test_scoring_v3_trace.py` — retained module/pattern
  reconciliation, context-only variants excluded from module drivers while still
  allowed as retained-pattern participants, duplicate pattern memberships not
  inflating counts, support-architecture classification boundaries, missing
  fraction handling, and contradictory `scoring_status` rejection.
- `report-generator/mcp/tests/test_mcp_handlers.py` — status v2 shape (including
  mandatory `regenerate: false`), the context interpretation-contract shape
  (version `2.1` incl. `evidence_explanation_rules`), access-summary counts and
  Free/Full upgrade behavior, locked-hypothesis non-leakage, preview-vs-summary
  separation, contract validation (unknown score semantics, non-literal
  boundaries, wrong presentation order, duplicate rules), `kind: "tests"`,
  `kind: "modules"` with and without `include_context`, dual module/pattern
  roles on `kind: "variants"`, the legacy `unknown` fallback, genetic-context
  rsID dedupe with `pattern_memberships`, and the entitlement
  `hypothesis_markers` rename.
- `mutant-mcp/tests/tools.test.ts`, `schemas.test.ts` — ten tools, version,
  input schemas (including `show_dna_import.mode`, the `modules` evidence kind,
  and `include_context`).
- `mutant-mcp/tests/dna-import.test.ts` — status pass-through (no Lambda
  routing shim), prompt injection, `show_dna_import` mode.
- `mutant-mcp/tests/dna-import-ui.test.tsx` — prompt chips and the optional
  refresh banner.
- `mutant-mcp/tests/mcp-server.test.ts` — `modules`/`include_context`
  pass-through and that `structuredContent` is never duplicated into `content`.
- `mutant-mcp/tests/contract-v2.test.ts` — a callable-tool smoke test asserting
  every advertised tool is callable, that `content` is a summary rather than a
  JSON dump, the module-first contract and content order, that the context
  content is rendered from the interpretation contract without echoing it, that
  context prompts follow the access summary, that suggestions are capped at five
  natural-language prompts, and that `_meta` stays widget-only.

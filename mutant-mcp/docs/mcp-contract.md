# Mutant MCP contract (1.0.0)

This document describes the implemented contract between the MCP Lambda
(`mutant-mcp`) and the report-generator backend (`report-generator/mcp`). The
backend is authoritative for every business rule; the Lambda is a thin,
authenticated transport.

## Transport and authentication

- MCP Streamable HTTP (JSON responses), stateless.
- OAuth 2.1 authorization code with PKCE `S256`.
- `GET /.well-known/oauth-protected-resource[/<resource-path>]` and `GET [<mount>]/.well-known/oauth-protected-resource[/<resource-path>]` — RFC 9728 protected-resource metadata. The custom domain maps `.well-known` to this API, so the document resolves at the host root as well as under the mount key. RFC 9728 locates the document at the resource origin, not by suffixing the resource URI: for resource `https://dev-api.mutantbiotech.com/mcp` the canonical URL is `https://dev-api.mutantbiotech.com/.well-known/oauth-protected-resource/mcp`, and that is the exact URL the `401` challenge advertises. `authorization_servers` lists the MCP host origin — the origin that serves the RFC 8414 document — **not** the Cognito issuer, whose custom domain `404`s the well-known path.
- `GET /.well-known/oauth-authorization-server` and `GET [<mount>]/.well-known/oauth-authorization-server` — authorization-server metadata mirrored from the Cognito OIDC discovery document (ensures `code_challenge_methods_supported: ["S256"]`). Its `issuer` is the MCP host origin, matching the origin serving the document; `authorization_endpoint`/`token_endpoint` remain on the Cognito custom domain, and token `iss` claims are still validated against `MUTANT_OAUTH_ISSUER`.
- Requests without a valid token receive `401` with a `WWW-Authenticate: Bearer resource_metadata="…", error="…", error_description="…"` challenge. A token missing the required scope receives `403` with `error="insufficient_scope"`.
- Tokens are verified for signature, issuer, expiry, `token_use == "access"`, authorized `client_id`, required scope, and (when the issuer emits one) the resource indicator.
- Identity is `sub` only. **No tool accepts an analysis id, account, or plan.**

## Envelope

Every tool returns the same envelope as `structuredContent`, plus a single text
content block mirroring it. `isError` is set from `ok`.

```json
{
  "contract_version": "1.0.0",
  "analysis_version": "rev42-v3.0.0",
  "ok": true,
  "data": { "…": "tool-specific" },
  "error": null
}
```

```json
{
  "contract_version": "1.0.0",
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

`analysis_version` is opaque. It changes when returned content changes
(account cache revision + scoring config version). Clients that cache must
compare it and refetch context before mixing versions.

## Tools

### `get_analysis_status`

Input: `{}`.

```json
{
  "analysis": { "status": "ready", "generated_at": "2026-01-01", "refresh_status": "processing" },
  "entitlement": {
    "plan": "mutant_free",
    "hypothesis_scope": "top_3",
    "genetic_context_scope": "accessible_hypotheses",
    "access_expires_at": null,
    "accessible_hypothesis_ids": ["RC_A", "RC_B", "RC_C"]
  },
  "capabilities": {
    "clinical_correlation": true,
    "supporting_evidence": true,
    "search_all_hypotheses": false,
    "independent_genetic_exploration": false
  },
  "upgrade": { "label": "Unlock Full Analysis", "url": "https://mutantgenomics.com/cart" }
}
```

`analysis.status` is `none | processing | ready | failed`. Status is a successful
call even with no analysis. `accessible_hypothesis_ids` is present for Free only.
`access_expires_at` is populated only when access is scheduled to end (never a
renewal date); otherwise it is `null`.

### `get_analysis_context`

Input: `{}`.

Returns `report_generated_at`, `scoring_engine_version`, `scoring_config_version`,
`catalog_version`, `interpretation_contract_version`, `dna_coverage`,
`interpretation_contract`, `limitations`, `selection_scope`, and
`top_hypotheses` (up to three summaries).

### `list_health_hypotheses`

Input: `{ query?, module_id?, limit? (1–50), cursor? }`.

Free returns its frozen top three in rank order; Full returns the whole set.
`query` matches hypothesis titles/summaries only. Items:

```json
{
  "id": "RC_A",
  "rank": 1,
  "title": "Alpha",
  "summary": "…",
  "assessment_state": "assessed",
  "scoring": {
    "priority_score": 90.0,
    "genetic_support": 80.0,
    "genetic_evidence": "strong",
    "genetic_confidence": { "score": 80.0, "level": "strong" },
    "coverage_confidence": "high",
    "pattern_convergence": "strong"
  }
}
```

### `get_hypothesis_details`

Input: `{ hypothesis_id }`.

Returns `{ hypothesis: { …summary, user_context, confidence_notes,
module_context, pattern_summaries, clinical_context, clinical_correlation,
interpretation_guardrails } }`.

- `pattern_summaries[]` carry `contributes_to_score`,
  `contribution_reason`, and `hypothesis_impact_points`. The impact is the
  resolved post-overlap contribution from the saved `storm_calculation`, never
  the per-row pre-combination lift. When an older snapshot lacks the resolved
  contribution, `hypothesis_impact_points` is `null` with
  `contribution_reason: "not_available_in_snapshot"`.
- `clinical_correlation` contains `summary`, `tests[]`, and `interpretation`.
- Questionnaire/phenotype-fit and internal fields (`phenotype_fit`, `driver_type`,
  `genetic_role`, `matched_signals`, `component_scores`) are not exposed.

### `get_supporting_evidence`

Input: `{ hypothesis_id, kind? ("patterns" | "variants" | "sources"), pattern_id?, limit?, cursor? }`.

- `patterns`: pattern summaries; with `pattern_id`, only that pattern.
- `variants`: per-marker contributions (optionally scoped to `pattern_id`), with
  `call_status` (`available | missing_genotype | unresolved_genotype |
  not_in_analyzed_catalog`), `module_score_status`
  (`contributes | no_score_contribution | not_scored | not_assessed`), and
  `status_reason`.
- `sources`: stored citation records; `source_state: "not_provided"` when the
  catalog has none. Sources are never synthesized.

Access before expansion: a Free request for a locked hypothesis returns
`PLAN_ACCESS_REQUIRED` (indistinguishable from a nonexistent hypothesis). An
unknown `pattern_id` returns `PATTERN_NOT_FOUND`.

### `get_genetic_context`

Input: `{ hypothesis_id?, module_id?, gene?, rsids?, limit?, cursor? }`.

- Free: `hypothesis_id` is required (`HYPOTHESIS_SCOPE_REQUIRED` otherwise) and
  must be accessible; selectors are limited to that hypothesis's stored evidence.
- Full: at least one of `hypothesis_id`, `module_id`, `gene`, or `rsids` is required.
- Returns `items[]`, `modules[]` (`score_state: scored | not_scored | retired`,
  `score` null when not scored), and `page`.

## Pagination

`page = { limit, has_more, next_cursor }`. Cursors are HMAC-signed and bound to
the account, analysis version, tool, normalized selectors, page size, effective
access scope, and an expiry. They never contain raw account ids or findings.

- A cursor from a different analysis returns `ANALYSIS_CHANGED`.
- A tampered, expired, or selector-mismatched cursor returns `INVALID_CURSOR`.

## Error codes

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

## Vocabulary mapping

Engine vocabularies are mapped to the contract's published vocabulary:

| Contract | Engine value |
|---|---|
| `genetic_evidence: weak` | `limited` |
| `coverage_confidence: low` | `limited` |
| `pattern_convergence: weak` | `none` |
| pattern `state: not_matched` | `not_assessable` / `missing` |

`genetic_confidence.level` and `assessment_state` pass through as the engine's
authoritative enums. No scores or thresholds are computed by the MCP layer.

## Interpretation guardrails

`interpretation_contract.rules` and `limitations` (also returned at the top of
`get_analysis_context`) state that scores are model support, not diagnosis;
that missing calls are not reassuring; and that different `analysis_version`
values must not be silently combined.

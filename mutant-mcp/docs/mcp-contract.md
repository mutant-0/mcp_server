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
- Requests without a valid token receive `401` with a `WWW-Authenticate: Bearer resource_metadata="…", error="…", error_description="…"` challenge. A token missing the scope a tool requires receives `403` with `error="insufficient_scope"`.
- Tokens are verified for signature, issuer, expiry, `token_use == "access"`, authorized `client_id`, required scope, and (when the issuer emits one) the resource indicator.
- Identity is `sub` only. **No tool accepts an analysis id, account, or plan.**

### Scopes

One bearer token authorizes one connection, and the connection serves both the
analysis tools and the DNA import flow. Two scopes are supported, and **scope
authorization happens per tool** (see `src/tools/scope-guard.ts`):

| Scope | Granted tools |
|---|---|
| `<resource>/analysis.read` | the six analysis tools |
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

Scope denials add two fields so the host can re-consent and the Apps SDK
component can pick a stable branch:

```json
{
  "contract_version": "1.0.0",
  "analysis_version": null,
  "ok": false,
  "data": null,
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "Importing DNA requires the 'https://…/mcp/dna.import' scope. Reconnect Mutant in ChatGPT to grant DNA import access.",
    "retryable": false,
    "next_action": "reauthorize",
    "required_scope": "https://…/mcp/dna.import",
    "app_code": "insufficient_scope"
  }
}
```

`app_code` is the component-facing code (see `APP_ERROR_CODES`). The component
maps the uppercase contract codes onto its own lowercase branches so a host that
ignores `_meta` still gets a usable text fallback.

`analysis_version` is opaque. It changes when returned content changes
(account cache revision + scoring config version). Clients that cache must
compare it and refetch context before mixing versions.

## Tools

### `get_analysis_status`

Input: `{}`.

```json
{
  "dna_status": "missing",
  "analysis_status": "not_started",
  "plan": "Mutant Free",
  "next_action": {
    "tool": "show_dna_import",
    "reason": "DNA data is required before an analysis can be generated."
  },
  "analysis": { "status": "none", "generated_at": null, "refresh_status": null },
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

Status is a successful call even with no analysis. `analysis.status` is
`none | processing | ready | failed`.

The four routing fields are the contract the model acts on:

- `dna_status` is `missing | available`; `missing` means no DNA data has been
  received, so `show_dna_import` is the next action.
- `analysis_status` is `not_started | processing | ready | failed` (`none` maps
  to `not_started`).
- `plan` is the human-readable effective plan (for example `Mutant Free`),
  derived from `entitlement.plan`.
- `next_action` names the tool to call next and why. It is
  `show_dna_import` when `dna_status` is `missing`, `get_analysis_context` when
  the analysis is `ready`, and `get_analysis_status` while an analysis is still
  `processing`.

Until the backend reports these fields authoritatively, the MCP layer derives
them from the raw status payload; a backend-provided value always wins.

`accessible_hypothesis_ids` is present for Free only. `access_expires_at` is
populated only when access is scheduled to end (never a renewal date); otherwise
it is `null`.

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

## DNA import

Three tools and one UI resource. The raw DNA file is parsed in the user's browser;
only catalog-matched variants are submitted. The MCP layer adds no genetics: it
validates shape and size, forwards the payload with a server-derived identity, and
returns a narrowed response.

### `show_dna_import`

Input: `{}`. Scope `dna.import`. No backend call.

The model calls this immediately whenever `get_analysis_status` reports
`dna_status="missing"` — it renders the import UI rather than describing it, so
the model must not tell the user to upload DNA without invoking it.

Visibility `["model", "app"]`. Returns minimal routing state only — no genetic
data and no account state beyond "connected":

```json
{ "account_status": "connected", "dna_status": "missing", "status": "awaiting_file" }
```

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

Input: `{ snps, wgs_variant_calls?, upload_meta?, report_id?, import_request_id }`.
Scope `dna.import`. Visibility `["app"]`. Write annotations
(`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`).

The schema uses `z.strictObject` so identity-bearing or scoping fields
(`account_id`, `user_id`, `email`, `sub`, `analysis_id`) are **rejected** as
`INVALID_ARGUMENT` rather than silently ignored. Identity always comes from the
verified token.

- `snps`: `{ "^rs\\d+$": "^[ACGT]{2}$" }`, at most 20 000 entries.
- `wgs_variant_calls`: `{ rsID: { schema_version, source_format, genome_build, records[] } }`, at most 500 entries, at most 1 000 records each. Records stay opaque: no variant semantics are re-implemented here.
- `upload_meta`: `{ provider, file_name, file_size_bytes }` — provenance only.
- `report_id`: optional report selector slug; omit to target the account's primary report. Not an identity claim.
- `import_request_id`: 8–128 character idempotency key, generated once per import attempt. The backend enforces idempotency on `(user_id, import_request_id)`, so a retry returns the existing analysis instead of creating another.

Handlers run in this order: request-size cap (`MUTANT_MAX_REQUEST_BYTES`, default
5 MiB — below the 6 MiB synchronous `lambda:InvokeFunction` ceiling) →
`PAYLOAD_TOO_LARGE`; then `operation: "create_report"`; then a response narrowed
to `{ analysis_id, status }`. Genotypes are never echoed back. Logs record counts,
byte sizes, `import_request_id`, `analysis_id`, upstream status, and duration —
never the payload.

Upstream failures are remapped to the component-facing codes below so the UI does
not parse backend messages.

### UI resource `ui://mutant/dna-import/v1.html`

Served by `resources/read` as a single self-contained `text/html;profile=mcp-app`
document, identical for every authenticated account. Its `_meta.ui.csp` is
**empty**: the component has no document origin to load assets from and reaches
the server only through the host bridge (`tools/call`), so it declares neither
`connectDomains` nor `resourceDomains`. The raw DNA file never leaves the iframe.

The component (`src/ui/dna-import/main.tsx` mounts `app.tsx`) calls
`get_snp_catalog` on mount, parses the selected file with the vendored shared
processor (`src/ui/genomics/*`, synced from `front-end-web/src/genomics`), filters
to catalog-matched variants, and submits via `create_report` with one
`crypto.randomUUID()` per attempt. It applies the host's theme and CSS variables
(`useHostStyles`) and reads the `show_dna_import` result to open in the
`account_status` / `dna_status` state the host asked for.

Because `_meta.ui.csp` cannot declare `worker-src`, parsing prefers a Web Worker
started from a `blob:` URL and falls back to the same parser on the main thread if
the host's composed `script-src` blocks it. The document is therefore built in two
esbuild passes (`scripts/build-ui.mjs`): the worker as its own IIFE, inlined into
the component as a string. No CSP domain is added for either path, and the
document stays self-contained at roughly 650 KB (of which ~14 KB is the worker).



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

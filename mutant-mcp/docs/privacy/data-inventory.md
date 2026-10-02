# PRIV-01 data inventory

Version: 1.0 (2026-09-30). Backlog item: PRIV-01 step 3 (and step 4, route split).
Scope: Sensitive consumer genetic/health data handled by the Mutant ChatGPT
plugin and the adjacent portal/backend. Field-level and destination-level; no
secrets. Refresh via `discovery-runbook.md`.

Legend for **Retention (observed)**: what the deployed configuration actually
does today, not a commitment. "Indefinite" means no TTL/lifecycle was observed in
`deployment-manifest.md` §7.

## 0. Collection routes (must not be conflated)

| Route | Entry | Raw file leaves device? | What crosses the boundary |
|---|---|---|---|
| **A. Plugin / MCP** | ChatGPT Apps SDK -> `create_report` tool | No. `src/ui/dna-import/app.tsx` parses locally and submits catalog-matched calls. | `snps` (selected calls), optional `wgs_variant_calls` (allowlisted VCF fields only), `upload_meta{provider,source_format,genome_build,file_size_bytes}` (no filename), optional request-only `analysis_context`, `import_request_id` |
| **B. Portal web upload** | `mutantgenomics.com` upload -> `POST /uploads/init` + `POST /reports` | Yes. Raw file goes to S3 `mutantbt-genetic-data/users/<user_id>/…` | Raw file bytes + module SNP maps + report meta |
| **C. Result reads (either)** | Both routes' users call MCP read tools | n/a | Derived findings and, for genotype-detail tools, per-marker genotypes back to ChatGPT |

Route A and Route B are **not** identical in raw-file behavior (backlog step 4):
only Route B stores raw file bytes. Confirm the portal's current entry UI in
PRIV-05; this inventory is based on backend routes and the MCP client.

## 1. Field-level inventory

### Route A — plugin / MCP

| Category | Collection route | Purpose | Account linkage | Storage / cache / log destinations | Recipients | Retention (observed) | Deletion mechanism | Responsible component |
|---|---|---|---|---|---|---|---|---|
| Selected SNP calls (`snps`) | `create_report` after local parse (`app.tsx:1389`) | Scoring / hypotheses | `identity.user_id` from verified token (`mutant-lambda-client.ts`) | DynamoDB `UserGenomics` (report doc `snps_by_module`/`snps`), `Results` caches; derived copies in `Assessments`, `Recommendations` | Backend service; derived forms to ChatGPT | Indefinite (TTL disabled) | `DELETE /reports/{id}` -> `_purge_user_report_data` | MCP -> backend |
| WGS variant records (`wgs_variant_calls`) | `create_report` (`app.tsx:1398`) | Non-SNV capture targets | same | same as SNPs. **PRIV-03:** projected to the normalizer allowlist (`chromosome, position, ref, alts/alt, gt, filter`) at the MCP boundary (`dna-payload.ts`) and again at the backend contract (`contract.py`), so sample labels/INFO/QUAL/GQ/DP/AD/headers never cross. | same | Indefinite | same | MCP -> backend |
| Upload provenance (`upload_meta.provider/source_format/genome_build/file_size_bytes`) | `create_report` (`app.tsx:1390`) | Provenance for the user's records | same | `report_meta.upload_meta` persisted (`routes_reports.py:1501-1561`); `upload_meta` stripped from one response path at `routes_reports.py:771`. **PRIV-03:** the original filename is no longer sent by the plugin (`file_name` stays accepted-but-optional for legacy/portal callers and the MCP handler strips it before transport); it stays in `report_meta` | Backend; may appear in report responses | Indefinite | same | MCP -> backend |
| Inferred sex-chromosome context (`analysis_context`) | `create_report`, only high-confidence XX/XY (`app.tsx:1405`) | Sex-specific storm evaluation | same (transient) | **Request-only**: parsed (`routes_reports.py:1375`) then `del`; never persisted/cached/logged/echoed | Backend in-memory only | n/a | n/a (not stored) | MCP/backend |
| Import idempotency key (`import_request_id`) | `create_report` (`app.tsx:1393`) | De-duplicate retries | same | `Results` row `result_type = dna_import#<id>` (`mcp/wiring.py:313-370`) | Backend | Indefinite | `_purge_user_report_data` (Results prefix) / TTL none | backend |
| Derived findings | read tools over backend | Hypotheses/evidence to ChatGPT | same | `Results` (`causes_response`, `modules#`, `patterns#`), `Assessments`, `Recommendations`, `Status`, `UserGenomics` report doc | **ChatGPT (structuredContent)**, projected onto each tool's declared output schema (`responses/projections.ts`) | Indefinite | same | backend -> MCP |
| Per-marker genotypes | genotype-detail tools (`get_supporting_evidence` `kind: variants`, `get_genetic_context`) | Documented marker-detail task | same | Read from `UserGenomics`/genotype map; returned in `structuredContent` (`outputs.ts:460`); other tools' schemas do not declare `genotype`, so the projection drops it | **ChatGPT** | derived from stored calls | same | backend -> MCP |
| Tool-call audit record | every tool call (`audit.ts`) | Routing evidence / ops | none (opaque `requestId`; no account id) | CloudWatch `/aws/lambda/mutant-mcp-<env>` JSON `event: "tool_call"`: tool, status, `errorCode`, `durationMs`, `requestId`, `argNames` (names only). Argument values only under `MUTANT_TRACE_CAPTURE` in a designated synthetic session (`capture: "synthetic"`) | Internal ops | 30 days | log-group retention only | MCP |
| Exception/error logs | handler failures (`logger.ts`) | Ops | classified only | CloudWatch MCP log group. Thrown errors log a bounded `errorCode` + error name, never the message/stack (`error-classification.ts`); redaction covers tokens + `snps`/`wgs_variant_calls`/`analysis_context`/`upload_meta`/`file_name` as defence in depth | Internal ops | 30 days | retention only | MCP |
| Backend request/response logs | import/result/deletion | Ops | `user_id` truncated to 8 chars in messages | backend log groups (`/aws/lambda/mutant-report-generator`, `dev-…`) | Internal ops | **None (never expire)** | none | backend |

### Route B — portal web upload

| Category | Collection route | Purpose | Account linkage | Storage / cache / log destinations | Recipients | Retention (observed) | Deletion mechanism | Responsible component |
|---|---|---|---|---|---|---|---|---|
| Raw DNA file bytes | `POST /uploads/init` -> S3 | Re-parse / re-run reports | S3 key `users/<user_id>/…` | S3 `mutantbt-genetic-data` (SSE-S3 AES256, versioning off, **no lifecycle**) | Internal backend | Indefinite | `DELETE /reports/{id}` deletes `users/<user_id>/` prefix (`routes_reports.py:1246-1292`) | backend/portal |
| Module SNP maps + report doc | `POST /reports` | Scoring | `report_meta.userId` | `UserGenomics` (DashboardWriter), `Results` | Internal; derived to ChatGPT via MCP | Indefinite | `_purge_user_report_data(purge_user_genomics=True)` | backend |
| Report metadata incl. filename | `POST /reports` | Records | same | `report_meta.upload_meta.file_name` in report doc | may appear in report responses | Indefinite | purge | backend |
| Health/account profile | portal intake | Context | user | `Profile`, `HealthProfile` | backend | Indefinite | account closure path (TBD) | backend |

## 2. Cross-cutting stores and lifecycle

| Store | Sensitive content | Account linkage | Retention (observed) | Deletion covered by `_purge_user_report_data`? |
|---|---|---|---|---|
| S3 `mutantbt-genetic-data` | Raw DNA files (Route B) | `users/<user_id>/` prefix | none | Yes, for the authenticated user's prefix (Route B rows; MCP `create_report` never writes here) |
| `UserGenomics` | SNPs, report doc | `user_id` | TTL disabled | Yes |
| `Results` | module/pattern caches, causes payload, import ledger | `user_id` | TTL disabled | Partially: specific keys + prefix query; ledger rows only via prefix purge |
| `Assessments` | computed assessments | `user_id` | TTL disabled | Yes (per-user delete + verify) |
| `Recommendations` | recommendations | `user_id` | TTL disabled | Yes (report prefix) |
| `Status` | report status | `user_id` | TTL disabled | Yes |
| `CacheVersions` | cache revision clock | `user_id` | **TTL enabled** (`ttl`) | Not a data store; not purged |
| MCP CloudWatch log group | tool-call audit (no account id) | `requestId` | 30 days (existing config; see `retention-policy.md`) | No (retention only) |
| Backend CloudWatch log groups | request/import/deletion logs | `user_id` truncated to 8 chars in messages | none | No |

Retention is driven by `retention-policy.json`; `docs/privacy/retention-policy.md`
describes how it is applied and verified. All rows are `pending` until owner
decision **P3** supplies the approved periods.

## 3. Recipients

| Recipient | Data received | Channel |
|---|---|---|
| ChatGPT (OpenAI) | Derived findings and, for genotype-detail tools, per-marker genotypes; concise text + full `structuredContent` | MCP tool result (`tool-result.ts:41-42`) |
| Mutant backend | Route A inputs (SNPs/WGS/metadata/context); Route B raw file + maps | internal Lambda invoke / portal API |
| Internal ops | Tool-call audit + backend logs | CloudWatch |
| Other third parties | None observed in code beyond AWS (S3/DynamoDB/CloudWatch) and Cognito | — |

## 4. Gaps carried to downstream tickets

- **Raw file & SNP/WGS stores have no TTL or lifecycle** (`mutantbt-genetic-data`,
  `UserGenomics`, `Results`, `Assessments`, `Recommendations`, `Status`). Retention
  settings are PRIV-06; product retention commitments are an owner decision.
- **Backend log groups never expire.** Retention work is PRIV-06.
- **PRIV-06 (mechanism in place):** `retention-policy.json` records every store,
  the MCP log group applies retention on both created and adopted groups, an
  idempotent applier manages the backend tables/bucket/log groups, readers enforce
  logical expiry, and `npm run verify:retention` reports deployed-vs-approved. The
  periods themselves remain `pending` until owner decision **P3**.
- **PRIV-03 (resolved): filename is no longer sent by the plugin.** `upload_meta.file_name`
  is optional in the contract (`schemas/index.ts`), the plugin sends only
  provider/format/build/size, and the MCP `create_report` handler strips any
  filename before transport (`dna-payload.ts`). A legacy/portal caller can still
  supply one; it remains persisted in `report_meta` and is no longer described as
  intrinsically non-sensitive (see `data-boundaries.md`).
- **PRIV-03 (resolved): WGS records are projected.** Both the MCP boundary
  (`dna-payload.ts`) and the backend contract (`contract.py`) keep only the VCF
  fields the normalizer reads, so annotations/headers/comments/sample labels
  cannot cross in either direction.
- **PRIV-03 (resolved): response payloads are projected.** `responses/projections.ts`
  walks every tool result against its own output schema before returning, dropping
  unknown/debug/account fields from `structuredContent` and pruning `_meta` to
  sanctioned keys.
- **`analysis_context` is genuinely request-only** here; keep it that way and do
  not let a future change persist it.
- **Deletion scope is report/account-genomic only.** Logs, backups, consent
  evidence, and ChatGPT-side copies are not covered. PRIV-07 owns completeness.
- **No consent records exist yet.** Collection and sharing proceed on UI checkbox
  state and OAuth scope. PRIV-04 owns durable consent evidence; this inventory
  will need a row added for it.
- **Derived findings can encode context**: genotypes and inferred context can be
  reflected in derived results. Verify with PRIV-03 output projections.

## 5. Historical log inventory and treatment (PRIV-02 step 6)

Observed stores and their current treatment. "Purge" is deliberately **not**
performed by the PRIV-02 code change; erasing audit evidence silently is out of
scope, and any purge needs an owner decision and a documented retention rule.

| Log group | What it may already contain | Access today | Retention today | PRIV-02 treatment |
|---|---|---|---|---|
| `/aws/lambda/mutant-mcp-<env>` | Pre-change `event: "tool_call"` records with `userId` and withheld/audited argument values (including short health prose that the removed keyword heuristic used to pass through) | Internal ops (CloudWatch); no separate role scoping observed | 30 days | Leave in place to age out under the 30-day retention. Records written after this change carry the safe schema (no account id, no values outside a designated synthetic capture). |
| `/aws/lambda/mutant-report-generator`, `dev-mutant-report-generator` | Import/result/deletion logs with `user_id` truncated to 8 chars, cache/report keys, and some interpolated exception messages (`core/persistence.py`) | Internal ops | **none — never expires** | Retention is PRIV-06. Do not purge now. Backend error interpolation is a follow-up below. |
| `/aws/lambda/mutant-mcp-dev` (and `-prod`) | Same as prod/dev MCP rows | Internal ops | 30 days | Same as above. |

Any future subject correlation that is genuinely required (for example, abusing
to a security incident) must live in a **restricted** channel with a written
purpose and retention; a user id or a hash of one is still linkable data. The
tool-call audit record is not that channel.

### Backend logging inspection (PRIV-02, Files note)

Inspected `report-generator/mcp/handlers.py` and `report-generator/core/persistence.py`:

- `mcp/handlers.py:236` (`[MCP][COLD_CACHE]`) logs `str(user_id)[:8]` + report id +
  reason on every cold-cache rejection. The truncation reduces but does not remove
  linkability.
- `core/persistence.py` cache/serve/delete paths log `str(user_id)[:8]`, cache
  key, report id, and interpolated exception text (e.g. `{renew_err}` at
  `persistence.py:343-346`, and similar `logger.warning(... {err})` sites around
  lines 400, 465, 578, 690, 758, 829, 891). An interpolated SDK/DynamoDB error
  message can carry values and should be replaced by a classified code.
- Deletion paths (`_purge_user_report_data`, `_delete_response_cache_chunks`,
  `delete_patterns_cache_chunks`, `delete_precomputed_causes`) log counts, not
  payloads — good — but still attach the truncated user id.

Follow-ups: **D11** (backend error interpolation -> classified codes) is
**closed** in PRIV-06 (`core/persistence.py` now logs a bounded `code=`), and
**D12** (backend log retention + restricted-channel purpose) remains open with
**P3** in `owner-decisions.md`. `scripts/apply-retention.ts` and
`npm run verify:retention` are the mechanism; the periods are unset until P3.

## 6. Response boundary projection (PRIV-03 step 3)

Every tool result now passes through `responses/projections.ts` in the tool
wrapper (`tools/index.ts`) before it is returned:

- `structuredContent` is walked against the tool's own declared output schema, so
  only declared fields survive. Loose schemas stay loose by design (an additive
  backend field is a schema change), but a loose schema is no longer a
  pass-through: the projection is the allowlist.
- `_meta` is pruned to sanctioned keys (`ui`, `ui/resourceUri`,
  `openai/outputTemplate`, `mutant`, `securitySchemes`, `mcp/www_authenticate`);
  any other metadata key is dropped.
- Opaque subtrees the schemas declare as application data (for example the SNP
  catalog `snps` marker map) are passed through unchanged.
- A union branch is selected by validation; a value that matches no branch is
  dropped rather than forwarded. Error payloads are projected too, so an
  unexpected `stack`/`internal_*` field on an error cannot leak.

Which tools may carry which sensitive field is now explicit:

| Field | Declared in | Notes |
|---|---|---|
| `genotype` | `variantEvidenceSchema` (used by `get_supporting_evidence` `kind: variants` and `get_genetic_context`) | The only genotype-bearing surfaces; every other tool's schema omits it. |
| `snps` (marker map) | `snpCatalogDataSchema` (record, opaque) | Component application data; not user genotypes. |
| `aliases` / `reference_alleles` | `snpCatalogDataSchema` | Declared explicitly so the projection preserves them for the local parse. |
| `assay_method` / `reference_range` / `guidance` | `testEvidenceSchema` | Only reachable through the `kind: "tests"` evidence call, never the default explanation. |
| `upload` provenance | n/a (input) | Provider/format/build/size only; no filename from the plugin. |

See `data-boundaries.md` for the search design decision and the WGS field list.

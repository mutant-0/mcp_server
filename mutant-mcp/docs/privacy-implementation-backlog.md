# Mutant privacy implementation backlog

Prepared September 30, 2026 from the [privacy review](C:/ghrepos/mcp_server/mutant-mcp/docs/privacy-health-data-review-2026-09-30.md). These are proposed implementation tickets, not completed changes or a certification of compliance. Each ticket can be copied into an issue. Owners below identify the engineering area, not assigned people.

## Delivery order

- Start **PRIV-01** (deployment/data inventory) and **PRIV-02** (logging) immediately.
- Implement **PRIV-03** (payload boundaries) and **PRIV-04** (consent enforcement), then **PRIV-05** (consent UI).
- Use the inventory to implement **PRIV-06** (retention), **PRIV-07** (deletion), and **PRIV-08** (withdrawal/revocation).
- Finalize and publish **PRIV-09** (policies/listing) after those behaviors and commitments are settled.
- Complete **PRIV-10** (release evidence) on the deployed candidate.

P0 means address before public onboarding. It does not mean a demonstrated production breach. P1 means required supporting work before closing this review. Logging can ship independently; coordinate consent/schema changes across all three repositories. Keep protections enabled during rollout and rollback.

## PRIV-01 — Establish the deployment and data inventory

**Priority:** P0 prerequisite. **Owner:** backend/infrastructure plus product owner. **Dependencies:** none.

**Problem:** Local portal copies differ, the public policy is older than nested source, and the deployed OAuth path has not been traced. Editing a page that users never visit will not solve consent.

**Implementation:**

1. Identify the deployed portal repository root, build command, artifact revision, hosting distribution, MCP Lambda revision, backend alias, OAuth issuer/client, authorization URL, and callback path. Record identifiers, never secrets.
2. Walk a synthetic new account and an existing account through linking and import. Establish whether the real flow visits `ChatGPTAuthorizePage.js` or goes directly to the identity provider. Record this before choosing where consent enforcement lives.
3. Create a versioned data inventory. For each category record collection route, purpose, account linkage, storage/cache/log destinations, recipients, retention, deletion mechanism, and responsible component. Include selected SNPs, WGS records, filenames, inferred chromosome context, derived findings, saved responses, import deduplication records, and audit metadata.
4. Record separate treatment for plugin imports and other portal ingestion routes; do not assume they have identical raw-file behavior.
5. Product owner supplies launch countries/states, intended age eligibility, retention commitments, and facts needed to determine whether Mutant itself is a covered entity. Do not label an unknown answer compliant.

**Code starting points:** [backend invocation](C:/ghrepos/mcp_server/mutant-mcp/src/clients/mutant-lambda-client.ts), [report persistence/deletion](C:/ghrepos/back-end/report-generator/core/routes_reports.py), [MCP caches and import ledger](C:/ghrepos/back-end/report-generator/mcp/wiring.py), [authorization page](C:/ghrepos/front-end-web/front-end-web/src/components/ChatGPTAuthorizePage.js), [deployment workflow](C:/ghrepos/mcp_server/.github/workflows/deploy.yml).

**Acceptance:** Every sensitive field has an identified destination and lifecycle. Deployed revisions and the actual consent route are recorded. Unknowns have explicit owners and block the relevant downstream acceptance criteria. Verification uses synthetic data only.

## PRIV-02 — Remove sensitive content from production logs and preserve safe routing evidence

**Priority:** P0. **Owner:** MCP/backend. **Dependencies:** none for MCP changes; PRIV-01 identifies additional logging sinks.

**Problem:** The short-string heuristic logs medical prose and associates it with a user ID. Raw exception serialization can also bypass argument-level redaction.

**Implementation:**

1. Replace argument-value auditing with an explicit safe operational schema: event, tool, opaque request ID, status/error code, duration, and bounded counts or booleans where useful. Derive argument names from known schema keys; do not persist attacker-controlled unknown keys.
2. Exclude `query`, genotype/WGS content, `analysis_context`, filename, finding/gene identifiers, cursor values, and backend request/response bodies from ordinary logs. Remove the keyword heuristic as a privacy boundary. Keep any necessary subject correlation in a restricted security channel with a documented purpose and retention; a hash is still potentially linkable data.
3. Replace general exception-object logging with classified codes and safe messages. Inspect errors from SDKs and backend failures, including nested causes; avoid copying data-bearing messages/stacks into production logs.
4. Keep logger redaction as defense in depth, with paths covering sensitive fields at supported nesting levels. Do not rely on a finite redaction list to make arbitrary objects safe.
5. Adapt routing capture to safe request/session correlation. Capture any required argument details only from explicitly designated synthetic test sessions in a controlled environment. Preserve real observed provenance; do not reconstruct missing calls or silently fill unknown arguments. The recorder already supports supplied query values, but those must come from the actual synthetic capture.
6. Inventory historical sensitive logs. Determine access restrictions and expiry/purge treatment under the adopted retention policy; do not silently erase audit evidence during this code change.

**Files:** [audit.ts](C:/ghrepos/mcp_server/mutant-mcp/src/tools/audit.ts), [tool wrapper](C:/ghrepos/mcp_server/mutant-mcp/src/tools/index.ts), [logger.ts](C:/ghrepos/mcp_server/mutant-mcp/src/logger.ts), [trace recorder](C:/ghrepos/mcp_server/mutant-mcp/scripts/record-golden-trace.ts), [trace contract](C:/ghrepos/mcp_server/mutant-mcp/tests/golden-trace-contract.ts). Inspect backend logging around imports, results, and deletion from PRIV-01.

**Acceptance/tests:** Extend `tool-audit.test.ts` to capture fully serialized logs on success, scope denial, and thrown errors. Sentinel query text such as `I have a rare desease`, filenames containing names, genotype strings, tokens, and context values must be absent. Verify useful tool/status/timing remains. Update `golden-trace-recorder.test.ts` and routing tests; missing evidence must remain incomplete, not become observed automatically.

## PRIV-03 — Make input and output data boundaries explicit

**Priority:** P0. **Owner:** MCP/backend. **Dependencies:** PRIV-01; feeds consent and policy wording.

**Problem:** Import metadata labels the original filename non-sensitive, WGS records accept arbitrary properties, and some output schemas allow extra properties while the response builder forwards the whole envelope. These are exposure paths requiring review, not proof of an existing leak.

**Implementation:**

1. Keep original filenames in the local import UI unless a server-side purpose is established. Prefer sending source/provider, format, build, and size/counts. Remove or make `file_name` optional through a compatible backend migration; stop calling it intrinsically non-sensitive.
2. Document fields required for each WGS target. Project approved VCF fields before transport/persistence; do not forward arbitrary sample labels, annotations, headers, or comments. Preserve fields required by the actual scoring algorithms and verify variant behavior against existing fixtures.
3. Define per-tool response projections for both `structuredContent` and text. Strip unknown/debug/account fields before returning results; keep contract version, pagination, analysis revision, entitlements, and search-scope semantics intact. A loose validation schema alone is not a projection.
4. Retain individual genotypes only in tools where they serve a documented user task. Avoid returning them in broad overview/list calls unnecessarily. Ensure errors and UI metadata cannot expose excluded data either. Treat moving a field to UI metadata as exposure reduction, not a substitute for consent or disclosure.
5. For search, retain useful catalog search while deciding whether arbitrary free text is necessary. The narrower design is catalog-backed topic IDs with exact membership validation and a discovery route. If adopting it, migrate model instructions, backend search, schema, and routing fixtures together. If retaining free text, explicitly document the residual risk: prompts and regexes cannot guarantee absence of personal health history. Do not delete `query` without replacing needed topic-search behavior.

**Files:** [input schemas](C:/ghrepos/mcp_server/mutant-mcp/src/schemas/index.ts), [output schemas](C:/ghrepos/mcp_server/mutant-mcp/src/schemas/outputs.ts), [response builder](C:/ghrepos/mcp_server/mutant-mcp/src/responses/tool-result.ts), [DNA import UI](C:/ghrepos/mcp_server/mutant-mcp/src/ui/dna-import/app.tsx), [list tool](C:/ghrepos/mcp_server/mutant-mcp/src/tools/list-health-hypotheses.ts), [backend contract](C:/ghrepos/back-end/report-generator/mcp/contract.py), [backend projections](C:/ghrepos/back-end/report-generator/mcp/projection.py).

**Acceptance/tests:** Inject unexpected identifying/debug fields into mocked backend responses and WGS inputs; assert they do not cross the approved boundary. Test `structuredContent`, text, metadata, and error paths. Preserve parser/scoring parity, Free/Full search scope, no-match behavior, pagination, and explicit genotype-detail use cases. Extend `schemas.test.ts`, `contract-v3.test.ts`, `lambda-client.test.ts`, `list-search-scope.test.ts`, and relevant backend tests. Choose and document the search design before closing this ticket.

## PRIV-04 — Add durable consent records and server enforcement

**Priority:** P0. **Owner:** backend/auth/MCP. **Dependencies:** PRIV-01 and settled PRIV-03 data categories.

**Problem:** UI checkbox state and OAuth scopes alone do not demonstrate current consent to sensitive collection and ChatGPT sharing.

**Proposed design:**

- Maintain a current consent state keyed by verified subject, purpose, and integration/client, plus minimal versioned events. Proposed fields: `subject_id`, `purpose`, `client_id`, `notice_version`, `notice_digest`, `status`, `accepted_at`, `withdrawn_at`, `source`, and `revision`. Use server timestamps. Retention of consent evidence needs its own approved schedule.
- Distinguish genetic processing/storage from sharing findings with ChatGPT. Do not make unrelated marketing/research consent a prerequisite. Final purposes and wording follow actual product behavior.
- Add authenticated read/accept/withdraw operations in the actual portal API. Endpoint names are implementation choices; these operations have not been confirmed to exist. Identity comes from verified authentication, never a submitted subject ID. Apply the existing session/CSRF protections where relevant.
- Accept only supported, current notice versions. Acceptance is idempotent. A material purpose/data change can require renewed consent through a documented version policy; every copy edit need not revoke grants.
- Enforce state at the authoritative backend before import side effects and before sensitive result retrieval. A common guard should cover all relevant MCP handlers and return a typed `CONSENT_REQUIRED`-style result without genetic payloads. Update shared contracts and UI presentation for the chosen error code. Leave non-sensitive consent/help/recovery operations usable.
- Fail closed for sensitive operations if consent state cannot be checked. Do not use stale positive cache entries after withdrawal. Guard in-flight processing and response delivery against withdrawal/deletion races according to the chosen consistency model.

**Files:** [tool registration](C:/ghrepos/mcp_server/mutant-mcp/src/tools/index.ts), [response handling](C:/ghrepos/mcp_server/mutant-mcp/src/tools/respond.ts), [shared contract](C:/ghrepos/mcp_server/mutant-mcp/src/contract.ts), [backend handlers](C:/ghrepos/back-end/report-generator/mcp/handlers.py), [backend wiring](C:/ghrepos/back-end/report-generator/mcp/wiring.py). Add a consent repository/service in the backend after confirming its persistence conventions.

**Acceptance/tests:** New, existing, stale-consent, withdrawn, and cross-account requests are covered. Missing consent blocks direct API/MCP calls even if the browser is bypassed. Rejection produces no import writes, cache disclosure, genotype response, or sensitive logs. Simulate consent-store failure and acceptance/withdrawal races. An existing OAuth token cannot bypass the consent guard.

## PRIV-05 — Correct consent UI and make navigation enforce the flow

**Priority:** P0. **Owner:** portal/MCP UI. **Dependencies:** PRIV-03 and PRIV-04.

**Implementation:**

1. Replace raw-genome storage claims with accurate route-specific wording: local parsing of the original file, selected genetic calls sent/stored, optional inferred context, derived results, and what ChatGPT receives. Link the applicable policy/version prominently before acceptance.
2. Fix `OnboardingPage.js`: its current `handleContinue` returns early but does not cancel the React Router link's navigation. Use a form/button that awaits successful server-recorded acceptance before navigating. Keep an explicit decline/exit route.
3. Treat `sessionStorage` only as optional draft UI state, never proof of consent. Reload server state when linking/importing and when switching accounts. Do not preselect required acceptance for a new or changed notice.
4. Connect the actual deployed OAuth path from PRIV-01 to server consent. If hosted identity-provider login bypasses the custom page, add the required step around that flow and keep backend enforcement authoritative.
5. In the embedded import UI, show an actionable consent-required state and complete the supported authenticated flow before invoking `create_report`. Gate existing-account result sharing as well as first-time import. Do not store tokens or user health history in redirect URLs.

**Files:** [onboarding](C:/ghrepos/front-end-web/front-end-web/src/components/OnboardingPage.js), [ChatGPT authorization](C:/ghrepos/front-end-web/front-end-web/src/components/ChatGPTAuthorizePage.js), [DNA import UI](C:/ghrepos/mcp_server/mutant-mcp/src/ui/dna-import/app.tsx). Confirm the deployed portal root before editing.

**Acceptance/tests:** Unchecked, denied, stale, network-failed, and double-click flows do not navigate into successful submission/sharing. Acceptance persists across devices through server state. Direct URL access cannot bypass backend checks. Test keyboard navigation and accessible error/checkbox labels. Extend `dna-import-ui.test.tsx` and portal component/integration tests; exercise the real host flow with synthetic accounts.

## PRIV-06 — Implement and verify retention for every store

**Priority:** P1. **Owner:** infrastructure/backend. **Dependencies:** PRIV-01; product retention decisions required.

**Implementation:**

1. Convert the approved inventory into explicit settings for active genetic data, derived results, response caches, import ledgers, operational/security logs, consent evidence, backups, and test captures. Do not invent production periods or publish unsupported guarantees.
2. Close the adopted-log-group gap in the MCP stack: import/manage the existing resource safely or apply a dedicated retention resource/change. Do not replace/delete the log group merely to manage retention. The current one-month setting for new groups is an existing configuration, not an approved universal schedule.
3. Set applicable database TTLs and object/version lifecycle rules. Readers must enforce logical expiration where needed; asynchronous physical TTL cleanup cannot guarantee an exact deletion deadline.
4. Review read-through cache TTL renewal in backend `mcp/wiring.py`: do not renew withdrawn/deleting account data or inadvertently override an absolute maximum retention rule.
5. Provide a read-only verification command/report that checks deployed configuration against the inventory. Include log reader permissions and any export destinations.

**Files:** [MCP stack](C:/ghrepos/mcp_server/mutant-mcp/infrastructure/lib/mutant-mcp-stack.ts), [backend cache/ledger wiring](C:/ghrepos/back-end/report-generator/mcp/wiring.py), persistence/backup infrastructure identified by PRIV-01.

**Acceptance/tests:** Infrastructure tests cover both newly created and adopted log groups. Expired records are unavailable even before physical TTL removal. Record actual deployed retention and access settings; unresolved stores prevent closure.

## PRIV-07 — Make deletion complete, retryable, and observable

**Priority:** P0. **Owner:** backend plus portal. **Dependencies:** PRIV-01, PRIV-04, PRIV-06.

**Implementation:**

1. Distinguish report deletion from deletion of all account-linked genetic data/account closure. Reuse the current deletion route but verify its actual scope against the inventory.
2. Introduce an idempotent deletion job with states such as requested, access-blocked, deleting, completed, and retry-required. Block new imports and sensitive reads immediately once an authenticated deletion is accepted.
3. Purge selected calls, derived reports, recommendations/assessments/status, response caches, saved findings, import ledgers, relevant object versions, and other identified stores. Handle all paginated records, partial failures, and retries. Do not report complete when a component failed.
4. Prevent delayed workers, cache warming, or retrying old imports from recreating deleted data. Use a deletion state/generation fence checked before writes and responses. Retain only minimal tombstone evidence for a defined period.
5. Handle backups via the agreed expiry/restore policy. A restore must reapply deletions before serving restored data. Document any narrowly justified retained security/consent records separately.
6. Return a job receipt and status without genetic contents. Display the actual completion state and explain the distinction between Mutant deletion and copies already present in a user's ChatGPT conversations.

**Files:** [report deletion route](C:/ghrepos/back-end/report-generator/core/routes_reports.py:1214), [existing purge helper](C:/ghrepos/back-end/report-generator/dynamic_handler.py:338), [cache/import ledger](C:/ghrepos/back-end/report-generator/mcp/wiring.py). Add job persistence/workers using existing backend conventions.

**Acceptance/tests:** Seed every inventoried store for synthetic accounts A and B; delete A and confirm all scoped data is removed/inaccessible while B is unchanged. Inject one store failure, retry, concurrent import, delayed worker, and stale cache read. Completion must remain pending/failed until all required active stores finish. Verify restore handling separately from ordinary deletion.

## PRIV-08 — Enforce withdrawal and revoke integration access

**Priority:** P0. **Owner:** auth/backend/MCP. **Dependencies:** PRIV-04; coordinate with PRIV-07.

**Problem:** The local MCP validator verifies token signature/claims; that code alone does not check subsequent withdrawal or revocation. Actual provider behavior still needs verification.

**Implementation:**

1. Provide a clear disconnect/withdraw action with distinct effects: revoke the ChatGPT integration grant, withdraw the relevant consent purpose, and optionally request data deletion through a separate explicit action.
2. Revoke refresh capability through the configured identity provider. Establish how already-issued access tokens are handled by resource servers; do not assume local signature verification observes provider revocation.
3. Enforce a current integration/consent state or grant revision at the backend resource boundary. Withdrawn sharing permission must block sensitive reads with an otherwise valid token. Define and test any propagation bound; avoid caching positive authorization beyond it.
4. Relinking must require a current grant/consent state without restoring old withdrawn permissions implicitly. Preserve unrelated portal access when only the ChatGPT integration is disconnected.

**Files:** [token validator](C:/ghrepos/mcp_server/mutant-mcp/src/auth/token-validator.ts), [user context](C:/ghrepos/mcp_server/mutant-mcp/src/auth/user-context.ts), [tool wrapper](C:/ghrepos/mcp_server/mutant-mcp/src/tools/index.ts), authoritative backend guard from PRIV-04, deployed OAuth implementation discovered in PRIV-01.

**Acceptance/tests:** A captured synthetic access token issued before withdrawal cannot retrieve sensitive data after the defined enforcement point. Refresh fails after revocation. Relink works only after renewed authorization as required. Test two integrations/accounts independently and withdrawal during a pending request.

**Implementation status (2026-10-02):** Delivered on `main` in both repositories — backend `core/consent.py` (grant rows + fence), `mcp/integration.py` (fail-closed boundary guard), `core/routes_consent.py` (`POST /consent/disconnect`), and MCP contract 3.3.0 (`INTEGRATION_REVOKED`, optional `identity.issued_at`, `_meta.mutant.integration`). Automated coverage exists for revocation, relink fencing, per-subject/client independence, the pending-request propagation bound, and fail-closed store errors. Provider refresh revocation now calls Cognito `RevokeToken` with the public connector client id (client secret attached only when configured), so refresh fails after revocation. The ticket remains **open**: the deployed synthetic-account walk (`docs/privacy/deployment-manifest.md` §11c) and PRIV-01 D1/D3/D5 + C1 are unresolved.

## PRIV-09 — Publish matching policies and complete listing metadata

**Priority:** P0. **Owner:** portal/product/release. **Dependencies:** PRIV-01 and finalized behavior/commitments in PRIV-02 through PRIV-08.

**Implementation:**

1. Update privacy/data policies to match the approved inventory: local file handling, stored selected calls, derived findings, optional context, ChatGPT/genotype disclosures, logging, service recipients, retention, deletion, withdrawal, and contact method. Avoid absolute no-storage/no-sharing statements contradicted by other routes.
2. Reconcile onboarding and authorization text with the same notice versions used by consent records. Do not claim consent to one version proves acceptance of a materially different one.
3. Fix the portal build/deploy source mismatch and any cache invalidation needed to serve the intended policy. Confirm the rendered public pages, not just source files or HTTP 200 responses.
4. Add/verify website, privacy, terms, and support references in the actual submission/package metadata. Check the supported manifest schema before choosing field names; do not invent keys in `plugin.json`.
5. Resolve launch geography and audience decisions, document any applicable additional regional requirements, and describe the DTC data flow accurately in submission materials. Engineering completion does not itself settle legal classification or platform acceptance.

**Files:** [privacy source](C:/ghrepos/front-end-web/front-end-web/src/components/PrivacyPage.js), [data policy source](C:/ghrepos/front-end-web/front-end-web/src/components/DataPolicyPage.js), [plugin manifest](C:/ghrepos/mcp_server/mutant-mcp/plugin.json), deployment configuration identified in PRIV-01.

**Acceptance:** Live public pages show the intended version and match tested behavior. Links work without login. Consent records resolve to the exact accepted notice. No retention promises exceed demonstrated controls. Listing data is validated against the current supported schema.

**Implementation status (2026-10-02):** Partial on `main`. Portal `DataPolicyPage.js` raw-file claims are now route-specific (plugin import local-only vs portal web upload stored) and the `PrivacyPage.js` operational-log/backup wording no longer asserts unsupported expiration; `deploys3.ps1` invalidates `/privacy`, `/data-policy`, `/terms`, `/cookie-policy`. `plugin.json` carries the schema-supported `homepage`/`author`/`license`/`keywords` with a `tests/plugin-manifest.test.ts` conformance test against the vendored Agent Plugins 1.0.0 schema (which defines no privacy/terms/support URL field). The ticket remains **open**: PRIV-01 **D6/D7** (portal build root, served/rendered revision) block P0-C and live verification, **P1/P2/P4** block P0-E, and **P3** still blocks the retention wording. See `docs/privacy/policy-publishing-plan.md` §7.

## PRIV-10 — Add a privacy release gate and collect deployment evidence

**Priority:** P1; required to close the review. **Owner:** release/QA. **Dependencies:** PRIV-02 through PRIV-09; PRIV-01 decisions resolved.

**Implementation:**

1. Add a focused CI suite for consent bypass, payload leakage, sanitized logs, cross-account access, withdrawal, and deletion races. Run the existing typecheck, lint, test, and genomics parity checks after relevant changes.
2. In staging, exercise synthetic new/existing accounts, absent/stale/withdrawn consent, import, overview/details, no-match searches, expired tokens, disconnect, delete, and relink. Inspect all response channels and sampled logs for sentinel data.
3. Capture release evidence: component revisions, policy/consent versions, approved data inventory, deployed retention/access settings, deletion/withdrawal outcomes, and observed ChatGPT routing traces. Remove credentials and real identifiers from the evidence bundle.
4. Separate automated assertions from manual deployment evidence. A machine-readable privacy status file may point to evidence, but a boolean edited to true is not evidence. Keep incomplete checks visibly incomplete.
5. Keep the existing golden routing provenance requirement separate: privacy fixes do not turn `pending-manual-capture` traces into observed calls.

**Files:** [CI workflow](C:/ghrepos/mcp_server/.github/workflows/deploy.yml), [test directory](C:/ghrepos/mcp_server/mutant-mcp/tests), [routing traces](C:/ghrepos/mcp_server/mutant-mcp/tests/golden-prompt-routing-traces.json), backend/portal test suites.

**Acceptance:** All required tests pass on the deployed release candidate; evidence links are complete and contain only synthetic/redacted data. The privacy review changes to implementation-verified only when every applicable ticket closes. Platform approval remains a separate outcome.

## Decisions required from the product owner

- Initial countries/states and intended age range.
- Supportable active-data retention, deletion turnaround, backup expiry, and minimum security/consent evidence retention.
- Whether free-text catalog search remains necessary or is replaced with catalog topic selection.
- Confirmation of Mutant's operating relationships and covered-entity facts beyond DTC-only status.

These decisions need not delay the safe logging change, deployment inventory, response-field inventory, or tests reproducing the consent-navigation defect. No product implementation or deployment was performed in preparing this backlog.

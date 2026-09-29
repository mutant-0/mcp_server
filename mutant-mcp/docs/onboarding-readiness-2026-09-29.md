# Mutant ChatGPT onboarding readiness

Checked 2026-09-29 against local commit `1745848e248c56a6ca4230559ad0207062dbd56b` and the public development endpoint `https://dev-api.mutantbiotech.com/mcp`.

**Verdict: ready to attempt supervised developer-mode linking; not yet verified for user onboarding or public submission.** No production deployment, account linking, DNA submission, or plugin publication was performed. Application source was not changed.

## Verified checks

- [x] UI build: both self-contained components compiled.
- [x] TypeScript check and ESLint: passed.
- [x] Automated suite: **379 tests passed across 21 files**. These include local authentication, schemas, tool behavior, UI flows, and parser tests; they do not prove the deployed backend or ChatGPT host behavior.
- [x] Server and CDK entry-point bundles: passed. A CDK bundle is not a synthesized or deployed infrastructure validation. Tests ran on local Node 24.8.0; CI and Docker target Node 22.
- [x] Public HTTPS protected-resource metadata: HTTP 200, correct development resource URI, both `analysis.read` and `dna.import` scopes.
- [x] Public authorization-server metadata: HTTP 200, authorization-code and refresh-token grants, `S256` PKCE, public-client token authentication, Cognito login/token endpoints.
- [x] Missing, invalid, and development-test bearer tokens: HTTP 401 with a resource-metadata challenge. This establishes rejection for the tested requests, not a complete audit of deployed authentication settings.
- [x] Local tool registration: 12 tools, including app-only catalog, report creation, and polling. Read/write annotations and per-tool scopes are present; tested locally.
- [x] Plugin identity and three starter prompts are present. Display name and prompt lengths fit the documented limits.

The exploratory `GET /mcp/health` returned 405. This repo does not implement that health route; its Lambda adapter uses a TCP readiness probe. This result is not counted as an onboarding failure.

## Failed checks

- [ ] **DNA processor parity:** `npm run check:genomics` fails on `sexChromosome.js` compared with the adjacent portal checkout. The upstream change maps internal inference vocabulary to backend wire values. Review the upstream revision, run the documented sync process, then rerun parity and parser tests. The ChatGPT import currently sends only high-confidence XX/XY context, so this drift alone does not demonstrate a broken import.
- [ ] **Observed ChatGPT routing:** the strict release gate fails: **0 of 22 traces are observed**; all remain `pending-manual-capture`. With `GOLDEN_TRACES_REQUIRED=1`, the routing suite reports 22 passes and one provenance failure. Capture actual selected tools and arguments in fresh ChatGPT conversations; do not simply relabel placeholder traces. The deployment workflow does not currently enable this strict gate.
- [ ] **Public listing subtitle:** `shortDescription` is 90 characters; public submission currently allows 30. The existing text can serve as draft package copy. A candidate final subtitle is “Compare DNA to health history”. [Submission reference](https://developers.openai.com/plugins/deploy/submission)

## Remaining onboarding checks

- [ ] **Live OAuth linking:** link a dedicated test account using the predefined Cognito client, verify callbacks, consent to both scopes, token refresh, expired-token handling, and disconnect/relink. Inspect resource/audience binding: the local validator checks it only when the claim exists. The public discovery documents alone do not prove token issuance and validation conform end to end. [Authentication guidance](https://developers.openai.com/plugins/build/auth)
- [ ] **Deployed revision and backend:** confirm the deployment matches the reviewed commit, `MUTANT_DEV_MODE=false`, a real backend Lambda alias is configured, and the backend supports contract **3.1.0**. Missing backend ARN selects a mock client in this repo. AWS credentials were unavailable; deployment configuration, alarms, CI success, and backend account isolation were not inspected.
- [ ] **Authenticated MCP:** initialize, list all tools, read both UI resources, and call representative read tools through the live endpoint. Use separate Free and Full test accounts; verify cross-account isolation and entitlement boundaries.
- [ ] **Real ChatGPT experience:** execute the entry prompts for no-DNA, processing, Free, Full, refresh-available, and refresh-processing states. Confirm correct overview/import/follow-up cards, no duplicate cards, and useful text fallbacks. Save the 22 observed routing traces and rerun the strict gate. [Connection and testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [ ] **Import lifecycle:** with a synthetic test fixture, verify review-before-submit, catalog-matched variants only, bounded polling, completion without another prompt, cancel/error paths, duplicate-submit idempotency, and a new retry key after failure. Verify the host’s CSP and worker fallback; local UI tests do not substitute for host testing.
- [ ] **Privacy and health-data review:** verify point-of-collection consent, genetic-data disclosures, recipients, retention/deletion controls, and consistency with backend behavior. The UI already explains local raw-file processing and submission of matched variants. Public policy URLs and a recorded review were not found in the package. OpenAI’s indexed plugin guidelines distinguish restricted PHI from other regulated sensitive data; eligibility of Mutant’s actual data flows remains unverified. The guideline page returned 404 on direct retrieval during this check, so confirm the current policy before submission. This check does not determine legal compliance. [Indexed plugin guidelines](https://developers.openai.com/plugins/app-guidelines)

## Additional public-submission checks

- [ ] **Installable package:** the repository contains interface metadata in `plugin.json`, but no portable `mcp.json`, registered-app mapping, or packaged skills. Wire the actual MCP connection and test the installed package. Skills are optional for an MCP-backed plugin. A deployed MCP endpoint alone does not test package installation. [Packaging guidance](https://developers.openai.com/plugins/build/plugins)
- [ ] **Listing:** add or verify the product website, support, privacy policy, terms, primary icon, and final subtitle. These are absent from the local manifest; an external portal listing was not inspected.
- [ ] **Review materials:** prepare the required five positive and three negative cases, a working sample-data account, accessible walkthrough recording, and release notes. Keep reviewer credentials out of the public package.
- [ ] **Publication setup:** verify developer identity, stable public deployment, domain challenge, intended availability, and policy attestations in the submission portal. These remain unverified. [Submission requirements](https://developers.openai.com/plugins/deploy/submission)

## Configuration/documentation follow-ups

- `.github/workflows/deploy.yml:128` still supplies `MUTANT_UPGRADE_URL`, while infrastructure now reads `MUTANT_PLAN_INFO_URL`. Custom plan-page configuration will not propagate through this workflow; the default still exists.
- README/runbook references to eleven tools and contract 3.0.0 are stale relative to the twelve registered tools and contract 3.1.0. Align them before reviewer handoff.

## Recommended next sequence

1. Reconcile parser drift and verify deployment/backend configuration.
2. Link a test account and execute the real ChatGPT onboarding matrix, saving observed traces.
3. Complete the installable package, privacy review, and review materials before submission.

## Re-run commands (PowerShell)

Run in `C:\ghrepos\mcp_server\mutant-mcp`:

```powershell
npm run typecheck
npm run lint
npm run check:genomics
npm test
npm run bundle
npm run bundle:cdk
$env:GOLDEN_TRACES_REQUIRED = '1'
npm exec -- vitest run tests/golden-prompt-routing.test.ts
Remove-Item Env:\GOLDEN_TRACES_REQUIRED
```

Test output from this run is retained locally in ignored `readiness-tests.log` and `readiness-golden.log` files. Results above distinguish tests performed from checks still requiring account or infrastructure access.

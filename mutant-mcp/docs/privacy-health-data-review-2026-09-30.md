# Mutant privacy and health-data review

Reviewed September 30, 2026. Scope: ChatGPT plugin, local MCP source at commit `5a4ead6`, adjacent portal/backend source, publicly served policy pages, and targeted local tests. Owner confirms direct-to-consumer operation only. Launch jurisdictions are not yet specified.

Implementation follow-up: [Prioritized engineering backlog with acceptance criteria](C:/ghrepos/mcp_server/mutant-mcp/docs/privacy-implementation-backlog.md).

## Decision

**Do not mark privacy and health-data readiness as passed yet.** There are concrete disclosure, consent, and logging gaps. The evidence does not establish that the genetic functionality is categorically prohibited; it also does not establish submission eligibility or complete legal compliance.

The working classification is sensitive consumer genetic/health information, potentially outside HIPAA, provided Mutant is neither a covered entity itself nor acting as a business associate. Direct-to-consumer operation supports that assessment but does not alone settle covered-entity status. Account linkage makes data identifiable; it does not by itself make it HIPAA PHI. HHS explains the distinction in its [consumer health-app guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/cell-phone-hipaa/index.html).

OpenAI prohibits processing PHI and separately permits regulated sensitive data only under necessity, adequate consent, and prominent disclosure conditions. It also requires accurate policies, retention timelines, minimal data, and meaningful controls. The guideline does not provide a blanket exemption for consumer genetics or fully resolve how reviewers will classify this integration. Consent would not override a PHI prohibition. See [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).

## What the implementation actually handles

- The DNA import UI parses the raw file locally and submits selected variant calls, upload metadata, and optional chromosome-pattern context through the host tool bridge. This is data transfer even though the original file stays local. See [DNA import UI](C:/ghrepos/mcp_server/mutant-mcp/src/ui/dna-import/app.tsx:1408).
- Verified account identity accompanies the backend request. Selected calls are persisted under the user in the primary backend report route. See [backend client](C:/ghrepos/mcp_server/mutant-mcp/src/clients/mutant-lambda-client.ts:30) and [report persistence](C:/ghrepos/back-end/report-generator/core/routes_reports.py:1956).
- Import success returns an analysis identifier/status rather than echoing submitted variants. See [create report](C:/ghrepos/mcp_server/mutant-mcp/src/tools/create-report.ts:49).
- Later result tools can return health hypotheses, evidence, and individual genotypes. Their structured payload reaches ChatGPT; a short text summary does not hide the structured data. See [genotype output schema](C:/ghrepos/mcp_server/mutant-mcp/src/schemas/outputs.ts:460) and [tool response builder](C:/ghrepos/mcp_server/mutant-mcp/src/responses/tool-result.ts:43).
- The primary backend route removes optional chromosome context from the request before persistence and uses it for applicability scoring. This is a useful code-level control, not proof of deployed behavior or absence of inferable context in derived findings. See [context handling](C:/ghrepos/back-end/report-generator/core/routes_reports.py:1367).

## Findings and remedies

### 1. Public disclosures do not match the reviewed implementation — fix required

The live [privacy policy](https://mutantgenomics.com/privacy) and [data policy](https://mutantgenomics.com/data-policy), inspected as rendered pages, show January 7, 2026. A newer September 18 policy exists in the [nested portal source](C:/ghrepos/front-end-web/front-end-web/src/components/PrivacyPage.js:18), but was not the publicly served version observed.

The live policy describes usage logs as non-identifying, while MCP audits include account identifiers and health-related arguments. Public disclosures need to accurately distinguish local raw-file processing, stored selected calls, derived findings, the ChatGPT exchange, operational logs, recipients, and user controls. Update and publish the correct policy only after the actual practices and retention commitments are settled. Verify the listing links to that live version.

### 2. Consent wording is inaccurate and end-to-end coverage is unverified — fix and verify

Portal consent exists; this is not a finding that Mutant has no consent UI. However, both [onboarding](C:/ghrepos/front-end-web/front-end-web/src/components/OnboardingPage.js:21) and [ChatGPT authorization](C:/ghrepos/front-end-web/front-end-web/src/components/ChatGPTAuthorizePage.js:215) describe storing a raw genome, conflicting with the plugin's selected-variant design. The import review itself does not show a dedicated policy-linked sensitive-data consent record.

Correct the wording for each actual ingestion route. Before collection/sharing, explain the selected genetic inputs, purpose, account storage, returned findings and possible genotype details, platform recipients, deletion, and withdrawal. Verify that the deployed OAuth/import route necessarily passes through the correct disclosure and consent gate, including existing accounts. A source page alone does not prove this. Record consent version, scope, and time as appropriate; do not equate OAuth scope authorization with legally adequate sensitive-data consent.

### 3. Audit logs accept short health-history sentences — fix required

[Audit code](C:/ghrepos/mcp_server/mutant-mcp/src/tools/audit.ts:88) treats short word-shaped strings as catalog keywords. The sample `I have a rare desease` satisfies the filter. [Audit records](C:/ghrepos/mcp_server/mutant-mcp/src/tools/audit.ts:114) attach `userId`; gene and finding identifiers can also expose sensitive interests.

Remove free-text query values from ordinary production logs. Keep tool name, outcome, timing, and necessary correlation data; minimize identifiers and sensitive arguments with access and retention controls. Use synthetic accounts/data for routing trace collection. A length/character filter cannot establish that prose contains no personal health information.

Removing `query` is not required solely because the field exists. If retained, constrain its purpose and avoid transmitting user history. Removing it also would not resolve the account-linked genetic inputs and outputs described above.

### 4. Retention, withdrawal, and deletion are not demonstrated end to end — verify before passing

Published policies give broad necessity-based retention language rather than useful category-specific timelines. Source infrastructure sets one-month retention for newly created log groups, but adopted groups are not proven to have that setting. Backend report deletion exists, but that alone does not demonstrate deletion across account records, caches, saved findings, import ledgers, logs, backups, and third-party systems.

Set supportable retention periods or clear criteria and maximum deletion windows. Document exceptions and backup expiry. Exercise deletion and revocation with a synthetic account and inspect each relevant store. Disconnecting ChatGPT, revoking tokens, and deleting Mutant data are distinct actions. Explain any remaining ChatGPT conversation copies under the platform's controls.

### 5. Regional eligibility and deployed controls remain open

Launch countries/states, Mutant's own covered-entity status, production access controls, encryption/configuration, vendor agreements, and the deployed consent path were not established. US consumer apps can have obligations outside HIPAA, including potentially the FTC Health Breach Notification Rule; applicability requires evaluating the service against its definitions. See [FTC guidance](https://www.ftc.gov/business-guidance/resources/complying-ftcs-health-breach-notification-rule-0). Do not infer worldwide compliance from DTC status. Reconcile the stated adult-only service with platform audience requirements before submission.

## Evidence that supports readiness

Local parsing, selected inputs, account-scoped authorization, a separate import permission, and a narrow create-report success response are useful safeguards. Targeted tests passed: **71 tests in four files**, covering tool audit behavior, DNA import, chromosome context, and token validation. These tests do not certify consent validity, policy accuracy, production retention, deletion, or platform acceptance. The passing audit tests do not eliminate finding 3.

## Closure criteria

1. Correct live policies and consent text to match verified data flows.
2. Demonstrate required consent before sensitive collection/sharing on the deployed path.
3. Remove sensitive production log content and verify retention/access settings.
4. Verify deletion, token revocation, backup handling, and necessary output fields with synthetic data.
5. Establish launch jurisdictions and the remaining classification facts; submit the accurately described integration for OpenAI review.

This is an evidence-based readiness assessment, not an OpenAI approval or a legal certification. No product code, live policy, deployment, or real genetic data was changed as part of this review.

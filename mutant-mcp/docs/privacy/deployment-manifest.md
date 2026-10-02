# PRIV-01 deployment manifest

Version: 1.0 (2026-09-30). Backlog item: PRIV-01 step 1.
Records identifiers only, never secrets. No secret values, tokens, or credentials
appear here; if a value is a secret it is listed by name with `[secret]`.

Source of truth: live AWS/Cognito/API-Gateway/CloudFront inspection plus repo
files. Refresh via `discovery-runbook.md`. Anything not observed in this pass is
`TBD` and has an owner in `owner-decisions.md`.

## 1. Account and region

| Item | Value | Source |
|---|---|---|
| AWS account | `221082193523` | `aws sts get-caller-identity` |
| Deploy region | `us-west-2` | `.github/workflows/deploy.yml`, AWS config |
| CDK bootstrap | `hnb659fds` (account/region qualifier) | `mutant-mcp` CDK stacks |

## 2. MCP Lambda (mutant-mcp)

| Item | dev | prod | Source |
|---|---|---|---|
| Stack | `mutant-mcp-dev` | `mutant-mcp-prod` | `cloudformation describe-stacks` |
| Function | `mutant-mcp-dev` | `mutant-mcp-prod` | `lambda list-functions` |
| ARN | `arn:aws:lambda:us-west-2:221082193523:function:mutant-mcp-dev` | `...:mutant-mcp-prod` | `get-function-configuration` |
| Last modified | `2026-09-30T18:04:31Z` | `2026-09-29T23:58:18Z` | `get-function-configuration` |
| RevisionId | `f880020c-4160-42d2-a22c-d10d8897c984` | `ae1dd381-aefc-4c9d-8da5-4e8863686808` | `get-function-configuration` |
| CodeSha256 | `92ac1857493b…08b` | `996edd8c3dbf…fdf` | `lambda list-functions` |
| Published versions / alias | none (`$LATEST` only) | none (`$LATEST` only) | `list-versions-by-function` |
| Runtime | container image (Docker) | container image (Docker) | `mutant-mcp-stack.ts` |
| Timeout / memory | 30 s / 512 MB | 30 s / 512 MB | `get-function-configuration` |
| Log group | `/aws/lambda/mutant-mcp-dev` | `/aws/lambda/mutant-mcp-prod` | `logs describe-log-groups` |
| Log retention | 30 days | 30 days | `logs describe-log-groups` |
| `MUTANT_DEV_MODE` | TBD | TBD | env vars not dumped (see below) |

Notes:
- Rollback is a function-code update, not an alias flip: the MCP function has **no
  published versions or aliases**, only `$LATEST`. The report-generator has an
  alias (`live`), so the two sides roll back differently.
- `MUTANT_DEV_MODE` and the other Lambda environment values were not captured in
  this pass; the environment-variable read was out of the approved scope. Record
  it during the next approved discovery pass. Default in stack is `false`.

## 3. Backend Lambda (report-generator)

| Item | Value | Source |
|---|---|---|
| Function | `mutant-report-generator` | `lambda list-functions` |
| Function ARN | `arn:aws:lambda:us-west-2:221082193523:function:mutant-report-generator` | derived |
| Last modified | `2026-09-08T22:55:04Z` | `get-function-configuration` |
| RevisionId | `6c6862fd-3eaf-4f4a-8db9-58c8f3ae934d` | `get-function-configuration` |
| Published alias | `live` -> version `11` | `list-aliases` |
| Stacks | `report-generator-dev`, `report-generator-staging`, `report-generator-prod` | `describe-stacks` |
| Log groups | `/aws/lambda/mutant-report-generator`, `/aws/lambda/dev-mutant-report-generator`, `/aws/lambda/mutant-store`, `/aws/lambda/dev-mutant-store` | `logs describe-log-groups` |
| Log retention | **None (never expire)** on all four backend groups | `logs describe-log-groups` |
| Other Lambdas | `mutant-store` (store front), `mutant-api` | `lambda list-functions` |

`MUTANT_SERVICE_LAMBDA_ARN` for the MCP stack is supplied by the GitHub secret of
the same name; the MCP dev/prod functions resolve it at deploy time. Confirm the
targeted alias ARN during the synthetic walk.

## 4. Custom domains and API mappings

| Domain | Hosted zone target | API mappings | Source |
|---|---|---|---|
| `dev-api.mutantbiotech.com` | API Gateway v2 custom domain (cert `e4e6d95f-…`) | `""` (root, report-generator stage `dev`), `.well-known`, `mcp`, `store` | `apigatewayv2 get-domain-names`, `get-api-mappings` |
| `api.mutantbiotech.com` | API Gateway v2 custom domain (cert `54351e60-…`) | `""` (root, report-generator stage `prod`), `.well-known`, `mcp`, `store` | same |

The root mapping belongs to the report-generator API; the MCP Lambda claims the
`.well-known` and `mcp` prefixes on the same domain (`mutant-mcp-stack.ts`,
`.github/workflows/deploy.yml` supplies `MUTANT_DOMAIN_NAME` / `MUTANT_API_MAPPING_KEY`).

## 5. OAuth / identity

| Item | dev | prod | Source |
|---|---|---|---|
| Issuer (AS metadata) | `https://dev-api.mutantbiotech.com` | `https://api.mutantbiotech.com` | live `/.well-known/oauth-authorization-server` |
| Resource URI (PRM) | `https://dev-api.mutantbiotech.com/mcp` | `https://api.mutantbiotech.com/mcp` | live `/.well-known/oauth-protected-resource` |
| Authorization endpoint | `https://login.mutantgenomics.com/oauth2/authorize` | same | live AS metadata |
| Token endpoint | `https://login.mutantgenomics.com/oauth2/token` | same | live AS metadata |
| Userinfo / end-session | `https://login.mutantgenomics.com/oauth2/userInfo`, `/logout` | same | live AS metadata |
| JWKS | `https://cognito-idp.us-west-2.amazonaws.com/us-west-2_tgb5TJylh/.well-known/jwks.json` | same | live AS metadata |
| Cognito user pool | `us-west-2_tgb5TJylh` ("User pool - k3xmzn") | same pool | `cognito-idp list-user-pools` |
| Cognito hosted-UI domain | `login.mutantgenomics.com` | same | live AS metadata |
| Connector app client id | `1hi6c97v6md1q68h91ld37tre4` | `[TBD — confirm prod client]` | `mcp-runbook.md` |
| Portal app client id | `7eosqbhf950il1k92itt2j7cu` | `[TBD]` | `mcp-runbook.md` |
| Grant types | `authorization_code`, `refresh_token` | same | live AS metadata |
| PKCE | `S256` only | same | live AS metadata |
| Token auth method | `none` (public client) | same | live AS metadata |

### 5a. Deployed scope anomaly (prod)

The prod AS and PRM documents advertise a **dev** scope:

- `scopes_supported` (prod): `["https://dev-api.mutantbiotech.com/mcp/analysis.read", "https://api.mutantbiotech.com/mcp/dna.import"]`
- PRM `resource` (prod): `https://api.mutantbiotech.com/mcp` — correct.

The `analysis.read` scope string is still the **dev** resource URI, while
`dna.import` is the prod one. The dev document is internally consistent. This is a
deployed-configuration defect to resolve before PRIV-04/PRIV-08 enforce scope at
the resource boundary; the mismatch means a prod connector requests the dev
`analysis.read` scope. Owner and blocking ticket in `owner-decisions.md`.

## 6. Portal (front-end-web)

| Item | Value | Source |
|---|---|---|
| Served origin | `mutantgenomics.com`, `www.mutantgenomics.com` | `cloudfront list-distributions` |
| CloudFront distribution | `E24PU371ANVRGN` (`d27fjt5rn3ueki.cloudfront.net`), commentary "Front End Site" | same |
| Origin bucket | `mutantbt-frontend-web.s3.us-west-2.amazonaws.com` | `cloudfront get-distribution` |
| Default root object | `/index.html` | same |
| Bucket versioning | Enabled | `s3api get-bucket-versioning` |
| Served `index.html` | Last modified `2026-09-09T00:08:44Z`, ETag `5153ea1d74c3b09d6141cf6f6d640c8d`, 35890 bytes | `s3api head-object` |
| Served policy revision | Older than the `2026-09-18` source policy in `PrivacyPage.js`; prior review observed a rendered `2026-01-07` policy | prior review + served artifact date |
| Served server header | (SPA; raw HTML is the SPA shell, not rendered copy) | `curl` |
| Secondary distribution | `E2TQW472MOU738` ("For SEO only") for `mutantbiotech.com` | `cloudfront list-distributions` |

The served `index.html` predates the Sept 18 policy source, consistent with the
review's finding that the live public policy is older than the nested source. This
is the PRIV-09 build/deploy source-mismatch item; record, do not fix here.

### 6a. Portal repository root (the "local copies differ" issue)

Two candidate roots exist locally and must be reconciled:

- `C:\ghrepos\front-end-web\package.json` (outer root)
- `C:\ghrepos\front-end-web\front-end-web\package.json` (nested CRA app, **has `fflate` dependency and the `/sample-report`, `/cart`, `/get-started` reactSnap includes**)

The nested root `front-end-web\front-end-web` is the CRA application with the
current feature set; the outer `package.json` is an older copy (no `fflate`, fewer
reactSnap routes). Build command for the nested app: `npm run build` =
`react-scripts build && npm run postbuild:seo` (`react-snap` +
`scripts/flatten-prerendered-pages.cjs`).

| Item | Value |
|---|---|
| Confirmed deploy root | TBD — confirm which root the hosted pipeline builds |
| Build command | `react-scripts build && postbuild:seo` (nested root) |
| Deploy mechanism | TBD — S3 sync target `mutantbt-frontend-web` + CloudFront `E24PU371ANVRGN` invalidation, or CI; confirm |
| Served artifact revision | `index.html` 2026-09-09 (ETag `5153ea1d…`); commit TBD |
| Source policy version | `2026-09-18` in `front-end-web/front-end-web/src/components/PrivacyPage.js`, `DataPolicyPage.js` |

## 7. Data stores (destinations)

| Store | Type | Holds | Source |
|---|---|---|---|
| `mutantbt-genetic-data` | S3 (SSE-S3 AES256; versioning **not** enabled; **no** lifecycle config) | Raw uploaded DNA files for the **portal web** path, key `users/<user_id>/…` | `s3api list-buckets`, `get-bucket-encryption`, `get-bucket-lifecycle-configuration`, `get-bucket-versioning` |
| `mutantbt-frontend-web` | S3 (versioning enabled) | Portal static build | `s3api` |
| `UserGenomics` | DynamoDB (TTL disabled) | Genetic uploads: module SNP maps + consolidated report doc | `dynamodb list-tables`, `describe-time-to-live` |
| `Results` | DynamoDB (TTL disabled) | Cached modules/patterns; import idempotency ledger `dna_import#<id>` | same + `mcp/wiring.py` |
| `Assessments` | DynamoDB (TTL disabled) | Computed assessments | same |
| `Recommendations` | DynamoDB (TTL disabled) | Generated recommendations | same |
| `Status` | DynamoDB (TTL disabled) | Report status | same |
| `CacheVersions` | DynamoDB (**TTL enabled**, attr `ttl`) | Cache/config revision clock per account | same |
| `Profile`, `HealthProfile` | DynamoDB (TTL disabled) | Account + health intake profile | same |
| `UserEntitlements` | DynamoDB (TTL disabled) | Plan entitlement | same |
| `AmplifierState`, `CheckoutAttempts`, `Meals`, `StoreTransactions`, `StripeProcessedEvents` | DynamoDB | Commerce/other domains (out of genetic scope) | same |

Full field-level mapping is in `data-inventory.md`.

## 8. Build / release identity

| Item | Value | Source |
|---|---|---|
| MCP repo | `C:\ghrepos\mcp_server` (deploys `mutant-mcp/**`) | `deploy.yml` |
| MCP local HEAD (reviewed) | `5a4ead6bdb59b7555025c3419750fb872a147870` (2026-09-30T13:02:33-05:00) | `git log` |
| Backend local HEAD | `ea7af1a5ecc8cf1ed4326449d6fc6cab5832c772` (2026-09-30T13:02:27-05:00) | `git log` |
| Internal contract version | `3.1.0` | `src/contract.ts` |
| Plugin manifest | `plugin.json` v`1.0.0` | `plugin.json` |
| Deploy workflow | `.github/workflows/deploy.yml` -> `cdk deploy` context `environment=<dev|staging|prod>` | same |
| Backend deploy | separate (report-generator stacks); `AllAtOnce` alias deploy per runbook | `mcp-runbook.md` |

Deployed-vs-local: prod MCP `LastModified 2026-09-29T23:58` predates the reviewed
HEAD `5a4ead6` (`2026-09-30T13:02`); dev MCP `2026-09-30T18:04` is the most recent
deploy. Confirm the exact deployed commit SHA during the next discovery pass
(the workflow does not stamp a commit SHA into the function).

## 9. Consent route (PRIV-01 step 2)

The deployed authorization-server metadata advertises
`authorization_endpoint = https://login.mutantgenomics.com/oauth2/authorize`,
the **Cognito hosted UI**. Therefore the ChatGPT connector OAuth flow goes
directly to the hosted UI and does **not** transit the portal's custom
`ChatGPTAuthorizePage.js` (`front-end-web/front-end-web/src/components/ChatGPTAuthorizePage.js`).

Implication: consent enforcement for the ChatGPT integration cannot rely on the
custom authorize page. It must be enforced at the backend/resource boundary
(PRIV-04) and, if a portal consent step is required, inserted around the hosted-UI
flow (PRIV-05). Full confirmation requires the synthetic-account walk
(`discovery-runbook.md` step 5); this pass confirms the advertised route only.

Owner portal/onboarding consent still lives on `OnboardingPage.js`, reached on the
portal path. `OnboardingPage.handleContinue` currently returns early but does not
cancel the React Router link navigation (review finding 2) — relevant to PRIV-05,
not fixed here.

## 10. Unknowns needing a follow-up discovery pass

| Unknown | Why it matters | Owner | Blocking ticket |
|---|---|---|---|
| MCP `MUTANT_DEV_MODE` deployed value | dev mode accepts synthetic tokens | MCP/infra | PRIV-08 |
| Exact deployed commit SHA per function | release evidence | release | PRIV-10 |
| Prod connector app client id | scope/consent enforcement | auth | PRIV-04, PRIV-08 |
| `MUTANT_SERVICE_LAMBDA_ARN` targeted alias | backend authority | backend | PRIV-04 |
| Portal build root + deploy mechanism | policy/consent publish path | portal | PRIV-05, PRIV-09 |
| Portal served artifact commit | policy accuracy | portal | PRIV-09 |
| Prod `analysis.read` scope anomaly | consent/scope enforcement | auth/infra | PRIV-04, PRIV-08 |
| Backend log retention (`None`) | retention commitments | infra | PRIV-06 |
| Adopted vs created MCP log groups | retention scope | infra | PRIV-06 |
| Deployed integration-revocation behavior | withdrawal/revocation enforcement | MCP/backend | PRIV-08 |

## 11. PRIV-08 integration revocation evidence

Version: 1.0 (2026-10-02). Records identifiers and automated results only, never
secrets or real subject data. The deployed synthetic-account walk is **pending**;
until it runs, PRIV-08 stays open (see `owner-decisions.md` D1/D3/D5, C1).

### 11a. Implementation surface

| Component | Location | Contract |
|---|---|---|
| Grant state (`connected`/`disconnected`, `revoked_at_epoch`) | `report-generator/core/consent.py` (`INTEGRATION#<client_id>`) | row keyed `(subject_id, client_id)` |
| Boundary guard (fail closed) | `report-generator/mcp/integration.py` via `mcp/dispatch.py` (after deletion + consent) | `INTEGRATION_REVOKED` |
| Disconnect route | `report-generator/core/routes_consent.py` (`POST /consent/disconnect`) | `provider_revoked` reported separately |
| Provider revoke | `core/routes_consent.py:_default_revoke_provider` | Cognito `RevokeToken`; secret only if configured |
| MCP surface | `mutant-mcp/src/contract.ts` 3.3.0, `src/auth/user-context.ts`, `src/clients/mutant-lambda-client.ts`, `src/tools/respond.ts` | `identity.issued_at`, `_meta.mutant.integration` |

### 11b. Automated evidence (in-repo, synthetic only)

| Check | Test | Result |
|---|---|---|
| Disconnect withdraws sharing and sets the grant `disconnected` | `test/test_routes_consent.py` | pass |
| Token issued at/before the relink boundary is fenced; a later token is honored | `test/test_routes_consent.py::test_accept_after_disconnect_clears_the_fence` | pass |
| Grant is scoped per subject and client; other clients preserved | `test/test_routes_consent.py::test_disconnect_is_scoped_and_preserves_other_clients` | pass |
| `RevokeToken` uses the public client id; secret attached only when configured | `test/test_routes_consent.py` | pass |
| Sensitive read refused with no payload; import refused with no side effect | `mcp/tests/test_mcp_consent.py` | pass |
| Store failure / unwired guard fails closed as `SERVICE_UNAVAILABLE` | `mcp/tests/test_mcp_consent.py` | pass |
| Exempt operations (`get_analysis_status`, `get_snp_catalog`) unaffected | `mcp/tests/test_mcp_consent.py` | pass |
| Two clients / two subjects independent; withdrawal seen on the next request | `mcp/tests/test_mcp_consent.py` | pass |
| `issued_at` comes only from verified identity, bounded, never from arguments | `mcp/tests/test_mcp_consent.py` | pass |

### 11c. Deployed synthetic-account walk (pending)

| Step | Expected | Status |
|---|---|---|
| Connect synthetic account, import, then `POST /consent/disconnect` | grant `disconnected`, receipt `provider_revoked` reported | Pending (C1) |
| Reuse the captured access token for a sensitive read | `INTEGRATION_REVOKED`, no payload | Pending |
| Refresh after disconnect | refresh fails (provider revoked) or documented limitation | Pending |
| Reconnect via renewed authorization | grant `connected`, fresh token honored, stale token still fenced | Pending |
| Confirm unrelated portal client access for the same subject | unaffected | Pending |

### 11d. Configuration identifiers

| Item | Value | Source |
|---|---|---|
| Dev connector client id | `1hi6c97v6md1q68h91ld37tre4` | §5, `mcp-runbook.md` |
| Prod connector client id | `[TBD — D3]` | §5 |
| Deployed `MUTANT_CONSENT_CLIENT_IDS` | `[TBD — D3]`; empty means "any bounded id" | `core/consent.py` |
| `MUTANT_COGNITO_CLIENT_SECRET` | `[secret]`; expected unset (public client) | design |
| `MUTANT_DEV_MODE` (dev/prod) | `[TBD — D1]` | §2 |

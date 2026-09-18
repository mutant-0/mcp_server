# mutant-mcp runbook

Operational guide for the Mutant remote MCP server: OAuth setup, ChatGPT
linking, verification, monitoring, and rollback.

## 1. Cognito prerequisites

The MCP Lambda is a protected resource; Cognito is the authorization server.
One-time setup (Cognito console or CLI):

1. **Resource server + scopes.** Create a resource server whose identifier is the
   MCP resource URI (`MUTANT_MCP_RESOURCE_URI`, e.g.
   `https://dev-api.mutantbiotech.com/mcp`) with two custom scopes:
   - `analysis.read` — the six analysis tools, and
   - `dna.import` — `show_dna_import`, `get_snp_catalog`, `create_report`.

   Cognito composes the two into the full scopes
   `https://dev-api.mutantbiotech.com/mcp/analysis.read` and
   `https://dev-api.mutantbiotech.com/mcp/dna.import`. The runtime derives each
   required scope as `<MUTANT_MCP_RESOURCE_URI>/<name>`, so the identifier
   **must** match `MUTANT_MCP_RESOURCE_URI` exactly (no trailing slash).
2. **App client.** Use a predefined (non-secret) app client for ChatGPT:
   - OAuth flow: authorization code grant.
   - PKCE: required, `S256` only.
   - Scopes: `openid`, `<MUTANT_MCP_RESOURCE_URI>/analysis.read`,
     `<MUTANT_MCP_RESOURCE_URI>/dna.import`.
   - Allowed callback URLs: the ChatGPT connector callback
     (`https://chatgpt.com/connector_platform_oauth_redirect` — confirm the
     current value in the ChatGPT connector UI) and your dev callback.
   - No client secret.

   > **Adding `dna.import` to an existing client is a re-consent event.** A token
   > issued before the scope existed does not carry it, so the DNA tools return
   > `INSUFFICIENT_SCOPE` until the connector is relinked (§5).
3. **Resource binding (optional).** If your Cognito configuration supports the
   authorization `resource` parameter, bind it to `MUTANT_MCP_RESOURCE_URI`. The
   validator only enforces a resource indicator when the token actually carries
   one, so this is safe to leave unset.
4. **Hosted UI domain.** `MUTANT_OAUTH_ISSUER` should be the issuer URL whose
   discovery document Cognito serves (e.g.
   `https://<domain>.auth.<region>.amazoncognito.com` for the hosted UI, or
   `https://cognito-idp.<region>.amazonaws.com/<pool-id>`).

### Provisioned in the shared pool (`us-west-2_tgb5TJylh`)

Created 2026-09-12:

- **Resource server** identifier `https://dev-api.mutantbiotech.com/mcp` (the dev
  `MUTANT_MCP_RESOURCE_URI`), scopes `analysis.read` and `dna.import`
  (`https://dev-api.mutantbiotech.com/mcp/analysis.read`,
  `https://dev-api.mutantbiotech.com/mcp/dna.import`). Adding `dna.import`
  requires no redeploy of the MCP Lambda, but every existing connector must be
  relinked to receive it (§5).
- **App client** `Mutant MCP ChatGPT Connector`
  (`1hi6c97v6md1q68h91ld37tre4`): public (no secret), authorization code,
  scopes `openid https://dev-api.mutantbiotech.com/mcp/analysis.read
  https://dev-api.mutantbiotech.com/mcp/dna.import`, IdPs `COGNITO Google`.
  Callbacks:
  `https://chatgpt.com/connector_platform_oauth_redirect` (connector) plus
  `https://oauth.pstmn.io/v1/callback` and
  `https://oauth.pstmn.io/v1/browser-callback` (Postman testing only; remove
  for prod clients).
- `MUTANT_OAUTH_CLIENT_ID` must be that client id. It is supplied by the GitHub
  **secret** `MUTANT_OAUTH_CLIENT_ID`, so editing only the Lambda environment
  will be reverted by the next CDK deploy.

Two token types meet here — do not mix them:

- The **Portal** client (`7eosqbhf950il1k92itt2j7cu`) backs the report-generator
  API. Its JWT authorizer configures `audience = <client id>`, which only
  matches a Cognito **ID token** (`aud` present), so that path consumes ID
  tokens.
- MCP is an OAuth 2.1 protected resource and requires a Cognito **access
  token** (`token_use=access`), which carries `scope` and `client_id`.
  Cognito access tokens have no `aud`, so a portal ID token is rejected with
  `reason: not_access_token`. Use the dedicated client and its access token.
- The Portal client must not be granted the MCP scope; leave it untouched.

## 2. Environment

MCP Lambda (`mutant-mcp`):

| Variable | Value |
|---|---|
| `MUTANT_SERVICE_LAMBDA_ARN` | report-generator alias ARN |
| `MUTANT_OAUTH_ISSUER` | Cognito issuer |
| `MUTANT_OAUTH_CLIENT_ID` | ChatGPT app client id |
| `MUTANT_OAUTH_SCOPE` | leave **empty** to derive `<MUTANT_MCP_RESOURCE_URI>/analysis.read`; set only to override |
| `MUTANT_OAUTH_SCOPE_DNA_IMPORT` | leave **empty** to derive `<MUTANT_MCP_RESOURCE_URI>/dna.import`; set only to override |
| `MUTANT_MCP_RESOURCE_URI` | e.g. `https://dev-api.mutantbiotech.com/mcp` |
| `MUTANT_CORS_ORIGINS` | `https://chatgpt.com,https://chat.openai.com` |
| `MUTANT_UPGRADE_URL` | `https://mutantgenomics.com/cart` |
| `MUTANT_SNP_CATALOG_MAX_BYTES` | optional, default `2000000` (per-tool cap for `get_snp_catalog`) |
| `MUTANT_MAX_REQUEST_BYTES` | optional, default `5242880` (cap for `create_report` payloads) |

report-generator Lambda:

| Variable | Value |
|---|---|
| `MCP_CURSOR_SECRET` | long random value (per environment) |
| `MUTANT_UPGRADE_URL` | `https://mutantgenomics.com/cart` |

`ENTITLEMENTS_TABLE` and its IAM already exist. The MCP role intentionally has
**no** `UserEntitlements` read permission: entitlement is resolved in the backend.

## 3. Verifying discovery and auth

The MCP API is mounted behind an API Gateway mapping key (`/mcp`), which strips
the prefix before the Lambda. The same Lambda also serves OAuth discovery at the
**host root**: the stack adds a second `.well-known` mapping to the custom domain
so RFC 8414 / RFC 9728 clients can find the documents where they look, even
though the root path otherwise belongs to the report-generator API.

```bash
# Canonical root form (issuer origin) — what RFC 8414 clients fetch:
curl -s https://<mcp-host>/.well-known/oauth-authorization-server | jq
curl -s https://<mcp-host>/.well-known/oauth-protected-resource | jq
# RFC 9728 resource-path form — what the 401 challenge advertises:
curl -s https://<mcp-host>/.well-known/oauth-protected-resource/mcp | jq
# Mount form (also served):
curl -s https://<mcp-host>/mcp/.well-known/oauth-protected-resource | jq
curl -s https://<mcp-host>/mcp/.well-known/oauth-authorization-server | jq '.code_challenge_methods_supported'
# Expect 401 + challenge without a token (note the `resource_metadata` and `scope` values):
curl -si https://<mcp-host>/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -i www-authenticate
```

The `.well-known` mapping means API Gateway strips that prefix too, so the Lambda
receives `/oauth-authorization-server` and `/oauth-protected-resource`; the handler
accepts the root, mount-prefixed, and prefix-stripped forms.

`resource_metadata` is built as
`<origin>/.well-known/oauth-protected-resource<resource-path>` (the well-known
segment goes before the resource path, never suffixed onto the resource URI), and
the challenge advertises the canonical URI-form scope
`https://dev-api.mutantbiotech.com/mcp/analysis.read`.

Checklist:

- AS metadata `issuer` equals the MCP host origin (e.g.
  `https://dev-api.mutantbiotech.com`), matching the origin serving the document;
  endpoints point at the Cognito custom domain (`https://login.mutantgenomics.com/oauth2/...`).
- AS metadata `scopes_supported` is exactly
  `["https://dev-api.mutantbiotech.com/mcp/analysis.read",
  "https://dev-api.mutantbiotech.com/mcp/dna.import"]` (i.e.
  `<MUTANT_MCP_RESOURCE_URI>/<scope name>` for both scopes), and it
  advertises `authorization_code`, `refresh_token`, and
  `code_challenge_methods_supported: ["S256"]`.
- PRM `resource` equals `MUTANT_MCP_RESOURCE_URI`; `authorization_servers` is the
  MCP host origin (where the RFC 8414 document is served), **not** the Cognito
  issuer, whose custom domain 404s `/.well-known/oauth-authorization-server`;
  `scopes_supported` includes both scopes.
- Missing/invalid tokens yield `401` with `error="invalid_token"`; a token
  missing the scope a tool needs yields `403` (or a tool-level
  `INSUFFICIENT_SCOPE` with `error.required_scope`) naming that scope.

## 4. MCP Inspector (local/dev)

```bash
MUTANT_DEV_MODE=true npm run dev
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8080/mcp` with `Bearer dev-paid` (or `dev-free`).
All nine tools must be discoverable. Call `get_analysis_status`, then
`get_analysis_context`, then `explain_health_hypothesis` for a returned id.

To exercise the scope boundary locally, connect with `Bearer dev-readonly`
(analysis only) or `Bearer dev-dna` (DNA import only) and confirm the other
group's tools return `INSUFFICIENT_SCOPE` naming the missing scope.

For the DNA import flow, in `MUTANT_DEV_MODE=true` the mock backend client
returns a small synthetic catalog, `{ analysis_id, status }`, and a synthetic
analysis lifecycle: `create_report` remembers the import for the user, and
`get_analysis_status` then reports `processing` for about 20 seconds before
`ready` (with `analysis_id` and `created_at`), so the component's polling,
elapsed timer, and completion card can be driven end to end without the real
backend. `list_health_hypotheses` returns three synthetic hypotheses so the
"View my top 3 findings" call to action renders too. `get_snp_catalog` and
`create_report` are hidden from the model's tool list
(`_meta.ui.visibility: ["app"]`); call them explicitly. The synthetic analyses
live in process memory, so restarting the dev server clears them.

## 5. Linking the ChatGPT dev connector

1. Deploy backend + MCP to `dev`.
2. In ChatGPT, create a custom connector pointing at
   `https://<mcp-host>/mcp`.
3. When it requests authorization, sign in through Cognito (the hosted UI). The
   client uses authorization code + PKCE S256 and requests the scopes advertised
   in PRM: `https://dev-api.mutantbiotech.com/mcp/analysis.read` and
   `https://dev-api.mutantbiotech.com/mcp/dna.import`.
4. After linking, run the scenario prompts for a **sanitized** Free test account
   and then a **sanitized** Full test account:
   - "What does my Mutant analysis say about my health?"
   - "Show me the details of the top result."
   - "What evidence supports that?"
   - "Explore the histamine pathway." (Full)
   - "Upload my 23andMe data." (import flow: `show_dna_import` renders the component)
5. Verify: `get_analysis_status` reports the expected plan; Free searches never
   surface locked hypotheses; `analysis_version` changes after a reprocess.

### DNA import checks

- `dna_status` is `missing` before an import and `available` after one completes.
- The component parses the file locally: no request carries raw file bytes, and
  `create_report` receives only catalog-matched variants.
- **Polling completes without another prompt.** After the file is submitted the
  card polls `get_analysis_status` (about every 7 seconds) and turns into the
  completion view on its own. Watch the connector traffic: repeated
  `get_analysis_status` calls with `{}` are the component, not the model. If the
  card stalls, check whether the last read returned `ready`/`failed` or whether
  polling was capped at 10 minutes, which surfaces as the "still working" state.
- **`dev-dna` is the scope-boundary caveat.** A `dna.import`-only connection can
  import but cannot read the status, so the completion card says ChatGPT must
  report the result instead of polling. That is expected; use `dev-paid` or
  `dev-free` to see polling.
- Chromium DevTools against the connector page shows no CSP violations and no
  network calls from the iframe (the component declares an empty CSP).
- **Worker blocked?** Expected, not a failure. The component logs
  `[dna-import] worker never completed its startup handshake; parsing on the main
  thread` (and similar reasons) at `debug` level and parses on the main thread.
  Check the console for those lines before suspecting the parser. A worker that
  fails *after* it started working is reported to the user as a parse failure
  instead, since re-parsing would hide the cause.
- Submitting the same import twice with the same `import_request_id` returns the
  same `analysis_id` (backend idempotency), but `Try again` after a failed
  analysis deliberately mints a **new** key so the retry is not deduplicated onto
  the failed analysis.
- A `payload_too_large` response means the parsed payload exceeded
  `MUTANT_MAX_REQUEST_BYTES` (default 5 MiB, below the 6 MiB synchronous
  `lambda:InvokeFunction` limit). See "Rollback and limits" before raising it.

### Relinking / token refresh

- Refresh: the client uses the refresh token; no action needed. If refresh
  fails, force reauthorization.
- Reauthorization: revoke/relink the connector in ChatGPT. Cognito's `/oauth2/revoke`
  can revoke a refresh token if needed.
- **New scope added (e.g. `dna.import`):** existing connectors keep working for
  the tools whose scope they already hold, but the new tools fail with
  `INSUFFICIENT_SCOPE` until the connector is relinked. Tell users to relink, or
  rely on the tool-level challenge, which makes ChatGPT prompt for consent.
- Metadata stuck? PRM/AS metadata is cached by clients; toggling the connector
  or waiting out the client cache forces a refetch. AS metadata is cached
  in-process for 10 minutes; redeploy or wait it out.

## 6. Monitoring

- CloudWatch alarms on the MCP Lambda: `McpErrorAlarm` (errors ≥ 1) and
  `McpLatencyAlarm` (p95 > 3000 ms).
- Logs are structured JSON (`LOG_LEVEL`). Auth rejections log `oauthError`;
  backend contract failures log `[MCP] handler failure` / `[MCP] internal
  operation failed`.
- Watch for `SERVICE_UNAVAILABLE` spikes (backend invocation failures/timeouts),
  `DATA_INCOMPATIBLE` (contract/projection mismatch), and `ANALYSIS_CHANGED`
  (expected after reprocessing; a spike means clients are mixing versions).
- DNA import: `dna import submitted` / `dna import completed` lines carry
  `snpCount`, `wgsRecordCount`, `payloadBytes`, `importRequestId`, `analysisId`,
  upstream status, and duration. Genotypes are **never** logged: the logger
  redacts `snps` and `wgs_variant_calls`, and the tools log counts only. A
  genotype string in CloudWatch is a bug, not a debugging aid.
- A spike in `CATALOG_UNAVAILABLE` means the component could not fetch the SNP
  catalog (backend `get_snp_catalog` failing or slow). A spike in
  `PAYLOAD_TOO_LARGE` means real WGS payloads are approaching
  `MUTANT_MAX_REQUEST_BYTES`; see "Rollback and limits".
- `get_analysis_status` call volume is dominated by the DNA import component's
  polling: one call per open panel every ~7 seconds for up to 10 minutes while an
  analysis is processing. That is expected and bounded; a sustained rise without
  matching imports means panels are being left open on a stuck analysis.
- `INSUFFICIENT_SCOPE` on all DNA tools for every account means the Cognito
  resource server or app client is missing `dna.import`.

## 7. Rollback and limits

The stack uses immutable Docker image assets and `AllAtOnce` alias deploys on
the report-generator side.

1. MCP: redeploy the previous known-good `mutant-mcp` commit
   (`git revert` / `workflow_dispatch` from the prior SHA). The Lambda function
   update is atomic.
2. Backend: point the report-generator alias back to the previous version, or
   re-run CDK/SAM deploy from the prior commit.
3. If only OAuth config changed (client id / scope / resource URI), restore the
   previous values in the CDK context and redeploy; existing tokens remain valid
   unless the client id or scope changed.
4. Rolling back a scope: removing `dna.import` from the resource server makes the
   DNA tools unreachable (`INSUFFICIENT_SCOPE`), which is the safe direction. The
   component is inert without those tools: `show_dna_import` still renders, but
   the catalog call fails with `catalog_unavailable` and the UI surfaces an error
   rather than uploading anything.

**Payload ceiling.** The binding limit for `create_report` is the 6 MiB
synchronous `lambda:InvokeFunction` payload, not the HTTP API's 10 MB.
`MUTANT_MAX_REQUEST_BYTES` defaults to 5 MiB. Do not chunk submissions
preemptively: measure real 23andMe / Ancestry / VCF / WGS payloads first, and only
then choose staged submission or an S3 handoff. `MUTANT_MAX_REQUEST_BYTES` and
`MUTANT_SNP_CATALOG_MAX_BYTES` are optional stack variables; verify the real
`/snp-catalog` size before lowering the catalog cap.

**Vendored processor.** `src/ui/genomics/*` is generated from
`front-end-web/src/genomics`. If the component starts parsing differently from
the portal, run `npm run check:genomics` first; it fails when the vendored copy
was edited by hand or drifted from upstream. The vendored set is eight modules;
the portal's `parseInWorker.js` / `parse.worker.js` are intentionally excluded
(they fetch a catalog over the portal session, and this component injects the one
`get_snp_catalog` returned).

If `check:genomics` reports *every* module as modified, it is not drift: it is
line endings. The manifest hashes the module body with LF endings and
`mutant-mcp/.gitattributes` pins `src/ui/*` to LF, because git would otherwise
hand Windows a CRLF working tree and CI an LF one — the same commit passing in one
place and failing in the other. Re-run `npm run sync:genomics`, which writes LF
copies and rewrites the manifest, and check that `.gitattributes` is still there.
A genuine hand edit reports exactly the module that was edited.

**Worker vs main-thread divergence.** The worker path and the fallback path must
produce identical output; `tests/parse-parity.test.ts` parses every fixture both
ways and fails on any difference. If that test is failing, the two entries have
stopped sharing `parseCore.js` — fix that rather than the assertion.

**If the worker script stops being embedded** (for example, a change to
`scripts/build-ui.mjs` drops the `__DNA_IMPORT_WORKER_SOURCE__` define), the
component degrades silently to main-thread parsing: the define is absent, the
worker is skipped, and every parse happens on the UI thread. `tests/ui-resource.test.ts`
catches it by asserting the served document still contains the worker's own
strings, and `npm run build:ui` logs both byte sizes.

Because the internal contract is versioned (`contract_version: "1.0.0"`), the
MCP Lambda rejects a mismatched backend with `DATA_INCOMPATIBLE` rather than
serving partial data. Deploy backend first when changing the contract, then MCP.

## 8. Local test notes (Windows)

Vitest can fail with "Cannot read properties of undefined (reading 'config')"
when the working directory's drive-letter case differs from Node's canonical
path. Run from PowerShell or invoke from a canonical `C:\...` path:

```powershell
cd C:\ghrepos\mcp_server\mutant-mcp
npm test
```

CI runs on Linux and is unaffected.

## 9. Backend test suite

The read-only backend handlers have sanitized-fixture tests (no AWS):

```bash
cd back-end/report-generator
python -m pytest mcp/tests -q
```

Covered: account isolation, Free top-three vs Full, nested evidence restriction,
entitlement changes, snapshot change / stale cursors, projection scale/enums,
and error codes.

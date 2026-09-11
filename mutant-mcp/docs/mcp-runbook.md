# mutant-mcp runbook

Operational guide for the Mutant remote MCP server: OAuth setup, ChatGPT
linking, verification, monitoring, and rollback.

## 1. Cognito prerequisites

The MCP Lambda is a protected resource; Cognito is the authorization server.
One-time setup (Cognito console or CLI):

1. **Resource server + scope.** Create a resource server with identifier
   `mutant` and a custom scope `analysis.read`, giving the full scope string
   `mutant/analysis.read`. This scope is required on every access token.
2. **App client.** Use a predefined (non-secret) app client for ChatGPT:
   - OAuth flow: authorization code grant.
   - PKCE: required, `S256` only.
   - Scopes: `openid`, `mutant/analysis.read`.
   - Allowed callback URLs: the ChatGPT connector callback
     (`https://chatgpt.com/connector_platform_oauth_redirect` — confirm the
     current value in the ChatGPT connector UI) and your dev callback.
   - No client secret.
3. **Resource binding (optional).** If your Cognito configuration supports the
   authorization `resource` parameter, bind it to `MUTANT_MCP_RESOURCE_URI`. The
   validator only enforces a resource indicator when the token actually carries
   one, so this is safe to leave unset.
4. **Hosted UI domain.** `MUTANT_OAUTH_ISSUER` should be the issuer URL whose
   discovery document Cognito serves (e.g.
   `https://<domain>.auth.<region>.amazoncognito.com` for the hosted UI, or
   `https://cognito-idp.<region>.amazonaws.com/<pool-id>`).

## 2. Environment

MCP Lambda (`mutant-mcp`):

| Variable | Value |
|---|---|
| `MUTANT_SERVICE_LAMBDA_ARN` | report-generator alias ARN |
| `MUTANT_OAUTH_ISSUER` | Cognito issuer |
| `MUTANT_OAUTH_CLIENT_ID` | ChatGPT app client id |
| `MUTANT_OAUTH_SCOPE` | `mutant/analysis.read` |
| `MUTANT_MCP_RESOURCE_URI` | e.g. `https://dev-api.mutantbiotech.com/mcp` |
| `MUTANT_CORS_ORIGINS` | `https://chatgpt.com,https://chat.openai.com` |
| `MUTANT_UPGRADE_URL` | `https://mutantgenomics.com/cart` |

report-generator Lambda:

| Variable | Value |
|---|---|
| `MCP_CURSOR_SECRET` | long random value (per environment) |
| `MUTANT_UPGRADE_URL` | `https://mutantgenomics.com/cart` |

`ENTITLEMENTS_TABLE` and its IAM already exist. The MCP role intentionally has
**no** `UserEntitlements` read permission: entitlement is resolved in the backend.

## 3. Verifying discovery and auth

```bash
curl -s https://<mcp-host>/.well-known/oauth-protected-resource | jq
curl -s https://<mcp-host>/.well-known/oauth-authorization-server | jq '.code_challenge_methods_supported'
# Expect 401 + challenge without a token:
curl -si https://<mcp-host>/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -i www-authenticate
```

Checklist:

- PRM `resource` equals `MUTANT_MCP_RESOURCE_URI`; `authorization_servers`
  includes the Cognito issuer; `scopes_supported` includes the required scope.
- AS metadata advertises `authorization_code`, `refresh_token`, and
  `code_challenge_methods_supported: ["S256"]`.
- Missing/invalid tokens yield `401` with `error="invalid_token"`; a token
  missing the scope yields `403` with `error="insufficient_scope"`.

## 4. MCP Inspector (local/dev)

```bash
MUTANT_DEV_MODE=true npm run dev
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8080/mcp` with `Bearer dev-paid` (or `dev-free`).
All six tools must be discoverable. Call `get_analysis_status`, then
`get_analysis_context`, then `get_hypothesis_details` for a returned id.

## 5. Linking the ChatGPT dev connector

1. Deploy backend + MCP to `dev`.
2. In ChatGPT, create a custom connector pointing at
   `https://<mcp-host>/mcp`.
3. When it requests authorization, sign in through Cognito (the hosted UI). The
   client uses authorization code + PKCE S256 and requests
   `mutant/analysis.read`.
4. After linking, run the scenario prompts for a **sanitized** Free test account
   and then a **sanitized** Full test account:
   - "What does my Mutant analysis say about my health?"
   - "Show me the details of the top result."
   - "What evidence supports that?"
   - "Explore the histamine pathway." (Full)
5. Verify: `get_analysis_status` reports the expected plan; Free searches never
   surface locked hypotheses; `analysis_version` changes after a reprocess.

### Relinking / token refresh

- Refresh: the client uses the refresh token; no action needed. If refresh
  fails, force reauthorization.
- Reauthorization: revoke/relink the connector in ChatGPT. Cognito's `/oauth2/revoke`
  can revoke a refresh token if needed.
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

## 7. Rollback

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

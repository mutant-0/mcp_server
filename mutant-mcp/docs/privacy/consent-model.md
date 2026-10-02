# Consent model (PRIV-04)

Version 1.0 (2026-10-01). Backlog item: PRIV-04. Describes the durable consent
records and the authoritative server-side enforcement that replaced "UI checkbox
+ OAuth scope".

## 1. Why backend enforcement

The deployed ChatGPT connector does not transit the portal's
`ChatGPTAuthorizePage.js`; it reaches the Cognito hosted UI
(`docs/privacy/deployment-manifest.md` §9, `owner-decisions.md` §3). Portal-page
state alone therefore cannot gate the connector. Consent is enforced at the
authoritative backend resource boundary, before sensitive collection and before
every sensitive result read, so an otherwise-valid OAuth token cannot bypass it.

## 2. Purposes

| Purpose | Meaning | Required by |
|---|---|---|
| `genetic_processing` | Collect, store, and process raw DNA. | `create_report` |
| `chatgpt_sharing` | Return findings, hypotheses, and genotypes to the connector. | `get_analysis_context`, `list_health_hypotheses`, `explain_health_hypothesis`, `get_supporting_evidence`, `get_genetic_context`, `resolve_analysis_snapshot`, `resolve_analysis_followups` |

`get_analysis_status` and `get_snp_catalog` return no genetic data and require no
consent. Neither purpose is coupled to marketing or research consent.

## 3. State

Key: `(subject_id, purpose, client_id)`.

- `subject_id` is the verified Cognito `sub` (never a submitted value).
- `client_id` is the OAuth client the verified token was issued to (connector vs.
  portal), carried on `identity.client_id` and used only to partition state.
- Storage: DynamoDB table `CONSENT_TABLE` (default `ConsentRecords`), PK
  `user_id`, SK `CONSENT#<purpose>#<client_id>`. Events are append-only rows
  `CONSENT_EVENT#<iso_ts>#<uuid>`.

Record fields: `subject_id`, `purpose`, `client_id`, `notice_version`,
`notice_digest`, `status` (`accepted`/`withdrawn`), `accepted_at`,
`withdrawn_at`, `source`, `revision`. Timestamps are server-generated; acceptance
is idempotent for the current notice version; `revision` is a monotonic counter
used for optimistic concurrency.

## 4. Notice versions

The current notice version is `MUTANT_CONSENT_NOTICE_VERSION` (default
`2026-10-01`) and its digest is `MUTANT_CONSENT_NOTICE_DIGEST` (resolved
server-side only; a client can never supply a digest). A material change to the
notice or the covered purposes bumps the version; a grant recorded against an
older version no longer satisfies `has_current_consent`, so the account must
re-accept. A copy edit that is not material does not require a bump.

Acceptance of a non-current version is rejected as `INVALID_ARGUMENT`.

## 5. Client allowlist

`MUTANT_CONSENT_CLIENT_IDS` is a comma-separated allowlist of integration client
ids permitted to key consent state. Empty means "any bounded id" (development).
Unset in production is a configuration error to close alongside PRIV-01 D3.

## 6. Enforcement

Single choke point: `report-generator/mcp/dispatch.py` runs
`mcp.consent.require_consent` after `parse_request` and before the handler.

- Missing or withdrawn consent → typed `CONSENT_REQUIRED` (no payload, no side
  effect: no report row, ledger, or cache entry). `error.app_code` is
  `consent_required`; `error.next_action` routes to `show_dna_import`.
- Consent-store failure → `SERVICE_UNAVAILABLE` (fail closed). "Cannot tell" is
  never treated as "granted".
- `CONSENT_REQUIRED` is **not** an authentication/scope failure: the MCP Lambda
  never emits `mcp/www_authenticate` for it (only `AUTHENTICATION_REQUIRED` /
  `INSUFFICIENT_SCOPE` do).

## 7. Propagation bound and retention

Enforcement reads through to the store with no positive cache, so a withdrawal
takes effect on the next request that reaches the boundary. The check bounds a
synchronous request start; deletion and in-flight fencing (a request already past
the guard) are owned by PRIV-07.

Consent-evidence retention (how long accept/withdraw events are kept) is a
product decision owned by PRIV-06 and is still open. Until it is fixed, PRIV-04
remains open.

## 8. Open dependencies

PRIV-04 stays open while these PRIV-01 items are unresolved:

- **D3** — prod connector `client_id` (sets the production client allowlist).
- **D5** — prod `analysis.read` scope advertises the dev resource URI.
- **C1** — synthetic walk confirming the deployed consent route.

The hosted consent UI/flow and final wording are PRIV-05.

## 9. Consent surface (PRIV-05)

Backend enforcement (section 6) is authoritative and unchanged. PRIV-05 adds the
user-facing surface that records the grant it reads:

- **Portal route** `https://mutantgenomics.com/consent` (protected; requires a
  signed-in portal session). Reads server state via `GET /consent`, records via
  `POST /consent/accept`, revokes via `POST /consent/withdraw`. It shows the
  current notice version **before** acceptance, never preselects acceptance, and
  requires a fresh accept when `notice_version != current_notice_version`.
- **Client scoping.** The page records acceptance under the **connector** client
  id it is deep-linked with, so the connector's `(subject, purpose, client_id)`
  read is satisfied. `MUTANT_CONSENT_CLIENT_IDS` must therefore include the
  connector client id (D3) and, for the portal onboarding path, the portal client
  id. The portal reads its defaults from `REACT_APP_MUTANT_CONNECTOR_CLIENT_ID`
  and `REACT_APP_MUTANT_PORTAL_CLIENT_ID`.
- **MCP deep link.** A `CONSENT_REQUIRED` result carries
  `_meta.mutant.consent = { url, purpose, client_id }` (URL from
  `MUTANT_CONSENT_URL`, default `https://mutantgenomics.com/consent`, validated
  to https on `mutantgenomics.com`). The DNA import card opens it with
  `openLink` and re-attempts the refused call only after the user returns; the
  card never treats a local checkbox as proof. Reads (`get_analysis_context`,
  `list_health_hypotheses`) surface the same card, so sharing findings is gated
  on existing accounts, not only on a first import.
- **Deployed OAuth.** The connector reaches Cognito Hosted UI directly, so the
  OAuth screen is not the enforcement point. `ChatGPTAuthorizePage` records
  `chatgpt_sharing` best-effort on approval; the backend guard remains the gate.

## 10. Withdrawal and integration revocation (PRIV-08)

Consent and *connection* are distinct. Withdrawing the sharing purpose stops
sharing findings; revoking the integration grant additionally means the ChatGPT
connection itself is disconnected. A signature and a scope check cannot express
"this integration is not connected", so the backend records grant state and
enforces it at the resource boundary.

**Grant state.** Stored in the same `CONSENT_TABLE` (`ConsentRecords`) at
`sk = INTEGRATION#<client_id>`: `status` (`connected`/`disconnected`),
`revoked_at_epoch`, `source`, `updated_at`, `revision`. It is keyed by
`(subject_id, client_id)`, so disconnecting the ChatGPT integration does not
affect any other grant or the user's portal access.

**Disconnect action.** `POST /consent/disconnect` (authenticated; identity from
the token only) withdraws the listed purposes (default `chatgpt_sharing`),
sets the grant to `disconnected`, and best-effort revokes the provider refresh
token. It is **not** deletion: account closure remains the separate
`POST /account/deletion` action, and the receipt reports `provider_revoked`
separately from the authoritative disconnect.

**Provider revocation.** When the portal supplies the connector refresh token,
`core/routes_consent.py:_default_revoke_provider` calls Cognito `RevokeToken`
with the connector client id; a revoked refresh token can no longer mint new
access tokens, so refresh fails after revocation. Cognito requires a client
secret only for a confidential client, so the connector's public client id is
passed alone and `MUTANT_COGNITO_CLIENT_SECRET` is attached only when
configured. `AdminUserGlobalSignOut` is deliberately **not** used because it
would also end the unrelated portal session. The call stays best-effort (a
provider failure is logged and reported as `provider_revoked: false`, never
gating the disconnect): the backend grant fence is the enforcement point, and an
already-issued access token is still refused by `revoked_at_epoch` even if the
provider revoke fails.

**Reconnect.** `POST /consent/accept` is the only path that re-grants. On success
it also records the integration as `connected` and advances the token-`iat`
fence to now, so only a token issued *after* re-acceptance (the fresh OAuth
linking token) is honored. A withdrawn grant never auto-restores.

**Enforcement.** `report-generator/mcp/integration.py` runs after the consent
guard and before the handler for the same sensitive operations. A token
`issued_at <= revoked_at_epoch`, or a `disconnected` grant, is refused with
`INTEGRATION_REVOKED` and no payload/side effect. A store failure, or an unwired
guard, fails closed as `SERVICE_UNAVAILABLE`. The fence value comes from the
verified token's `iat`, forwarded as `identity.issued_at`; no tool argument can
supply it.

**Propagation bound.** The guard reads through to the store with no positive
cache, so revocation takes effect on the next request that reaches the boundary.
The token-`iat` fence covers a captured access token whose signature and expiry
are still valid, including one issued before a relink.

**MCP surface.** An `INTEGRATION_REVOKED` result carries no genetic content; the
MCP layer adds `_meta.mutant.integration = { status: "revoked", retryable, url? }`
(the URL from `MUTANT_ONBOARDING_URL`, validated to https on
`mutantgenomics.com`) so the widget can open the portal reconnect route.

**Open dependencies.** The guard, disconnect route, contract 3.3.0 surface, and
their tests are implemented (backend `core/consent.py` / `mcp/integration.py`,
MCP `src/contract.ts` 3.3.0 and `tools/respond.ts`). Like PRIV-04, PRIV-08 stays
open until PRIV-01 D1/D3/D5 and C1 are resolved and a synthetic-account walk on
the deployed candidate confirms the behavior (`deployment-manifest.md` §11).

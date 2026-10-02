# Portal consent plan (PRIV-05)

Implementation plan for the portal half of consent. Backend enforcement (PRIV-04)
and the MCP contract are already shipped; this covers the surface that records
the grant the guard reads.

Audited 2026-10-02 against `mutant-0/back-end` (report generator), `mutant-mcp`,
and the portal at `C:\ghrepos\front-end-web\front-end-web`.

## 1. Current state

Most of the portal code is already written. The gap is deployment, deep-link
survivability, and environment parity.

### 1.1 Present in the portal source

| Piece | Location |
|---|---|
| Consent page (notice, per-purpose copy, accept/withdraw, stale detection, same-origin `return` guard) | `src/components/ConsentPage.js` |
| Consent page tests | `src/components/ConsentPage.test.js` |
| API client (`getConsent`, `acceptConsent`, `withdrawConsent`, endpoint builders) | `src/api.js` (`/consent`, `/consent/accept`, `/consent/withdraw`) |
| Route registration | `src/App.js` — `<Route path="consent" element={<ProtectedRoute><ConsentPage /></ProtectedRoute>} />` |
| Onboarding gate (form submit awaits `acceptConsent` before `navigate('/genome/upload')`) | `src/components/OnboardingPage.js` |
| OAuth-authorize sharing record (best-effort `chatgpt_sharing` on approve) | `src/components/ChatGPTAuthorizePage.js` (`recordSharingConsent`) |

### 1.2 Not deployed

The live bundle `https://mutantgenomics.com/static/js/main.cfbdbc11.js` contains
**0** occurrences of `genetic_processing` and **0** of `chatgpt_sharing`. Both
strings exist in `ConsentPage.PURPOSE_COPY` and `recordSharingConsent`, so the
deployed build predates PRIV-05 entirely. The card's "Open Mutant" therefore
reaches a page that does not exist in production.

### 1.3 Cross-repo blockers

1. **Prod backend predates consent.** `mutant-report-generator`
   (`ENVIRONMENT=prod`) last built `2026-09-08T22:55`; the consent commits are
   `2026-10-01` (`1af0b13`) and `2026-10-02` (`654c894`, `ce67729`). `POST
   /consent/accept` on `api.mutantbiotech.com` has no handler. Dev
   (`dev-mutant-report-generator`, rebuilt `2026-10-02`) does.
2. **One portal host, pointing at prod.** Only `mutantgenomics.com` exists
   (CloudFront `E24PU371ANVRGN` → `mutantbt-frontend-web`).
   `.env.production` sets `REACT_APP_API_BASE=https://api.mutantbiotech.com`.
   There is no dev/staging portal host, while the ChatGPT connector under test is
   the dev one (`mutant-mcp-dev` → `dev-api.mutantbiotech.com/mcp`).
3. **`ConsentRecords` was missing.** Created 2026-10-02; its absence made both
   dev and prod paths fail closed as `SERVICE_UNAVAILABLE`, which the MCP layer
   remapped to `REPORT_GENERATION_FAILED`.
4. **`MUTANT_CONSENT_CLIENT_IDS` unset** on every function (PRIV-01 **D3**).
   Empty means "any bounded id", including the empty string.
5. **`MUTANT_CONSENT_NOTICE_VERSION` / `_DIGEST` unset** everywhere. The version
   falls back to the code default `2026-10-01`; the digest is empty.
6. **Prod function has no `CONSENT_TABLE` env var.** It falls back to the code
   default `ConsentRecords`, which matches, but this is fragile.

## 2. Decisions

### D1 - Environment strategy

The portal and the connector must target the same backend, or consent is written
where the guard never reads it.

| Option | Description | Use |
|---|---|---|
| A | Local portal (`npm start`; `.env.development` already targets `dev-api`), dev connector `MUTANT_CONSENT_URL` pointed at it | Testing only |
| B | Deploy consent to prod (backend first), then the existing `mutantgenomics.com/consent` works with a prod connector | The only option that serves a real user |
| C | Stand up `dev.mutantgenomics.com` built from `.env.development`; set `MUTANT_CONSENT_URL` on `mutant-mcp-dev` | Testing rig |

Target **B**; use **C** as the test rig.

Note: `approvedConsentUrl` in the MCP config only accepts `https` on
`mutantgenomics.com`, so option A requires a dev hostname or a temporary
widening, not just a localhost URL.

### D2 - Consent channel

ChatGPT-only users must not be forced through the portal. The correct end state
is in-chat acceptance with the portal as fallback (notice + audit, withdrawal,
disconnect). That is backend + MCP work and is tracked separately; this plan
keeps the portal primary for the current iteration and treats P0-B/P0-C as the
items that keep the detour from breaking.

## 3. Portal workstreams

### P0-A - Make `/consent` reachable in production

- Ensure a deep link to `/consent` serves `index.html` (static S3 + CloudFront
  must not return 403/404). Confirm before and after.
- Add `"/consent"` to the CloudFront invalidation list in `deploys3.ps1`. The
  script derives paths from `build/*.html`, and `reactSnap.include` in
  `package.json` does not list `/consent`.
- Leave `/consent` out of `reactSnap.include`: it is behind `ProtectedRoute` and
  `noindex`, so prerendering adds no value.

### P0-B - Deep-link survivability

`src/App.js` `ProtectedRoute` redirects unauthenticated users to `/` (the
marketing homepage), losing `purpose`, `client_id`, and `return`. A ChatGPT user
with no portal session therefore never reaches the consent page.

- Send unauthenticated users into Cognito login with the full path + query
  preserved, and land them back on `/consent?...`.
- Reuse the existing sessionStorage pattern from `ChatGPTAuthorizePage`
  (`OAUTH_PARAMS_SESSION_KEY` in `src/constants/chatgpt.js`) rather than adding a
  second mechanism.
- Only read `window.location.search` in `ConsentPage` after login.

### P0-C - "Continue in ChatGPT" is dead

`ConsentPage.safeReturnPath` honors only same-origin returns, and ChatGPT's
return URL is off-origin, so it is always dropped and the page ends with "you can
close this tab".

- Replace with a `window.close()` affordance when `window.opener` exists, else
  navigate to `buildChatGPTReturnUrl()` (`src/constants/chatgpt.js`, already
  defaults to `https://chatgpt.com/`).
- Keep `safeReturnPath` for same-site returns; do not relax the off-origin guard.

### P0-D - Portal env and client id

- Add `REACT_APP_MUTANT_CONNECTOR_CLIENT_ID=1hi6c97v6md1q68h91ld37tre4` to
  `.env.production`, `.env.development`, and the local override. Without it
  `ConsentPage.defaultClientId()` is empty and `OnboardingPage` fails with
  "Consent is not configured for this portal build". Today it survives only
  because the MCP deep link appends `client_id`.
- Confirm `REACT_APP_MUTANT_PORTAL_CLIENT_ID` if the portal should also key
  consent to its own client (`7eosq7bhf950il1k92itt2j7cu`).
- Backend pairing: an empty `client_id` is not rejected while the allowlist is
  empty (`client_id_allowed("") == True`), so an accept with no `client_id`
  writes `CONSENT#<purpose>#`, which the connector's read for its own client id
  never matches - a silent no-op. Send one from the portal, and reject empty in
  non-dev.

### P0-E - Notice content, not just a version

`ConsentPage` renders per-purpose `PURPOSE_COPY` plus links to `/privacy` and
`/data-policy`, and shows `for notice version {version}`. The UI checklist is met
(no preselect, explicit accept, stale re-accept) but no notice text is bound to
the version.

- Define the notice as a versioned constant (or fetched asset), render it inline
  before the checkbox, and keep it in lockstep with
  `MUTANT_CONSENT_NOTICE_VERSION` / `MUTANT_CONSENT_NOTICE_DIGEST`.
- A version bump without a matching notice means users accept a document they
  cannot see.

### P0-F - Disconnect parity

`ConsentPage` implements per-purpose `withdraw` but not disconnect.
`api.js` has `disconnectChatGPT()` hitting `/oauth/disconnect`, while the PRIV-08
backend surface is `POST /consent/disconnect` (withdraws purposes, flips
`INTEGRATION#<client_id>` to `disconnected`, sets the token-`iat` fence).

- Pick one authoritative path and route the profile action through it. Otherwise
  a user can "disconnect" in the portal while the backend grant stays
  `connected`.

### P1-G - Tests

Extend `ConsentPage.test.js`:

- Missing `client_id` → error state, no accept possible.
- Deep-link params (`purpose`, `client_id`, `source`, `return`) consumed.
- Stale notice (`row.notice_version !== current_notice_version`) → re-accept
  required; accept button gated on the checkbox.
- Accept never preselected and single-flight on double click.
- Withdraw round-trip.
- Unauthenticated visit preserves the query through login (P0-B).
- Off-origin `return` still rejected after P0-C.

Extend `functional.test.js` / the deploy harness if `/consent` routing is
asserted there.

## 4. Ordered rollout

1. Backend: deploy `report-generator` to prod (or dev per D1) so the consent
   routes exist; set `CONSENT_TABLE`, `MUTANT_CONSENT_CLIENT_IDS`,
   `MUTANT_CONSENT_NOTICE_VERSION`, `MUTANT_CONSENT_NOTICE_DIGEST` explicitly.
2. Portal: P0-D env, then P0-B and P0-C (small, self-contained, testable locally
   against dev-api).
3. Portal: P0-E notice content and P0-F disconnect reconciliation.
4. Build and run `deploys3.ps1`; verify `/consent` resolves and the bundle
   contains `genetic_processing`.
5. End-to-end with a synthetic account: card → Open Mutant → login (params
   preserved) → accept → "check again" → import proceeds.
6. PRIV-01 **C1** synthetic walk, capture evidence, close PRIV-04 / PRIV-05.

## 5. Acceptance

- A ChatGPT-only user with no prior portal session reaches the consent page from
  the card, is asked to sign in, and returns to `/consent` with
  `purpose`/`client_id` intact.
- Accepting writes a row the connector's guard reads
  (`CONSENT#<purpose>#1hi6c97v6md1q68h91ld37tre4`, current notice version) and the
  retry succeeds.
- Unchecked, denied, network-failed, and double-click flows never reach a
  successful submission.
- Withdraw blocks reads; disconnect blocks the connection with
  `INTEGRATION_REVOKED` and offers reconnect.
- A notice version bump forces re-accept.
- Direct URL access without a session cannot bypass; the backend still refuses a
  direct MCP call.

## 6. Traps

- **Do not** call `mark_integration_connected` from an in-chat or cookie-session
  accept path unless the token-`iat` fence is intended: it sets
  `revoked_at_epoch = now` (`core/consent.py:_write_integration`), so the live
  connector token (`issued_at < now`) is refused as `INTEGRATION_REVOKED` until a
  genuine relink. The portal accept handler does this deliberately for the
  OAuth-authorize path (`core/routes_consent.py`); it is wrong for a
  session-authenticated accept.
- The portal sends **id_token** (`idAuthHeadersWithRefresh`) while the MCP uses
  an access token; the consent routes call `_validate_auth` directly. Confirm the
  portal token shape is accepted before assuming `/consent` works.
- Seeded rows have no `CONSENT_EVENT#` history and no `notice_digest`. Portal
  acceptance writes both. Do not read seeded rows as evidence that PRIV-06
  retention is settled.

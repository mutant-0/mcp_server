# Embedded consent in ChatGPT

The consent view now reads the current notice and saves explicit choices through
app-only `get_consent` and `save_consent` tools. No portal session, direct browser
fetch, or browser tab is needed on this path. The existing website detour remains
available under "Use the website instead" if embedded tools are unavailable.

## Authorization and persistence

- `get_consent` requires existing `analysis.read`; `save_consent` requires existing
  `dna.import` (a write grant). No new OAuth scopes are defined. A connection
  missing the existing write scope must authorize it before saving.
- App-only visibility keeps consent tools out of the model's tool list. It is not
  an authorization boundary: normal token/scope checks and backend guards apply.
- Verified account/client identity reaches the existing backend consent service.
  The UI does not accept account IDs, client IDs, digests, or timestamps.
- Missing, withdrawn, and outdated grants start unchecked. Current grants are
  displayed as already accepted. Each purpose is separate; selecting one never
  silently grants or withdraws the other.
- Saving uses the displayed notice version, then rereads authoritative state.
  Failed/partial writes, version changes, or unconfirmed choices never continue.
- Consent actions cannot silently reconnect an integration. Existing withdrawal
  and disconnect controls on the website remain available.

## Continuation

Component-local recovery reuses its in-memory parsed variants and original import
idempotency key. For a blocked analytical tool, the server attaches only allowed
routing arguments in widget-only metadata. Import payloads and credentials are
never copied there. After a confirmed save the component reruns that read once,
provides its result to ChatGPT, and requests continuation of the original question.
Repeated consent rejection stops automatic retries. A panel reload may lose the
in-memory pending action; the user can repeat their original question safely.

The consent form is inline, which works without optional host modal support.
The complete notice is displayed before the acceptance controls.

## Release order and verification

Deploy the backend extension described in `back-end/report-generator/docs/embedded_chatgpt_consent.md`
first. Deploy the rebuilt MCP UI and consent tools next, keeping existing operation
schemas and UI resource addresses compatible. Verify availability of the new tools
through the applicable OpenAI review process; these edits do not deploy, publish,
or alter the existing approved submission.

Before publication, walk the flow in a ChatGPT test connection for both a new DNA
import and a saved hypothesis explanation. Verify missing/outdated/withdrawn
consent, decline, write failure, lost connection, and the website fallback. The
local UI bridge tests do not replace this host-level check.

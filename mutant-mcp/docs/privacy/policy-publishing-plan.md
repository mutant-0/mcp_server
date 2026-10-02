# Policy publishing and listing plan (PRIV-09)

Version: 1.0 (2026-10-02). Backlog item: PRIV-09. Runnable implementation plan
for the policy/listing half of the privacy review. PRIV-09 is the last ticket in
the delivery order and must not publish commitments ahead of the behavior that
implements them (`owner-decisions.md` P1-P4 stay `Open`).

Audited 2026-10-02 against the portal source at
`C:\ghrepos\front-end-web\front-end-web`, `plugin.json`, and the PRIV-01/03/04/05/06/08
artifacts (`deployment-manifest.md`, `data-inventory.md`, `data-boundaries.md`,
`consent-model.md`, `portal-consent-plan.md`, `retention-policy.md`).

## 1. Current state

### 1.1 Source policy revisions

| Document | Source file | Stated version | Aligned to notice? |
|---|---|---|---|
| Privacy Policy | `src/components/PrivacyPage.js` | "Last updated: October 1, 2026" | Yes (`MUTANT_CONSENT_NOTICE_VERSION` default `2026-10-01`) |
| DNA Data Policy | `src/components/DataPolicyPage.js` | Effective 2026-01-07; Last Updated 2026-09-18 | **No** — predates the consent notice version |

### 1.2 Source-vs-served mismatch (D6/D7)

The live portal bundle is older than the source policy. `deployment-manifest.md`
§6/§6a: served `index.html` is `2026-09-09` (ETag `5153ea1d…`), the source policy
is `2026-09-18`+, and a prior review saw a rendered `2026-01-07` policy. The
portal build root and deploy mechanism are still `TBD`; two local roots differ
(`front-end-web/` outer copy vs `front-end-web/front-end-web/` nested CRA app with
`fflate` + the react-snap include list). Nothing about the current live policy can
be treated as matching source until the deployed revision is pinned.

### 1.3 Policy text vs settled behavior

| Location | Statement | Settled behavior | Action |
|---|---|---|---|
| `DataPolicyPage.js` §2.1 | Raw DNA "not uploaded to Mutant", "not stored in Mutant systems" | Route B (portal web upload) **does** store raw bytes in S3 `mutantbt-genetic-data` (`data-inventory.md` §0/§1) | **Contradiction.** Qualify to the plugin/Route A path or describe Route B separately |
| `DataPolicyPage.js` §10 table | Local-only raw file, no server retention | Same Route B gap | Same fix |
| `PrivacyPage.js` §"Selected genetic information" | "original file is not uploaded ... through this feature" | Qualified already | Keep the qualifier; do not generalize |
| `PrivacyPage.js` §9 Retention | "automatically expired", "limited backup lifecycle" | `retention-policy.json` rows are all `pending`; P3 unset (`retention-policy.md`) | Remove/soften unsupported periods until P3 is answered |
| `PrivacyPage.js` §10 Deletion | "restrict ... while deletion proceeds", "track failures and retries", backup reapply | PRIV-07 is proposed, not yet deployed | Do not publish as current fact until PRIV-07 is closed |
| `PrivacyPage.js` §5 Integrations | "Catalog searches ... not collect your medical history" | Free text retained; residual risk documented (`data-boundaries.md` §3) | Keep, but pair with the residual-risk wording, not an absolute |
| `PrivacyPage.js` §4 Consent | "record the applicable notice version ... enforce on our servers" | PRIV-04 backend enforcement shipped; portal surface PRIV-05 pending | Accurate; bind wording to the exact notice version/digest |

## 2. Workstreams

### P0-A — Reconcile policy text with the approved inventory (backlog step 1)

- Fix the Route A/Route B raw-file contradiction in `DataPolicyPage.js` §2.1 and
  §10: the plugin parses locally and uploads no raw file; the portal web upload
  route does store the raw file under `users/<user_id>/`. State both, or state the
  route-specific behavior inline.
- Replace any absolute "never stored / never shared" language contradicted by a
  route, and any retention/deletion guarantee that outruns `retention-policy.json`
  or PRIV-07. Reference the inventory categories (selected calls, derived findings,
  optional `analysis_context`, logging, recipients, deletion, withdrawal, contact).
- Keep the PRIV-03/PRIV-02 guarantees that *are* shipped: selected-SNP transmission,
  filename not sent by the plugin, sanitized operational logs, projection of
  responses and WGS records.
- State the free-text search residual risk (catalog-topic keywords only; prompts
  cannot guarantee absence of health prose) rather than claiming search never
  receives health history.

### P0-B — Bind onboarding/authorization copy to the notice version (backlog step 2)

- Use one notice identity everywhere: `MUTANT_CONSENT_NOTICE_VERSION` and a
  computed `MUTANT_CONSENT_NOTICE_DIGEST`. The rendered notice text must match the
  version/digest the consent record stores (`consent-model.md` §4,
  `portal-consent-plan.md` P0-E).
- `ConsentPage.PURPOSE_COPY`, `OnboardingPage.js`, and any `ChatGPTAuthorizePage.js`
  sharing text must carry the same version. A copy edit that is not material does
  not need a bump; a material change does, and every copy edit must not silently
  diverge from `MUTANT_CONSENT_NOTICE_VERSION`.
- Do not claim that acceptance of one version proves acceptance of a materially
  different one; stale versions must trigger re-accept (already the PRIV-05
  behavior).

### P0-C — Fix the build/deploy source mismatch and cache invalidation (backlog step 3)

- Close PRIV-01 **D6**: confirm which portal root the hosted pipeline builds
  (outer vs nested CRA app), the build command, the S3 sync target, and the
  CloudFront distribution/invalidation.
- Close PRIV-01 **D7**: record the deployed commit SHA and the rendered policy
  version.
- Add the policy routes to the invalidation set if the deploy script derives paths
  from `build/*.html` and they are not prerendered. Add `/privacy`, `/data-policy`,
  `/terms`, `/cookie-policy`, and (per `portal-consent-plan.md` P0-A) `/consent`.
- Verify the **rendered** public pages, not source files or an HTTP 200 on the SPA
  shell. Confirm the served bundle contains the intended policy strings (the live
  bundle currently lacks `genetic_processing`/`chatgpt_sharing`, which is the same
  staleness signal).

### P0-D — Submission/listing metadata (backlog step 4)

- Fetch and read the actual supported schema
  (`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`) before adding any
  key. Do **not** invent keys in `plugin.json`.
- Add/verify the supported website, privacy-policy, terms, and support references.
  Today `plugin.json` has only `name`, `version`, `description`, and
  `extensions.com.openai.interface`; there is no privacy/terms/support/website
  field. If the schema has no field for a URL class, record that as a schema
  limitation rather than forcing an unknown key.
- Reconcile the manifest `description`/`longDescription` with the policy wording
  (no medical-records-access claim, hypotheses-not-diagnoses).

### P0-E — Launch geography and audience (backlog step 5)

- Consume P1 (countries/states), P2 (age eligibility), P4 (operating relationships
  / covered-entity facts). Until those are supplied, keep the policy geographically
  neutral and do not assert regional compliance.
- Document any additional regional requirements and describe the DTC data flow
  accurately in submission materials. Engineering closure does not settle legal
  classification or platform acceptance.

### P1-F — Tests / evidence

- Portal: assert the rendered Privacy/Data Policy pages show the expected version
  string and route to the consent notice version. Extend the existing portal
  component tests used by PRIV-05.
- Manifest: validate `plugin.json` against the fetched schema in CI; a schema
  failure (unknown key or missing required field) must fail the build.
- Deploy: after publish, fetch the live policy pages and assert the version string;
  a stale-served policy must fail the check (closes the D7 loop).

## 3. Ordered rollout

1. Resolve PRIV-01 D6 (build root/deploy mechanism) — nothing downstream can be
   verified without it.
2. Land PRIV-05 notice binding (P0-B) so the policy version and the consent notice
   version are the same object.
3. Apply the policy text reconciliation (P0-A) once PRIV-02 through PRIV-08 have
   settled their commitments; do not publish retention/deletion promises first.
4. Apply D6/D7 deploy fixes and invalidations (P0-C), then build and publish.
5. Update `plugin.json` metadata against the fetched schema (P0-D).
6. Fold in P0-E once P1/P2/P4 are answered.
7. Publish, then run the live verification (P1-F) and capture evidence for PRIV-10.

## 4. Acceptance mapping

- Live public pages show the intended version and match tested behavior
  (P0-A/P0-B/P0-C, verified by P1-F).
- Links work without login (P0-C/P0-D; the privacy pages are `noindex` but must be
  publicly reachable).
- Consent records resolve to the exact accepted notice (P0-B).
- No retention promise exceeds demonstrated controls (P0-A gated on PRIV-06/P3).
- Listing data validates against the current supported schema (P0-D/P1-F).

## 5. Traps

- **Do not** publish the PRIV-07 deletion narrative as current fact before PRIV-07
  ships; today's deletion is report/account-genomic only and does not cover logs,
  backups, ChatGPT copies, or consent evidence.
- **Do not** publish retention periods while `retention-policy.json` rows are
  `pending`; the loader rejects a `decided` row without a positive period, and a
  policy period the deployed config cannot meet is a false statement.
- **Do not** add keys to `plugin.json` without the fetched schema; an unknown key
  can fail store validation and is easy to miss because the file is otherwise
  static.
- **Do not** treat a source edit, an HTTP 200, or the SPA shell as proof the live
  policy updated; verify the rendered document and the served bundle strings.
- **Do not** claim the plugin path stores raw DNA (it does not) or that the portal
  path does not (it does). Both statements exist today and must not be swapped.

## 6. Open dependencies

| Item | Source | Blocks |
|---|---|---|
| D6 portal build root + deploy mechanism | `owner-decisions.md` | P0-C, P0-A verification |
| D7 rendered live policy version / served commit | `owner-decisions.md` | P0-C |
| P1 launch countries/states, P2 age, P4 covered-entity facts | `owner-decisions.md` | P0-E |
| P3 retention/deletion/evidence periods | `owner-decisions.md` | P0-A retention wording |
| PRIV-07 deletion shipped | backlog | P0-A deletion wording |
| Notice version/digest bound in UI | `portal-consent-plan.md` P0-E | P0-B |

PRIV-09 closes only when the live pages match the settled behavior and the listing
metadata validates. It stays open while any dependency above is `Open`.

## 7. Implementation status (2026-10-02)

Delivered on `main` in the portal (`C:\ghrepos\front-end-web\front-end-web`) and
`mutant-mcp`; the ticket remains **open** on the items in section 6.

- **P0-A (partial).** `DataPolicyPage.js` no longer claims the complete raw file is
  never received or stored: §2.1 is split into plugin import (local-only) and
  portal web upload (transmitted/stored, encrypted, access-restricted) and §3, §4,
  §10, and §11 are qualified to match. `PrivacyPage.js` operational-log and backup
  wording no longer asserts unsupported expiration, and §5 states the free-text
  search residual risk. **Not done:** binding the remaining retention categories to
  an owner-approved schedule (**P3**); the section still describes controls without
  periods.
- **P0-B (partial).** `DataPolicyPage.js` Last Updated aligned to `2026-10-01`, the
  consent notice version (`src/constants/consentNotice.js`,
  `MUTANT_CONSENT_NOTICE_VERSION`). The notice text itself was not changed, so no
  version bump or digest regeneration is required. **Not done:** one shared
  versioned notice asset for `OnboardingPage.js` / `ChatGPTAuthorizePage.js`
  (`ConsentPage.js` already renders `CONSENT_NOTICE`).
- **P0-C (partial).** `deploys3.ps1` invalidates `/privacy`, `/data-policy`,
  `/terms`, and `/cookie-policy` alongside the existing `/consent`. **Not done:**
  resolving PRIV-01 **D6** (which portal root the pipeline builds) and **D7**
  (served commit / rendered version); live rendered-page verification cannot run
  until they are answered.
- **P0-D (manifest done).** `plugin.json` now declares the schema-supported
  `homepage`, `author` (name/email/url), `license`, and `keywords`, covered by
  `tests/plugin-manifest.test.ts` against the vendored
  `tests/fixtures/plugin.schema.json`. **Schema limitation:** Agent Plugins 1.0.0
  defines no privacy-policy, terms, or support URL field beyond `homepage` and
  `author`; such a key would be rejected by `additionalProperties: false`. The
  published `name` pattern is malformed (matches no string), so the test asserts
  the intended lowercase-slug semantics instead.
- **P1-F (partial).** Manifest conformance runs in the existing CI test job
  (`npm test`). **Not done:** rendered-page version assertions and the post-publish
  live fetch, both dependent on P0-C.
- **P0-E.** Blocked on owner decisions **P1**, **P2**, **P4**.

Not implementation work: D6/D7 live rendering, P1/P2/P3/P4, the PRIV-07 prod
deploy, and the actual publish + invalidation run.


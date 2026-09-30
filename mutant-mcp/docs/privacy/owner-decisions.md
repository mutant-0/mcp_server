# PRIV-01 owner decisions and open unknowns

Version: 1.0 (2026-09-30). Backlog item: PRIV-01 step 5. Owners identify the
engineering/business area, not named people. **An unknown here is not a
compliant answer.** Downstream tickets do not close while a value they depend on
is `Open`.

## 1. Product-owner facts (must be supplied)

| # | Decision | Needed for | Status | Blocks |
|---|---|---|---|---|
| P1 | Initial launch countries/states | Policy wording, eligibility, regional requirements | Open | PRIV-09, PRIV-10 |
| P2 | Intended age eligibility (reconcile with platform audience rules) | Policy wording, listing | Open | PRIV-09 |
| P3 | Supportable active-data retention, deletion turnaround, backup expiry, minimum security/consent evidence retention | Retention + deletion commitments | Open | PRIV-06, PRIV-07, PRIV-09 |
| P4 | Mutant operating relationships and covered-entity facts beyond DTC-only | Classification, policy language | Open | PRIV-09, PRIV-10 |
| P5 | Whether free-text catalog search remains necessary or is replaced by catalog topic selection | Search design + residual-risk acceptance | Open | PRIV-03 |

These need not delay the PRIV-02 logging change, the deployment inventory, or the
response-field work (backlog note).

## 2. Deployment / configuration unknowns

| # | Unknown | Finding so far | Owner | Blocks |
|---|---|---|---|---|
| D1 | MCP `MUTANT_DEV_MODE` deployed value (dev + prod) | Not captured (env read out of approved scope); stack default `false` | MCP/infra | PRIV-08 |
| D2 | Exact deployed commit SHA per Lambda | prod MCP `LastModified 2026-09-29` < reviewed local HEAD `5a4ead6` (2026-09-30); workflow does not stamp SHA | release | PRIV-10 |
| D3 | Prod connector app client id + resource server scope set | dev client `1hi6c97v6md1q68h91ld37tre4`; prod client TBD | auth | PRIV-04, PRIV-08 |
| D4 | `MUTANT_SERVICE_LAMBDA_ARN` targeted report-generator alias ARN | Backend alias `live` -> v11 observed; MCP-target value TBD | backend | PRIV-04 |
| D5 | Prod `analysis.read` scope advertises the **dev** resource URI | Live prod AS/PRM: `scopes_supported[0] = https://dev-api.mutantbiotech.com/mcp/analysis.read` while `resource = https://api.mutantbiotech.com/mcp` | auth/infra | PRIV-04, PRIV-08 |
| D6 | Portal build root + hosting/deploy mechanism + served commit | Two local roots differ; served `index.html` 2026-09-09 ETag `5153ea1d…`; commit TBD | portal | PRIV-05, PRIV-09 |
| D7 | Rendered live policy version | Served artifact predates the `2026-09-18` source policy; prior review saw rendered `2026-01-07` | portal/product | PRIV-09 |
| D8 | Backend log-group retention | All four report-generator/store groups have `retentionInDays = None` (never expire) | infra | PRIV-06 |
| D9 | Whether the MCP log group is adopted (retention not applied) vs created | Both `mutant-mcp-dev`/`prod` show 30 days; confirm adopted vs created per env | infra | PRIV-06 |
| D10 | Whether the portal upload route (Route B) writes raw files today | S3 `mutantbt-genetic-data` exists with `users/` prefix behavior in code; live usage not enumerated | backend/portal | PRIV-03, PRIV-07 |
| D11 | Backend log interpolation of exception messages | `core/persistence.py` interpolates `{renew_err}`-style SDK errors into warnings (lines ~343, 400, 465, 578, 690, 758, 829, 891); replace with a classified code (PRIV-02 pattern) | backend | PRIV-06, PRIV-07 |
| D12 | Backend log retention + restricted-correlation purpose | report-generator log groups never expire (D8); truncated `user_id` still linkable; needs retention + a documented restricted channel for subject correlation | infra/backend | PRIV-06, PRIV-07 |

## 3. Consent-route decision input (PRIV-01 step 2)

**Observed (this pass):** the deployed authorization-server metadata advertises
`authorization_endpoint = https://login.mutantgenomics.com/oauth2/authorize` — the
**Cognito hosted UI**. The ChatGPT connector therefore does not transit the
portal's custom `ChatGPTAuthorizePage.js`.

**Consequence:** portal-page consent edits alone cannot gate the connector. Consent
enforcement must live at the authoritative backend/resource boundary (PRIV-04),
with any required portal step inserted around the hosted-UI flow (PRIV-05).

**Still required:** a synthetic-account walk to confirm the observed route
end-to-end and capture whether any `mutantgenomics.com` authorize/consent page is
visited (runbook §5). Until then this is "expected route", not "verified route",
and the item stays `Open`.

| # | Item | Owner | Blocks |
|---|---|---|---|
| C1 | Confirm deployed consent route via synthetic walk; record evidence | portal/MCP | PRIV-04, PRIV-05 |

## 4. Inventory gaps to close (see `data-inventory.md` §4)

| # | Gap | Owner | Blocks |
|---|---|---|---|
| I1 | No TTL/lifecycle on raw-file + SNP/derived stores | infra/backend | PRIV-06 |
| I2 | No consent records exist (collection/sharing proceed on UI state + OAuth scope) | backend/auth | PRIV-04 |
| I3 | Deletion scope excludes logs, backups, consent evidence, ChatGPT copies | backend/portal | PRIV-07 |
| I4 | Filename treated as non-sensitive but persisted | MCP/backend | PRIV-03 |
| I5 | WGS records accept arbitrary properties | MCP/backend | PRIV-03 |
| I6 | Derived findings may encode inferred context | backend | PRIV-03 |

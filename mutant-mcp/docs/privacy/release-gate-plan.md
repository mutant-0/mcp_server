# Privacy release gate (PRIV-10)

Version: 1.0 (2026-10-02). Backlog item: PRIV-10. Runnable plan and status for
the privacy release gate: the focused CI suite, the machine-readable gate
manifest, and the deployment evidence still required before the ticket closes.

Audited 2026-10-02 against `mutant-mcp` and `report-generator` (`mutant-0/back-end`).

## 1. Source of truth

`mutant-mcp/docs/privacy/release-gate.json` is the single source of truth. Every
PRIV-10 requirement has one row:

| Field | Meaning |
|---|---|
| `id`, `requirement` | Identity and the assertion being gated. |
| `kind` | `automated` (a named test), `manual` (a deployed walk), or `deploy` (a captured bundle). |
| `status` | `verified`, `pending`, or `blocked`. |
| `repo` | Owning repository (`mcp_server` or `back-end`). |
| `tests[]` | `repo` + `path` + `name` for automated rows. |
| `evidenceRef` | `path` + `section` for manual/deploy rows. |
| `note` | Free-text context. |

The loader (`infrastructure/lib/privacy-release-gate.ts`) rejects a malformed
row: an `automated` row with no `tests[]`, a `manual`/`deploy` row with no
`evidenceRef`, an unknown kind/status/repo, or a duplicate id. The verifier and
the invariants test both read the file through this loader, so they cannot
disagree.

## 2. Checks

| id | kind | status | Evidence |
|---|---|---|---|
| `consent-bypass` | automated | verified | `report-generator/mcp/tests/test_mcp_consent.py`, `tests/contract-v3.test.ts` |
| `payload-leakage` | automated | verified | `tests/response-projection.test.ts`, `tests/schemas.test.ts`, `tests/lambda-client.test.ts`, `tests/list-search-scope.test.ts` |
| `log-sanitization` | automated | verified | `tests/tool-audit.test.ts` |
| `cross-account-access` | automated | verified | `report-generator/mcp/tests/test_mcp_consent.py`, `report-generator/test/test_routes_consent.py` |
| `withdrawal` | automated | verified | `report-generator/test/test_routes_consent.py`, `report-generator/mcp/tests/test_mcp_consent.py`, `tests/contract-v3.test.ts` |
| `deletion-races` | automated | verified | `report-generator/mcp/tests/test_mcp_deletion.py` |
| `staging-walk` | manual | **pending** | `docs/privacy/deployment-manifest.md` §11c |
| `release-evidence` | deploy | **pending** | `docs/privacy/deployment-manifest.md` §8 |
| `golden-routing-provenance` | manual | **pending** | `docs/privacy/discovery-runbook.md` §5 |

The six automated rows cover backlog step 1. The three pending rows are backlog
steps 2, 3, and 5; they require AWS/Cognito access and a manual ChatGPT session
and are not asserted here.

## 3. Running the gate

MCP (from `mutant-mcp/`):

```powershell
npm run test:privacy          # focused privacy suite (consent, payload, logs, cross-account, withdrawal, deletion)
npm run verify:privacy        # resolve every automated test id; fail on a broken id
npm run verify:privacy -- --release   # additionally fail while a manual/deploy row is not verified
```

Backend (from `report-generator/`):

```powershell
pytest -m privacy --tb=short  # the same consent/withdrawal/deletion/cross-account modules
```

`verify:privacy` is read-only and writes `privacy-release-report.json` (gitignored).
It fails when an automated id no longer resolves to a named test. `--release` is
the true gate: it also fails while any `manual`/`deploy` row is not `verified`.

The full `npm test` and `pytest -m "not integration"` runs still cover everything;
the focused commands exist to make the gate visible and addressable in CI.

## 4. CI wiring

- `mutant-mcp/.github/workflows/deploy.yml` (test job) runs `npm run test:privacy`
  then `npm run verify:privacy`.
- `.github/workflows/deploy-report-generator.yml` (test job) runs
  `pytest -m privacy --tb=short`.
- `mutant-mcp/tests/privacy-release-gate.test.ts` resolves every available test
  id, refuses a `verified` row without evidence, and refuses to flip a
  `pending-manual-capture` golden routing trace to observed.

In CI only `mutant-mcp` is checked out, so `back-end` test ids are reported
`external` (their repository root is absent) rather than failed.

## 5. Release evidence bundle (backlog step 3)

`verify:privacy -- --release` passes only once the three pending rows carry real
evidence. The bundle (linked from `deployment-manifest.md`) must hold:

- component revisions: MCP Lambda `CodeSha256`/`RevisionId`, backend alias
  version, portal served commit (PRIV-01 **D2/D6/D7**);
- policy and consent notice versions/digests (`MUTANT_CONSENT_NOTICE_VERSION`,
  `_DIGEST`) and the portal build that serves them;
- the approved data inventory categories and configured consent client ids
  (**D3**);
- deployed retention/access settings for every inventory store
  (`verify:retention` emits `retention-report.json`);
- deletion and withdrawal outcomes from the staging walk, and the observed
  ChatGPT routing traces from the designated synthetic capture.

Remove credentials and real identifiers. Record secrets by name only
(`[secret]`), never by value. Synthetic fixtures only.

## 6. What stays open

PRIV-10 closes only when every applicable row is `verified` and PRIV-01's
decisions (`C1`, `D1`, `D2`, `D3`, `D5`, `D6`, `D7`) and the PRIV-06 **P3**
retention decision are resolved. A `pending` row is not a pass, and a boolean
edited to `true` without a test or evidence reference is not evidence.

## 7. Traps

- **Do not** add an `automated` row without a real, named test; the verifier and
  the invariants test both resolve `tests[].name` against the file.
- **Do not** mark `golden-routing-provenance` verified from a privacy change; a
  privacy fix does not make an incomplete trace an observed one.
- **Do not** report the gate green in `--release` while a manual/deploy row is
  pending, and do not treat a `PARTIAL` (external repository) result as verified.
- **Do not** commit `privacy-release-report.json`; it is generated output.

# PRIV-03 data boundaries

Version: 1.0 (2026-09-30). Backlog item: PRIV-03 steps 1-5. Companion to
`data-inventory.md` (PRIV-01); records the decisions the ticket's acceptance
criteria require, not a compliance claim.

## 1. Input boundary (`create_report`)

| Field | Accepted | Forwarded to backend | Stored |
|---|---|---|---|
| `snps` | rsID -> two-base genotype, <= 20000 | yes | yes (`UserGenomics`) |
| `wgs_variant_calls` | allowlisted VCF fields (below), <= 500 targets | projected allowlist only | yes |
| `upload_meta.provider` | non-identifying label | yes | yes |
| `upload_meta.source_format` | non-identifying format | yes | yes (new, optional) |
| `upload_meta.genome_build` | non-identifying build | yes | yes (new, optional) |
| `upload_meta.file_size_bytes` | non-negative integer | yes | yes |
| `upload_meta.file_name` | optional (legacy/portal) | **no** — stripped by the MCP handler (`src/tools/dna-payload.ts`) | backend `report_meta` if a non-MCP caller supplies it |
| `analysis_context` | `XX`/`XY` + confidence, strict | yes | **never** (request-only; `del`-ed in `routes_reports.py`) |
| `import_request_id` | idempotency key | yes | ledger row |
| identity (`user_id`, `email`, `sub`, `account_id`, `analysis_id`) | **rejected** (strict input schema) | no | no |

The plugin (`src/ui/dna-import/app.tsx`) sends provider, `source_format`,
`genome_build` (when detected), and size — never the filename. The filename is
shown in the local review screen and discarded with the iframe. This resolves the
PRIV-03 step 1 item: the filename is no longer described as intrinsically
non-sensitive, and no server-side purpose is established for the plugin path.

### WGS allowlist

The reports-generator normalizer (`core/wgs_normalizer.py`) reads only these VCF
record fields, so they are the only fields projected through. Both boundaries
enforce it independently:

- MCP: `src/tools/dna-payload.ts` (`projectWgsVariantCalls`)
- Backend: `report-generator/mcp/contract.py` (`WGS_RECORD_FIELDS`)

`chromosome`, `position`, `ref`, `alts` (or the `alt` alias), `gt`, `filter`.
Entry envelope: `schema_version`, `source_format`, `genome_build`, `records`.

Dropped: `qual`, `gq`, `dp`, `ad`, `phased`, `vcf_id`, `info`, sample labels, raw
headers, comments, and any unknown property. These were never read by the
algorithms; they are now removed before transport and before persistence. No
scoring behavior changes — see the normalization and parity tests.

## 2. Output boundary

Every tool result passes through `src/responses/projections.ts` in the tool
wrapper (`src/tools/index.ts`):

- `structuredContent` is projected against the tool's own declared output schema.
  Unknown/debug/account fields are dropped at any depth; declared fields survive.
- `_meta` is pruned to sanctioned keys. Metadata is not an alternative channel for
  a field the payload contract excludes.
- Union branches are chosen by validation; an unmatched value is dropped.
- Errors are projected the same way.

Per-tool sensitive fields are therefore explicit and reviewable in
`src/schemas/outputs.ts`. `genotype` appears only in the marker-detail schemas; the
broad list, overview, context, and status tools do not declare it, so it cannot be
returned there.

## 3. Search design decision (PRIV-03 step 5)

**Decision: retain catalog-topic free-text `query` in `list_health_hypotheses`.**
(Owner decision requested in the backlog; the default in the ticket's "narrower
design" is *not* adopted now because a catalog-topic-ID + discovery-route design
would require migrating model instructions, backend search, schema, and routing
fixtures together, and no product owner has chosen that path.)

Current controls on the retained free text:

- The tool description instructs the model to send catalog-topic keywords only,
  never patient-specific health information.
- The backend searches only catalog/ranked search fields (name, summary,
  plain-language summary, type) and returns hypotheses, not the query. The text
  block for a no-match never echoes the query (`presentation/content.ts`
  `searchMissContent`).
- The query is not persisted as such (it is a read), and PRIV-02 removed it from
  ordinary logs; it is captured only for an explicitly designated synthetic
  session.

### Residual risk (must remain documented)

Prompts and regexes **cannot guarantee** the absence of personal health history.
A user can put health prose into a free-text search, and the model may forward it.
The query is an ordinary read argument, so this is a lower-risk surface than the
DNA payloads, but it is not zero. Closing this residual risk fully requires the
catalog-topic-ID design (or equivalent), which remains available as a follow-up;
until then this ticket does not claim the free-text path is privacy-safe, only
that its risk is documented and bounded.

## 4. Open follow-ups

- Portal (Route B) callers still may send `file_name`; if the portal path is not
  needed server-side, PRIV-05/PRIV-09 should retire it there too.
- Backend logs interpolate exception text and truncate `user_id`
  (`D11`/`D12` in `owner-decisions.md`) — not changed here.
- The projection enforces the schema; it does not decide *which* fields the schema
  should declare. Adding a field to a loose output schema is the review point.

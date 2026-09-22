# mutant-mcp

A deployable, stateless [Model Context Protocol](https://modelcontextprotocol.io)
server for Mutant Genomics. It runs as an AWS Lambda behind API Gateway at a
custom domain (e.g. `https://dev-api.mutantbiotech.com/mcp`), authenticates users
with Mutant's Cognito OAuth (authorization code + PKCE S256), and exposes the
**nine-tool contract 2.0.0** backed by the existing `report-generator` Lambda,
plus a [ChatGPT Apps SDK](https://developers.openai.com/apps-sdk) component for
DNA import.

The MCP Lambda is a thin, authenticated transport. **All business rules live in
the backend** (`back-end/report-generator/mcp`): current-snapshot resolution,
account ownership, entitlement (`UserEntitlements`), the Free top-three policy,
hypothesis/evidence retrieval, projection, filtering, pagination, and cursor
validation. The MCP Lambda never reads entitlements and never accepts an
analysis id, account, or plan from tool arguments.

### DNA import

`show_dna_import` renders a self-contained Apps SDK component that parses the
user's raw DNA file **locally in the iframe**. Only the variants present in the
Mutant catalog ever leave the browser, are submitted through `create_report`, and
are persisted by the backend. The raw file is never uploaded.

The component owns the entire asynchronous lifecycle. It reads
`get_analysis_status` on mount (so a rerender or a reopened panel resumes an
in-flight analysis instead of starting a new one), polls that tool itself after
`create_report` until the analysis is `ready` or `failed`, shows an elapsed timer
rather than a countdown or a simulated percentage, and transforms the same card
in place into the completion view. The user never has to ask ChatGPT whether
processing finished. `show_dna_import` returns only `{ ui_rendered: true, mode }`
(plus widget-only `_meta.mutant.mode`), so there is no stale status for the model
to narrate.

The completion view also renders state-aware `suggested_prompts` as chips (from
`get_analysis_context`), and — when `get_analysis_status` reports
`regenerate: true` with a usable current analysis — an optional refresh banner.
A required refresh (failed analysis) is handled by the recovery card instead.

Two scopes gate the surface: the six analysis tools require `analysis.read`, and
`show_dna_import` / `get_snp_catalog` / `create_report` require `dna.import`.
Because importing DNA creates user data, a read-only grant can never trigger it.
A `dna.import`-only grant still imports, but the completion card explains that
ChatGPT reports the result because the panel cannot read the status itself.

## Architecture

```text
ChatGPT connector
    20|   |  OAuth 2.1 PKCE S256 + Bearer token (analysis.read + dna.import)
   |  (PRM + AS discovery served by this Lambda)
   v
API Gateway HTTP API  $default (catch-all)
   |
   v
Mutant MCP Lambda (Node HTTP server on :8080)
   |-- OAuth discovery + token validation (jose / OIDC JWKS)
   |-- Nine MCP tools (schemas, envelope, deterministic content, per-tool scopes)
   |-- Apps SDK resource ui://mutant/dna-import/v1.html
   `-- Versioned internal contract 2.0.0 (direct InvokeCommand, IAM-scoped)
          |
          v
Report-generator Lambda  (mcp package)
    35|   |-- Snapshot + entitlement resolution
   |-- Free top-three / Full scope
   |-- v3 projection, pagination, cursors
   |-- get_snp_catalog / create_report (DNA import)
   `-- ToolResponse envelope (ok/data/error, analysis_version, next_cursor)
```

The DNA import component runs entirely inside the host iframe and declares an
**empty CSP** (no `connectDomains`, no `resourceDomains`): it has no document
origin to load assets from and reaches the server only through the host bridge
(`tools/call`). It reads the raw DNA file in a Web Worker started from a `blob:`
URL, falling back to the main thread when the host blocks that worker — which is
possible precisely because `_meta.ui.csp` has no `worker-src` directive.

## Layout

```text
mutant-mcp/
├── src/
│   ├── handler.ts                 # HTTP server entry (Lambda Web Adapter :8080)
│   ├── http-handler.ts            # routing, OAuth discovery, 401 challenges
│   ├── server.ts                  # McpServer + instructions + UI resource
│   ├── logger.ts                  # pino with genotype redaction
│   ├── config.ts                  # env loading/validation (Zod)
│   ├── contract.ts                # contract 2.0.0 constants + types
│   ├── auth/
│   │   ├── token-validator.ts     # JWT/JWKS + client/scope/resource checks
│   │   ├── oauth-metadata.ts      # RFC 9728 PRM + AS metadata mirror
│   │   └── user-context.ts        # MutantUserContext (userId + scopes)
│   ├── tools/                     # nine tool definitions + registration
│   │   └── scope-guard.ts         # per-tool scope enforcement
│   ├── schemas/                   # Zod input + shared envelope schemas
│   ├── presentation/              # deterministic content builders + prompts
│   ├── clients/
│   │   └── mutant-lambda-client.ts# versioned internal contract + envelope parse
│   ├── ui/
│   │   ├── dna-import/
│   │   │   ├── main.tsx           # browser entry: mounts the component
│   │   │   ├── app.tsx            # Apps SDK component (React)
│   │   │   ├── parseFile.js       # worker-preferred parse entry + fallback
│   │   │   ├── parseCore.js       # shared parse core (both entries call it)
│   │   │   ├── workerEntry.js     # parser worker script (bundled separately)
│   │   │   ├── worker-protocol.js # worker <-> client message types
│   │   │   ├── resource.ts        # registers ui://mutant/dna-import/v1.html
│   │   │   └── generated/html.ts  # GENERATED: bundled component document
│   │   ├── genomics/              # GENERATED: vendored portal DNA processor
│   │   └── api.js                 # GENERATED: portal-free fetchSnpCatalog shim
│   └── responses/
│       ├── errors.ts              # JSON-RPC + WWW-Authenticate challenges
│       └── tool-result.ts         # envelope -> CallToolResult + deterministic content
├── scripts/
│   ├── build-ui.mjs               # esbuild -> generated/html.ts
│   └── sync-genomics.mjs          # vendor front-end-web/src/genomics (+ --check)
├── docs/
│   ├── mcp-contract.md            # implemented schemas, semantics, error codes
│   └── mcp-runbook.md             # Cognito/OAuth setup, linking, monitoring
├── tests/                         # Vitest
├── infrastructure/                # AWS CDK v2 (TypeScript)
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Tool catalog

| Tool | Scope | Purpose |
|---|---|---|
| `get_analysis_status` | `analysis.read` | Routing gate: `dna_status`, `analysis_status`, entitlement/capabilities, a mandatory `regenerate` flag (+ `regeneration` details), and an object `next_action`/`optional_actions`. Polled by the DNA import component while an analysis is processing. |
| `get_analysis_context` | `analysis.read` | **Start here.** The versioned interpretation contract, coverage, access scope, a compact top-three hypothesis preview, and suggested prompts. |
| `list_health_hypotheses` | `analysis.read` | List/search hypotheses (`items` + `next_cursor`; Free: fixed top three, Full: whole set). |
| `explain_health_hypothesis` | `analysis.read` | Explanation-ready projection: scores, why-ranked, contributing patterns, clinical context, confirmation plan, guardrails. |
| `get_supporting_evidence` | `analysis.read` | Stored patterns, deduped variant contributions, cited sources, or full test guidance (`kind: "tests"`). |
| `get_genetic_context` | `analysis.read` | Markers aggregated by rsID with pattern memberships (Free) or module/gene/rsIDs (Full); optional `modules`. |
| `show_dna_import` | `dna.import` | Renders the DNA import component, which owns import, submission, polling, and the completion UI. No backend call, no echoed status. |
| `get_snp_catalog` | `dna.import` | Returns the SNP catalog to the component (`app` visibility only). |
| `create_report` | `dna.import` | Creates an analysis from locally processed variants (`app` visibility only). |

The same tool definitions are exposed to Free and Full accounts; access limits
are enforced in the backend and returned as structured errors
(`PLAN_ACCESS_REQUIRED`, `HYPOTHESIS_SCOPE_REQUIRED`). Calling a tool without its
scope returns `INSUFFICIENT_SCOPE` with the missing scope, which makes ChatGPT
re-consent instead of failing opaquely.

`create_report` also accepts an optional, request-only `analysis_context`
(`sex_chromosome_pattern` / `sex_chromosome_confidence`), derived locally from the
raw file and sent only for a high-confidence `XX`/`XY` detection. The backend uses
it in memory to evaluate sex-specific perfect-storm conditions and never persists,
caches, queues, logs, traces, or echoes it; it is excluded from every log record.

### The shared DNA processor

`src/ui/genomics/*` is **generated**: `scripts/sync-genomics.mjs` copies it
verbatim from `front-end-web/src/genomics/`, so the portal and the ChatGPT
component parse 23andMe / Ancestry / VCF / gzipped VCF input with the same code.
The vendored set is deliberately nine modules — the loader and the format
parsers, `catalog.js` (indexes only), `sexChromosome.js` (`parse.js` imports it),
and `stream.js`. The portal's own
`parseInWorker.js` / `parse.worker.js` are **not** vendored: they fetch a catalog
over the portal's HTTP session and return a different result shape, whereas this
component injects the catalog `get_snp_catalog` gave it and runs everything
through `workerEntry.js`.
`npm run check:genomics` fails the build if a vendored module was edited by hand
or drifted from upstream, and `tests/genomics-parity.test.ts` pins the same
behaviour on golden fixtures. Never edit those files directly — change the
upstream module and re-run `npm run sync:genomics`.

### Worker parsing in the DNA import component

`tests/parse-parity.test.ts` is the guard on the one rule that matters here:
**the worker path and the main-thread fallback must be the same parser.**
`parseFile.js` calls `parseDnaFileCore` with `cooperative: false` inside the
worker and with `cooperative: true` on the main thread, and the two results must
be identical.

| Situation | Behaviour |
|---|---|
| Host allows the `blob:` worker | Worker runs `workerEntry.js`; object URL revoked after the handshake, worker terminated on completion or abort |
| Host blocks it, no `Worker`, or the file cannot be cloned | Same parser on the main thread, yielding roughly every 24 ms so the iframe keeps painting |
| Worker dies **before** producing anything | Silent fallback — nothing has been parsed, so no progress is lost |
| Worker dies **after** producing output | Surfaced as an error; re-parsing would restart progress from zero and hide the cause |

Readiness is a handshake, not `new Worker()` succeeding: the worker posts
`{type:"ready"}` when its script starts executing, and the client waits at most
1.5 s for that message. A `blob:` script blocked by the host's composed
`script-src` constructs fine and then never runs, which is exactly the case the
timeout catches.

## Local development

Dev mode accepts `dev-free`, `dev-paid`, or `dev` bearer tokens instead of a
live OIDC provider:

```bash
npm install
MUTANT_DEV_MODE=true npm run dev
```

The server listens on port `8080`.

### Smoke test

```bash
MUTANT_DEV_MODE=true npm run dev
# in another terminal
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8080/mcp` with `Bearer dev-paid` or `Bearer dev-free`.
All nine tools are discoverable. The `dev-*` tokens carry different scopes so the
per-tool authorization boundary can be exercised locally:

| Token | Scopes granted |
|---|---|
| `dev`, `dev-free`, `dev-paid` | `analysis.read` + `dna.import` |
| `dev-readonly` | `analysis.read` only — the DNA tools return `INSUFFICIENT_SCOPE` |
| `dev-dna` | `dna.import` only — the analysis tools return `INSUFFICIENT_SCOPE` |

See `docs/mcp-runbook.md` for linking the real ChatGPT dev connector.

## Testing

```bash
npm test              # builds the UI, then vitest run
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run build:ui      # esbuild -> src/ui/dna-import/generated/html.ts
npm run check:genomics# fails on any drift from front-end-web/src/genomics
```

`build:ui` runs two esbuild passes: the parser worker (`workerEntry.js`) as its
own IIFE, then the component (`main.tsx`) with that script inlined as a string.
The resulting document is ~650 KB, of which ~14 KB is the worker — it has to be
one self-contained file, because an MCP Apps resource is served inline and has no
origin to fetch sibling assets from.

> **Windows note:** Vitest can fail to find its runner when the working
> directory uses a different drive-letter case than Node's canonical path
> (`cd /d c:\...` vs `C:\...`). Run the commands from PowerShell (or a canonical
> `C:\...` path). CI runs on Linux and is unaffected.

## Environment variables

| Variable | Purpose |
|---|---|
| `MUTANT_SERVICE_LAMBDA_ARN` | report-generator Lambda alias invoked for all tools. Empty uses a mock client. |
| `MUTANT_OAUTH_ISSUER` | OIDC issuer / Cognito user-pool URL. |
| `MUTANT_OAUTH_AUDIENCE` | Optional. Expected `aud` claim; leave empty for Cognito without a resource server. |
| `MUTANT_OAUTH_CLIENT_ID` | Predefined Cognito app client authorized for the ChatGPT redirect URI. |
| `MUTANT_OAUTH_SCOPE` | Required access-token scope for the six analysis tools. Empty (default) derives `<MUTANT_MCP_RESOURCE_URI>/analysis.read`, e.g. `https://dev-api.mutantbiotech.com/mcp/analysis.read`. Set explicitly only to override. |
| `MUTANT_OAUTH_SCOPE_DNA_IMPORT` | Scope required by `show_dna_import`, `get_snp_catalog`, and `create_report`. Empty (default) derives `<MUTANT_MCP_RESOURCE_URI>/dna.import`. |
| `MUTANT_MCP_RESOURCE_URI` | Canonical RFC 9728 resource id (used in PRM + challenges, and as the scope's resource-server identifier). |
| `MUTANT_CORS_ORIGINS` | Comma-separated browser origin allowlist. |
| `MUTANT_UPGRADE_URL` | Upgrade URL returned to Free accounts (default `/cart`). |
| `MUTANT_ONBOARDING_URL` | Onboarding URL. |
| `MUTANT_REQUEST_TIMEOUT_MS` | Backend invocation deadline (default `20000`). |
| `MUTANT_MAX_RESPONSE_BYTES` | Serialized response cap (default `512000`). |
| `MUTANT_SNP_CATALOG_MAX_BYTES` | Per-tool response cap for `get_snp_catalog` (default `2000000`). |
| `MUTANT_MAX_REQUEST_BYTES` | Serialized request cap for `create_report` (default `5242880`, below the 6 MiB synchronous `lambda:InvokeFunction` limit). |
| `MUTANT_DEV_MODE` | `true` accepts `dev-free` / `dev-paid` tokens. |
| `LOG_LEVEL` | pino log level. |
| `PORT` | HTTP port (default `8080`). |

## Build & deploy

```bash
npm run bundle            # esbuild -> dist/index.mjs
docker build -t mutant-mcp .
docker run --rm -p 8080:8080 -e MUTANT_DEV_MODE=true mutant-mcp

npm run cdk:synth
npm run cdk:deploy
```

The CDK stack provisions:

- a Docker-based Lambda named `mutant-mcp-<env>` (Lambda Web Adapter, buffered
  invoke mode) logging to the conventional `/aws/lambda/mutant-mcp-<env>` group;
- IAM scoped to `lambda:InvokeFunction` on the specific report-generator alias
  (the MCP role intentionally has **no** `UserEntitlements` read permission);
- an API Gateway HTTP API with a `$default` catch-all route;
- two custom-domain mappings to an existing API Gateway custom domain when one is
  configured: the MCP mount (`MUTANT_API_MAPPING_KEY`, e.g. `/mcp`) and
  `.well-known`, which serves OAuth discovery at the host root so RFC 8414 / 9728
  clients find it at the issuer origin;
- error and latency CloudWatch alarms.

`MUTANT_MCP_RESOURCE_URI` defaults to `https://<domain>/<apiMappingKey|mcp>` when
a domain is configured. That host's origin is advertised as the authorization
server: the authorization-server metadata uses it as `issuer` (the origin
actually serving the document), and protected-resource metadata lists it in
`authorization_servers`. The `authorization_endpoint` / `token_endpoint` still
point at Cognito's custom domain, and token `iss` claims are still validated
against `MUTANT_OAUTH_ISSUER`.

## CI/CD (GitHub Actions)

The workflow lives at the repo root (`../.github/workflows/deploy.yml`). It runs
on push to `main` touching `mutant-mcp/**` (targeting `dev`) and on manual
`workflow_dispatch` (`dev` / `staging` / `prod`):

1. `test` job: `npm ci`, typecheck, lint, `npm run build:ui`, `npm run check:genomics`, `vitest`.
2. `build-and-deploy` job: OIDC to AWS, CDK bootstrap, `cdk deploy`.

Required GitHub **secrets**: `AWS_ROLE_ARN`, `MUTANT_SERVICE_LAMBDA_ARN`,
`MUTANT_OAUTH_ISSUER`, `MUTANT_OAUTH_AUDIENCE`, `MUTANT_OAUTH_CLIENT_ID`,
`MUTANT_DEV_MODE`, `MUTANT_DOMAIN_NAME`, `MUTANT_API_MAPPING_KEY`.

Required GitHub **variables**: `MUTANT_MCP_RESOURCE_URI`, `MUTANT_CORS_ORIGINS`,
`MUTANT_UPGRADE_URL`, `MUTANT_REQUEST_TIMEOUT_MS`, `MUTANT_MAX_RESPONSE_BYTES`
(optional: `MUTANT_SNP_CATALOG_MAX_BYTES`, `MUTANT_MAX_REQUEST_BYTES`).
`MUTANT_OAUTH_SCOPE` and `MUTANT_OAUTH_SCOPE_DNA_IMPORT` are optional: leave them
unset (or blank) to derive `<MUTANT_MCP_RESOURCE_URI>/analysis.read` and
`<MUTANT_MCP_RESOURCE_URI>/dna.import`; if either exists in the environment's
variables, it must contain the full scope (e.g.
`https://dev-api.mutantbiotech.com/mcp/analysis.read`) or it will win over the
derived default.

## Documentation

- [`docs/mcp-contract.md`](docs/mcp-contract.md) — implemented schemas, semantics, and error codes.
- [`docs/mcp-runbook.md`](docs/mcp-runbook.md) — Cognito/OAuth setup, ChatGPT linking/relinking, monitoring, rollback.

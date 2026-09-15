# mutant-mcp

A deployable, stateless [Model Context Protocol](https://modelcontextprotocol.io)
server for Mutant Genomics. It runs as an AWS Lambda behind API Gateway at a
custom domain (e.g. `https://dev-api.mutantbiotech.com/mcp`), authenticates users
with Mutant's Cognito OAuth (authorization code + PKCE S256), and exposes the
**six-tool contract 1.0.0** backed by the existing `report-generator` Lambda.

The MCP Lambda is a thin, authenticated transport. **All business rules live in
the backend** (`back-end/report-generator/mcp`): current-snapshot resolution,
account ownership, entitlement (`UserEntitlements`), the Free top-three policy,
hypothesis/evidence retrieval, projection, filtering, pagination, and cursor
validation. The MCP Lambda never reads entitlements and never accepts an
analysis id, account, or plan from tool arguments.

## Architecture

```text
ChatGPT connector
   |  OAuth 2.1 PKCE S256 + Bearer token
   |  (PRM + AS discovery served by this Lambda)
   v
API Gateway HTTP API  $default (catch-all)
   |
   v
Mutant MCP Lambda (Node HTTP server on :8080)
   |-- OAuth discovery + token validation (jose / OIDC JWKS)
   |-- Six MCP tools (schemas, envelope, text mirror)
   `-- Versioned internal contract 1.0.0 (direct InvokeCommand, IAM-scoped)
          |
          v
Report-generator Lambda  (mcp package, read-only)
   |-- Snapshot + entitlement resolution
   |-- Free top-three / Full scope
   |-- v3 projection, pagination, cursors
   `-- ToolResponse envelope (ok/data/error, analysis_version, page)
```

## Layout

```text
mutant-mcp/
├── src/
│   ├── handler.ts                 # HTTP server entry (Lambda Web Adapter :8080)
│   ├── http-handler.ts            # routing, OAuth discovery, 401 challenges
│   ├── server.ts                  # McpServer + instructions
│   ├── config.ts                  # env loading/validation (Zod)
│   ├── contract.ts                # contract 1.0.0 constants + types
│   ├── auth/
│   │   ├── token-validator.ts     # JWT/JWKS + client/scope/resource checks
│   │   ├── oauth-metadata.ts      # RFC 9728 PRM + AS metadata mirror
│   │   └── user-context.ts        # MutantUserContext (userId + scopes)
│   ├── tools/                     # six tool definitions + registration
│   ├── schemas/                   # Zod input + shared envelope schemas
│   ├── clients/
│   │   └── mutant-lambda-client.ts# versioned internal contract + envelope parse
│   └── responses/
│       ├── errors.ts              # JSON-RPC + WWW-Authenticate challenges
│       └── tool-result.ts         # envelope -> CallToolResult + text mirror
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

| Tool | Purpose |
|---|---|
| `get_analysis_status` | Current analysis status + effective plan and capabilities. |
| `get_analysis_context` | **Start here.** Coverage, interpretation rules/limitations, top hypotheses. |
| `list_health_hypotheses` | List/search hypotheses (Free: fixed top three; Full: whole set). |
| `get_hypothesis_details` | Full interpretation: scoring, patterns, clinical correlation, guardrails. |
| `get_supporting_evidence` | Stored patterns, variant contributions, or cited sources. |
| `get_genetic_context` | Marker-level context by hypothesis (Free) or module/gene/rsIDs (Full). |

The same tool definitions are exposed to Free and Full accounts; access limits
are enforced in the backend and returned as structured errors
(`PLAN_ACCESS_REQUIRED`, `HYPOTHESIS_SCOPE_REQUIRED`).

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
All six tools are discoverable. See `docs/mcp-runbook.md` for linking the real
ChatGPT dev connector.

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run lint      # eslint
```

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
| `MUTANT_OAUTH_SCOPE` | Required access-token scope (default `mutant/analysis.read`). |
| `MUTANT_MCP_RESOURCE_URI` | Canonical RFC 9728 resource id (used in PRM + challenges). |
| `MUTANT_CORS_ORIGINS` | Comma-separated browser origin allowlist. |
| `MUTANT_UPGRADE_URL` | Upgrade URL returned to Free accounts (default `/cart`). |
| `MUTANT_ONBOARDING_URL` | Onboarding URL. |
| `MUTANT_REQUEST_TIMEOUT_MS` | Backend invocation deadline (default `20000`). |
| `MUTANT_MAX_RESPONSE_BYTES` | Serialized response cap (default `512000`). |
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

1. `test` job: `npm ci`, typecheck, lint, `vitest`.
2. `build-and-deploy` job: OIDC to AWS, CDK bootstrap, `cdk deploy`.

Required GitHub **secrets**: `AWS_ROLE_ARN`, `MUTANT_SERVICE_LAMBDA_ARN`,
`MUTANT_OAUTH_ISSUER`, `MUTANT_OAUTH_AUDIENCE`, `MUTANT_OAUTH_CLIENT_ID`,
`MUTANT_DEV_MODE`, `MUTANT_DOMAIN_NAME`, `MUTANT_API_MAPPING_KEY`.

Required GitHub **variables**: `MUTANT_OAUTH_SCOPE`, `MUTANT_MCP_RESOURCE_URI`,
`MUTANT_CORS_ORIGINS`, `MUTANT_UPGRADE_URL`, `MUTANT_REQUEST_TIMEOUT_MS`,
`MUTANT_MAX_RESPONSE_BYTES`.

## Documentation

- [`docs/mcp-contract.md`](docs/mcp-contract.md) — implemented schemas, semantics, and error codes.
- [`docs/mcp-runbook.md`](docs/mcp-runbook.md) — Cognito/OAuth setup, ChatGPT linking/relinking, monitoring, rollback.

# mutant-mcp readme file

A deployable, stateless MCP (Model Context Protocol) server for Mutant Genomics. It
runs as an AWS Lambda behind API Gateway at a custom domain (e.g.
`https://dev-api.mutantbiotech.com/mcp`),
authenticates users via Mutant OAuth, registers all seven Mutant tools, enforces
free/paid access, and invokes the existing Mutant REST Lambda synchronously.

This is the **shell**: every tool is registered with a valid input/output schema but
returns placeholder responses. No business logic is wired in yet.

## Architecture

```text
ChatGPT / MCP client
   |  MCP Streamable HTTP + OAuth bearer token
   v
API Gateway HTTP API  $default (catch-all route)
   |  Lambda Web Adapter (response_stream)
   v
Mutant MCP Lambda (Node.js HTTP server on :8080)
   |-- MCP protocol handling (stateless)
   |-- OAuth token validation (jose / OIDC JWKS)
   |-- Subscription entitlement
   |-- 7 registered tools (placeholder handlers)
   `-- Existing Lambda invocation adapter
          |
          v
   Existing Mutant REST Lambda
```

## Layout

```text
mutant-mcp/
├── src/
│   ├── handler.ts                 # HTTP server entry (Lambda Web Adapter :8080)
│   ├── http-handler.ts            # POST routing (any path), auth, transport wiring
│   ├── server.ts                  # assembles McpServer + registers tools
│   ├── config.ts                  # env loading/validation (Zod)
│   ├── logger.ts                  # pino, redacts tokens
│   ├── auth/
│   │   ├── token-validator.ts     # jose JWT/JWKS validation
│   │   └── user-context.ts        # MutantUserContext
│   ├── entitlements/
│   │   └── access-policy.ts       # TOOL_ACCESS + canAccess
│   ├── tools/                     # 7 tool definitions + registration
│   ├── schemas/                   # Zod input/output schemas
│   ├── clients/
│   │   └── mutant-lambda-client.ts# sync invoke + event contract
│   └── responses/
│       ├── errors.ts              # JSON-RPC error helpers
│       └── tool-result.ts         # placeholder / upgrade_required builders
├── tests/                         # Vitest
├── infrastructure/                # AWS CDK v2 (TypeScript)
├── Dockerfile                     # Node 22 + Lambda Web Adapter
├── package.json
└── tsconfig.json
```

## Prerequisites

- Node.js 22+
- Docker (only for `docker build` / `cdk deploy` of the image)
- AWS CDK CLI + AWS credentials (for deployment)

## Local development

Run in dev mode, which accepts `dev-free` and `dev-paid` bearer tokens instead of
requiring a live OIDC provider:

```bash
npm install
MUTANT_DEV_MODE=true npm run dev
```

The server listens on port `8080`.

### Smoke test with MCP Inspector

```bash
MUTANT_DEV_MODE=true npm run dev
# in another terminal
npx @modelcontextprotocol/inspector
```

Connect the Inspector to `http://localhost:8080/mcp` using `Bearer dev-paid` or
`Bearer dev-free`. All seven tools are discoverable; free users receive
`upgrade_required` for the three paid tools.

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run lint      # eslint
```

## Environment variables

| Variable | Purpose |
|---|---|
| `MUTANT_SERVICE_LAMBDA_ARN` | Existing Mutant REST Lambda alias. Empty uses a mock client. |
| `MUTANT_OAUTH_ISSUER` | OIDC issuer URL (e.g. `https://cognito-idp.us-west-2.amazonaws.com/<user_pool_id>`). |
| `MUTANT_OAUTH_AUDIENCE` | Optional. Expected `aud` claim. Leave empty for Cognito tokens without a resource server. |
| `MUTANT_UPGRADE_URL` | URL returned in `upgrade_required` responses. |
| `MUTANT_ONBOARDING_URL` | Onboarding URL (reserved for future tool responses). |
| `MUTANT_DEV_MODE` | `true` accepts `dev-free` / `dev-paid` tokens. |
| `LOG_LEVEL` | pino log level. |
| `PORT` | HTTP port (default `8080`). |

## Build & run the Docker image

```bash
npm run bundle            # esbuild -> dist/index.mjs
docker build -t mutant-mcp .
docker run --rm -p 8080:8080 -e MUTANT_DEV_MODE=true mutant-mcp
```

## Deploy with AWS CDK

```bash
npm run cdk:synth
npm run cdk:deploy
```

The stack provisions:

- a Docker-based Lambda (Lambda Web Adapter, `response_stream`) with reserved
  concurrency and a CloudWatch log group (1-month retention);
- an API Gateway HTTP API with a `$default` catch-all route;
- an optional custom domain mapping to an existing API Gateway custom domain (set
  `domainName`, e.g. `dev-api.mutantbiotech.com`, which reuses its certificate and
  DNS; the stack only adds an API mapping, it never creates a cert/domain/record);
- an optional API mapping key (set `apiMappingKey`, e.g. `mcp`) so the API can
  share a domain whose root path is already mapped to another API. With
  `apiMappingKey: "mcp"`, the endpoint is `https://<domain>/mcp`; leave it unset
  to map the root path (`https://<domain>/`);
- IAM scoped to `lambda:InvokeFunction` on the specific production alias;
- error and latency CloudWatch alarms.

The stack name is derived from the `environment` CDK context (or `ENVIRONMENT`
env var), defaulting to `dev` — e.g. `mutant-mcp-prod`.

## CI/CD (GitHub Actions)

The workflow lives at the repo root: `.github/workflows/deploy.yml` (this
project is a monorepo directory `mutant-mcp/` inside the `mcp_server` repo, so
the workflow must be at the root, like the report-generator flow in `back-end`).

It runs on push to `main` touching `mutant-mcp/**` (targeting `dev`) and on
manual `workflow_dispatch` where you pick `dev`, `staging`, or `prod`. The
pipeline mirrors the report-generator flow:

1. `test` job: `npm ci`, typecheck, lint, and `vitest`.
2. `build-and-deploy` job: authenticates to AWS via OIDC, bootstraps CDK
   (idempotent), then runs `cdk deploy` which builds and pushes the Docker image
   to ECR and updates the Lambda + API Gateway.

Required GitHub secrets:

| Secret | Purpose |
|---|---|
| `AWS_ROLE_ARN` | OIDC role with ECR push and Lambda/API Gateway/Route53/CloudWatch/IAM deploy permissions. |
| `MUTANT_SERVICE_LAMBDA_ARN` | Existing Mutant REST Lambda alias to invoke. |
| `MUTANT_OAUTH_ISSUER` | OIDC issuer URL (Cognito user-pool URL). |
| `MUTANT_OAUTH_AUDIENCE` | Optional. Expected `aud` claim; leave empty for Cognito without a resource server. |
| `MUTANT_DEV_MODE` | Optional. `true` accepts `dev-free`/`dev-paid` tokens instead of real OAuth. Needed if issuer/audience are unset. |
| `MUTANT_DOMAIN_NAME` | Optional. Enables the custom domain mapping. Must already exist as an API Gateway custom domain (reuses its cert + DNS). |
| `MUTANT_API_MAPPING_KEY` | Optional. Path prefix for the custom domain (e.g. `mcp`). Set it when sharing a domain whose root path is already mapped. |

When `MUTANT_DOMAIN_NAME` is unset, the custom domain is skipped and the API
Gateway auto-URL is used (typical for dev/staging).

## Tool catalog

| Tool | Tier |
|---|---|
| `get_analysis_status` | free |
| `get_genomic_overview` | free |
| `get_genetic_context` | free |
| `get_variant_context` | free |
| `get_root_cause_details` | paid |
| `get_supporting_evidence` | paid |
| `get_relevant_tests` | paid |

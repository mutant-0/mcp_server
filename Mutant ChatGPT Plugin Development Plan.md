# Mutant ChatGPT Plugin Development Plans

## Plan 1: MCP Lambda Shell

### Objective

Build a deployable MCP server that:

- Runs as a dedicated AWS Lambda.
- Is exposed at `https://api.mutantgenomics.com/mcp`.
- Authenticates users through Mutant OAuth.
- Registers all seven MCP tools.
- Enforces free and paid access.
- Invokes the existing REST Lambda synchronously.
- Returns placeholder responses only.
- Does not implement the tools’ business logic yet.

### Architecture

```text
ChatGPT
   │
   │ MCP Streamable HTTP + OAuth token
   ▼
API Gateway /mcp
   ▼
Mutant MCP Lambda
   ├── MCP protocol handling
   ├── Token validation
   ├── Subscription entitlement
   ├── Tool registration
   └── Existing Lambda invocation adapter
                  │
                  ▼
        Existing Mutant REST Lambda
                  │
                  ▼
         Existing data and services
```

## Phase 1: Project Scaffold

Create a separate MCP Lambda project:

```text
mutant-mcp/
├── src/
│   ├── handler.ts
│   ├── server.ts
│   ├── auth/
│   │   ├── token-validator.ts
│   │   └── user-context.ts
│   ├── entitlements/
│   │   └── access-policy.ts
│   ├── tools/
│   │   ├── get-analysis-status.ts
│   │   ├── get-genomic-overview.ts
│   │   ├── get-genetic-context.ts
│   │   ├── get-variant-context.ts
│   │   ├── get-root-cause-details.ts
│   │   ├── get-supporting-evidence.ts
│   │   └── get-relevant-tests.ts
│   ├── clients/
│   │   └── mutant-lambda-client.ts
│   ├── responses/
│   │   ├── errors.ts
│   │   └── tool-result.ts
│   └── config.ts
├── tests/
├── infrastructure/
├── package.json
└── tsconfig.json
```

Use:

- TypeScript
- `@modelcontextprotocol/sdk`
- Zod for tool schemas
- AWS SDK for synchronous Lambda invocation

## Phase 2: MCP Transport Shell

Implement:

- `POST /mcp`
- MCP initialization
- Capability negotiation
- `tools/list`
- `tools/call`
- Streamable HTTP transport
- Standard JSON responses
- Standard MCP error responses
- Request correlation IDs
- Structured logging
- Lambda/API Gateway adapter

Keep the MCP server stateless. Do not depend on Lambda memory between requests.

## Phase 3: Authentication Shell

Implement the authentication boundaries without rebuilding Mutant’s identity platform.

The MCP Lambda should:

1. Read the OAuth bearer token.
2. Validate the token’s issuer, audience, signature, and expiration.
3. Extract the immutable Mutant user ID.
4. Determine the user’s access level.
5. Create a trusted internal user context.
6. Reject missing or invalid authentication.
7. Never accept a user ID from MCP tool arguments.

```typescript
interface MutantUserContext {
  userId: string;
  accountId: string;
  accessLevel: "free" | "paid";
  analysisId?: string;
}
```

OAuth discovery, authorization, token issuance, and account linking should be supplied by Mutant’s authentication system.

## Phase 4: Tool Registration Shells

Register all seven tools with:

- Stable tool name
- Human-readable title
- Tool description
- Input schema
- Output schema
- MCP annotations
- Access tier
- Placeholder handler

Do not implement calls to the existing Mutant business logic yet.

### Free Tools

| Tool | Initial input | Intended purpose |
|---|---|---|
| `get_analysis_status` | Optional analysis ID | Determine whether the user has uploaded a genome and whether processing is complete |
| `get_genomic_overview` | Optional analysis ID | Return a high-level overview of available genomic findings |
| `get_genetic_context` | Module or context identifier | Return genetic context for a requested biological area |
| `get_variant_context` | rsID or variant identifier | Return interpretation for a specific genetic variant |

### Paid Additions

| Tool | Initial input | Intended purpose |
|---|---|---|
| `get_root_cause_details` | Root-cause ID | Return detailed information about a selected root cause |
| `get_supporting_evidence` | Root-cause or finding ID | Return evidence, relevant variants, and sources |
| `get_relevant_tests` | Root-cause ID or context | Return relevant clinical or functional testing options |

### Tool Definition Structure

```typescript
interface MutantToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: Record<string, unknown>;
  accessTier: "free" | "paid";
  handler: ToolHandler;
}
```

### Placeholder Response

Every tool should initially return a valid MCP response:

```json
{
  "status": "not_implemented",
  "tool": "get_genomic_overview",
  "message": "The tool is registered, but its Mutant data integration has not been implemented."
}
```

This allows MCP Inspector and ChatGPT to discover and test the complete tool catalog before the business logic is connected.

## Phase 5: Entitlement Shell

Centralize tool-access rules:

```typescript
const TOOL_ACCESS = {
  get_analysis_status: "free",
  get_genomic_overview: "free",
  get_genetic_context: "free",
  get_variant_context: "free",
  get_root_cause_details: "paid",
  get_supporting_evidence: "paid",
  get_relevant_tests: "paid"
} as const;
```

For paid-tool calls made by free users, return a structured tool result instead of a generic server error:

```json
{
  "status": "upgrade_required",
  "required_tier": "paid",
  "upgrade_url": "https://mutantgenomics.com/upgrade",
  "message": "Detailed root-cause analysis is available with Mutant Full Access."
}
```

This allows ChatGPT to explain the restriction and present the upgrade option naturally.

## Phase 6: Existing Lambda Adapter Shell

Create a synchronous Lambda client using:

```text
InvocationType: RequestResponse
```

Define a clean internal event contract:

```json
{
  "source": "mutant-mcp",
  "version": "1",
  "operation": "get_genomic_overview",
  "identity": {
    "user_id": "trusted-token-derived-id"
  },
  "arguments": {},
  "request_context": {
    "request_id": "uuid"
  }
}
```

For this initial shell:

- Build the invocation client.
- Configure the target Lambda ARN.
- Configure IAM permission.
- Implement request serialization.
- Implement response deserialization.
- Mock the existing Lambda response.
- Do not connect individual tools to real operations yet.

## Phase 7: AWS Infrastructure

Provision:

- Dedicated MCP Lambda.
- API Gateway `/mcp` route.
- Custom domain and TLS certificate.
- Permission to invoke the existing production Lambda alias.
- CloudWatch log group.
- Error and latency alarms.
- Environment variables.
- Reserved concurrency or throttling protection.
- WAF or rate limiting if already used by Mutant.

Suggested environment variables:

```text
MUTANT_SERVICE_LAMBDA_ARN
MUTANT_OAUTH_ISSUER
MUTANT_OAUTH_AUDIENCE
MUTANT_UPGRADE_URL
MUTANT_ONBOARDING_URL
LOG_LEVEL
```

### IAM Permission

The MCP Lambda should only be allowed to invoke the specific Mutant Lambda alias:

```json
{
  "Effect": "Allow",
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:REGION:ACCOUNT:function:mutant-api:production"
}
```

## Phase 8: Shell Validation

### Acceptance Criteria

- MCP Inspector connects successfully.
- MCP initialization succeeds.
- All seven tools are discoverable.
- Every tool exposes a valid input schema.
- Every tool exposes a valid output schema.
- Free tools return valid placeholder responses.
- Paid tools return placeholders for paid users.
- Free users receive `upgrade_required` for paid tools.
- Missing or invalid tokens produce authentication responses.
- Invalid tool arguments produce schema errors.
- The existing Lambda invocation can be exercised with a mock operation.
- Each invocation contains a correlation ID.
- No genetic or health data appears in logs.
- The server remains stateless between requests.

--
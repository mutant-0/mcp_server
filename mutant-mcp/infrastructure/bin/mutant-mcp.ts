import { App } from "aws-cdk-lib";
import { MutantMcpStack } from "../lib/mutant-mcp-stack.js";

const app = new App();

const environment = app.node.tryGetContext("environment") ?? process.env.ENVIRONMENT ?? "dev";

new MutantMcpStack(app, "MutantMcpStack", {
  stackName: `mutant-mcp-${environment}`,
  description: "Mutant MCP Lambda shell - Streamable HTTP",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  domainName: process.env.MUTANT_DOMAIN_NAME || undefined,
  apiMappingKey: process.env.MUTANT_API_MAPPING_KEY || undefined,
  serviceLambdaArn: process.env.MUTANT_SERVICE_LAMBDA_ARN || undefined,
  oauthIssuer: process.env.MUTANT_OAUTH_ISSUER || undefined,
  oauthAudience: process.env.MUTANT_OAUTH_AUDIENCE || undefined,
  oauthClientId: process.env.MUTANT_OAUTH_CLIENT_ID || undefined,
  oauthScope: process.env.MUTANT_OAUTH_SCOPE || undefined,
  mcpResourceUri: process.env.MUTANT_MCP_RESOURCE_URI || undefined,
  corsOrigins: process.env.MUTANT_CORS_ORIGINS || undefined,
  requestTimeoutMs: process.env.MUTANT_REQUEST_TIMEOUT_MS
    ? Number(process.env.MUTANT_REQUEST_TIMEOUT_MS)
    : undefined,
  maxResponseBytes: process.env.MUTANT_MAX_RESPONSE_BYTES
    ? Number(process.env.MUTANT_MAX_RESPONSE_BYTES)
    : undefined,
  upgradeUrl: process.env.MUTANT_UPGRADE_URL || undefined,
  devMode: process.env.MUTANT_DEV_MODE === "true",
});

app.synth();

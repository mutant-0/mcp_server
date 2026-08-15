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
  hostedZoneId: process.env.MUTANT_HOSTED_ZONE_ID || undefined,
  hostedZoneName: process.env.MUTANT_HOSTED_ZONE_NAME || undefined,
  serviceLambdaArn: process.env.MUTANT_SERVICE_LAMBDA_ARN || undefined,
  oauthIssuer: process.env.MUTANT_OAUTH_ISSUER || undefined,
  oauthAudience: process.env.MUTANT_OAUTH_AUDIENCE || undefined,
});

app.synth();

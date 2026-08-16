import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { CfnDomainName, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface MutantMcpStackProps extends StackProps {
  /** Custom domain, e.g. api.mutantgenomics.com */
  domainName?: string;
  /** API mapping key (path prefix) for the custom domain, e.g. "mcp". Leave unset to map the root path. */
  apiMappingKey?: string;
  /** Existing Mutant REST Lambda alias ARN */
  serviceLambdaArn?: string;
  oauthIssuer?: string;
  oauthAudience?: string;
  /** When true, accepts dev-free/dev-paid tokens instead of validating against OIDC. */
  devMode?: boolean;
  upgradeUrl?: string;
  onboardingUrl?: string;
  logLevel?: string;
  reservedConcurrency?: number;
}

export class MutantMcpStack extends Stack {
  constructor(scope: Construct, id: string, props: MutantMcpStackProps = {}) {
    super(scope, id, props);

    const serviceLambdaArn =
      props.serviceLambdaArn ??
      "arn:aws:lambda:us-east-1:000000000000:function:mutant-api:production";

    const fn = new DockerImageFunction(this, "McpFunction", {
      code: DockerImageCode.fromImageAsset(projectRoot()),
      architecture: Architecture.X86_64,
      timeout: Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: props.reservedConcurrency,
      logGroup: new LogGroup(this, "McpLogGroup", {
        retention: RetentionDays.ONE_MONTH,
      }),
      environment: {
        MUTANT_SERVICE_LAMBDA_ARN: serviceLambdaArn,
        MUTANT_OAUTH_ISSUER: props.oauthIssuer ?? "",
        MUTANT_OAUTH_AUDIENCE: props.oauthAudience ?? "",
        MUTANT_DEV_MODE: props.devMode ? "true" : "false",
        MUTANT_UPGRADE_URL: props.upgradeUrl ?? "https://mutantgenomics.com/upgrade",
        MUTANT_ONBOARDING_URL: props.onboardingUrl ?? "https://mutantgenomics.com/onboarding",
        LOG_LEVEL: props.logLevel ?? "info",
      },
    });

    // Scoped permission to invoke only the specific production Lambda alias.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [serviceLambdaArn],
      }),
    );

    const defaultDomainMapping = this.configureCustomDomain(props);

    new HttpApi(this, "McpHttpApi", {
      defaultDomainMapping,
      defaultIntegration: new HttpLambdaIntegration("McpIntegration", fn),
    });

    new Alarm(this, "McpErrorAlarm", {
      metric: fn.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, "McpLatencyAlarm", {
      metric: fn.metricDuration(),
      threshold: 3000,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  private configureCustomDomain(props: MutantMcpStackProps) {
    if (!props.domainName) {
      return undefined;
    }
    // Reuse an existing API Gateway custom domain (and its ACM cert + DNS). We only
    // add an API mapping, so no new certificate, domain, or Route53 record is created.
    return {
      domainName: CfnDomainName.fromDomainName(this, "McpImportedDomain", props.domainName),
      mappingKey: props.apiMappingKey,
    };
  }
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // infrastructure/dist (bundled) or infrastructure/lib (tsx) -> project root
  return path.resolve(here, "..", "..");
}

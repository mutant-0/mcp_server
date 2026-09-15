import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { CfnDomainName, ApiMapping, HttpApi, type IDomainNameRef } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** Mapping key that serves OAuth discovery at the custom domain's root. */
const DEFAULT_WELL_KNOWN_MAPPING_KEY = ".well-known";

export interface MutantMcpStackProps extends StackProps {
  /** Explicit Lambda function name. Keeps logs at the conventional `/aws/lambda/<name>`. */
  functionName?: string;
  /** Custom domain, e.g. api.mutantgenomics.com */
  domainName?: string;
  /** API mapping key (path prefix) for the custom domain, e.g. "mcp". Leave unset to map the root path. */
  apiMappingKey?: string;
  /**
   * Mapping key used to serve OAuth discovery at the custom domain's root.
   * Defaults to `.well-known`.
   */
  wellKnownMappingKey?: string;
  /** Existing Mutant REST Lambda alias ARN */
  serviceLambdaArn?: string;
  oauthIssuer?: string;
  oauthAudience?: string;
  oauthClientId?: string;
  oauthScope?: string;
  /** Canonical MCP resource URI (RFC 9728). Defaults from domain + apiMappingKey. */
  mcpResourceUri?: string;
  corsOrigins?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
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

    const resourceUri = props.mcpResourceUri ?? defaultResourceUri(props);

    // Name the log group explicitly. Without this, `new LogGroup()` is
    // auto-named (e.g. `mutant-mcp-dev-McpLogGroup7D3BF67E-…`) and the function
    // logs there instead of the conventional `/aws/lambda/<function>` group,
    // which makes operational lookups and dashboards miss the logs.
    const logGroup = new LogGroup(this, "McpLogGroup", {
      logGroupName: `/aws/lambda/${props.functionName ?? "mutant-mcp"}`,
      retention: RetentionDays.ONE_MONTH,
    });

    const fn = new DockerImageFunction(this, "McpFunction", {
      code: DockerImageCode.fromImageAsset(projectRoot()),
      functionName: props.functionName,
      architecture: Architecture.X86_64,
      timeout: Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: props.reservedConcurrency,
      logGroup,
      environment: {
        MUTANT_SERVICE_LAMBDA_ARN: serviceLambdaArn,
        MUTANT_OAUTH_ISSUER: props.oauthIssuer ?? "",
        MUTANT_OAUTH_AUDIENCE: props.oauthAudience ?? "",
        MUTANT_OAUTH_CLIENT_ID: props.oauthClientId ?? "",
        MUTANT_OAUTH_SCOPE: props.oauthScope ?? "mutant/analysis.read",
        MUTANT_MCP_RESOURCE_URI: resourceUri,
        MUTANT_CORS_ORIGINS:
          props.corsOrigins ?? "https://chatgpt.com,https://chat.openai.com",
        MUTANT_DEV_MODE: props.devMode ? "true" : "false",
        MUTANT_UPGRADE_URL: props.upgradeUrl ?? "https://mutantgenomics.com/cart",
        MUTANT_ONBOARDING_URL: props.onboardingUrl ?? "https://mutantgenomics.com/onboarding",
        MUTANT_REQUEST_TIMEOUT_MS: String(props.requestTimeoutMs ?? 20000),
        MUTANT_MAX_RESPONSE_BYTES: String(props.maxResponseBytes ?? 512000),
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

    const importedDomain = this.importCustomDomain(props);

    const httpApi = new HttpApi(this, "McpHttpApi", {
      defaultDomainMapping: importedDomain
        ? { domainName: importedDomain, mappingKey: props.apiMappingKey }
        : undefined,
      defaultIntegration: new HttpLambdaIntegration("McpIntegration", fn),
    });

    this.configureWellKnownMapping(props, importedDomain, httpApi);

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

  private importCustomDomain(props: MutantMcpStackProps): IDomainNameRef | undefined {
    if (!props.domainName) {
      return undefined;
    }
    // Reuse an existing API Gateway custom domain (and its ACM cert + DNS). We only
    // add API mappings, so no new certificate, domain, or Route53 record is created.
    return CfnDomainName.fromDomainName(this, "McpImportedDomain", props.domainName);
  }

  /**
   * Serve the OAuth discovery documents at the custom domain's *root* as well as
   * under the API mapping key.
   *
   * RFC 8414 clients look for the authorization-server metadata at
   * `<issuer>/.well-known/oauth-authorization-server`; RFC 9728 clients may look
   * for `<origin>/.well-known/oauth-protected-resource`. On a shared custom
   * domain the root path belongs to another API (the report-generator `mutant-api`),
   * which 404s those paths, so this API claims the `.well-known` prefix instead.
   *
   * API Gateway strips the mapped prefix before invoking the Lambda, so these
   * requests arrive as `/oauth-authorization-server` and
   * `/oauth-protected-resource`; the handler accepts both forms. Skipped when
   * this API already owns the root mapping, where the paths already resolve.
   */
  private configureWellKnownMapping(
    props: MutantMcpStackProps,
    domainName: IDomainNameRef | undefined,
    api: HttpApi,
  ): void {
    if (!domainName || !props.apiMappingKey) {
      return;
    }
    new ApiMapping(this, "OAuthWellKnownMapping", {
      api,
      domainName,
      apiMappingKey: props.wellKnownMappingKey ?? DEFAULT_WELL_KNOWN_MAPPING_KEY,
    });
  }
}

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // infrastructure/dist (bundled) or infrastructure/lib (tsx) -> project root
  return path.resolve(here, "..", "..");
}

/**
 * Derive the canonical MCP resource URI from the custom domain and mapping key.
 * Falls back to an empty string (dev) when no domain is configured.
 */
function defaultResourceUri(props: MutantMcpStackProps): string {
  if (!props.domainName) return "";
  const key = props.apiMappingKey?.replace(/^\/+|\/+$/g, "");
  return `https://${props.domainName}/${key && key.length > 0 ? key : "mcp"}`;
}

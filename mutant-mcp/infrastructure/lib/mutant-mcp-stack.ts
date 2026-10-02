import path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { CfnDomainName, ApiMapping, HttpApi, type IDomainNameRef } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, DockerImageCode, DockerImageFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, LogRetention, RetentionDays, type ILogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { getRetentionStore } from "./retention-policy.js";

/** CloudWatch-supported retention values, keyed by day count. */
const RETENTION_DAYS_BY_COUNT: Record<number, RetentionDays> = {
  1: RetentionDays.ONE_DAY,
  3: RetentionDays.THREE_DAYS,
  5: RetentionDays.FIVE_DAYS,
  7: RetentionDays.ONE_WEEK,
  14: RetentionDays.TWO_WEEKS,
  30: RetentionDays.ONE_MONTH,
  60: RetentionDays.TWO_MONTHS,
  90: RetentionDays.THREE_MONTHS,
  120: RetentionDays.FOUR_MONTHS,
  150: RetentionDays.FIVE_MONTHS,
  180: RetentionDays.SIX_MONTHS,
  365: RetentionDays.ONE_YEAR,
  400: RetentionDays.THIRTEEN_MONTHS,
  545: RetentionDays.EIGHTEEN_MONTHS,
  731: RetentionDays.TWO_YEARS,
  1096: RetentionDays.THREE_YEARS,
  1827: RetentionDays.FIVE_YEARS,
  3653: RetentionDays.TEN_YEARS,
};

/** Map an approved day count to the CDK enum, rejecting unsupported values. */
function toRetentionDays(days: number): RetentionDays {
  const mapped = RETENTION_DAYS_BY_COUNT[days];
  if (mapped === undefined) {
    throw new Error(
      `Unsupported log-group retention of ${days} days; use a CloudWatch-supported value.`,
    );
  }
  return mapped;
}

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
  /** Scope required by the DNA import tools. Defaults to derived `dna.import`. */
  oauthScopeDnaImport?: string;
  /** Canonical MCP resource URI (RFC 9728). Defaults from domain + apiMappingKey. */
  mcpResourceUri?: string;
  corsOrigins?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Per-tool response cap for get_snp_catalog (bytes). */
  snpCatalogMaxBytes?: number;
  /** Cap on a serialized tool request (bytes), for create_report payloads. */
  maxRequestBytes?: number;
  /** When true, accepts dev-free/dev-paid tokens instead of validating against OIDC. */
  devMode?: boolean;
  /**
   * Designated synthetic-capture switch. When true the tool-call audit record
   * additionally carries routing-relevant argument values (see
   * `src/tools/audit.ts`). Leave false in production; enable only in a
   * controlled environment while recording a golden routing trace.
   */
  traceCapture?: boolean;
  /** Opaque id correlating one controlled synthetic capture session. */
  traceCaptureId?: string;
  /**
   * Approved informational plan page for the Free-plan notice's learn-more link.
   * Defaults to the production `/plans` plan page.
   */
  planInfoUrl?: string;
  onboardingUrl?: string;
  /** Portal consent route the DNA import card deep-links to (PRIV-05). */
  consentUrl?: string;
  logLevel?: string;
  reservedConcurrency?: number;
  /**
   * Adopt an already-existing `/aws/lambda/<functionName>` log group instead of
   * creating it. Required once the Lambda service has auto-created the group
   * (first deploy without an explicit `logGroup`), which otherwise fails with
   * "Resource of type 'AWS::Logs::LogGroup' ... already exists".
   *
   * Retention is still applied to the adopted group, via a dedicated
   * `LogRetention` resource that only calls `PutRetentionPolicy` -- the group is
   * never recreated or deleted.
   */
  adoptLogGroup?: boolean;
  /**
   * Log-group retention in days. Defaults to the `cw-mcp-log-group` value in
   * `retention-policy.json` (the existing deployed configuration). Applied to
   * both created and adopted groups.
   */
  logRetentionDays?: number;
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
    //
    // PRIV-06: retention comes from the approved policy for the MCP store. A
    // created group sets it inline; an adopted group is left untouched by
    // CloudFormation and instead gets a dedicated `LogRetention` resource, which
    // calls only `PutRetentionPolicy` (never replaces or deletes the group).
    const logGroupName = `/aws/lambda/${props.functionName ?? "mutant-mcp"}`;
    const retentionDays =
      props.logRetentionDays ?? getRetentionStore("cw-mcp-log-group").retentionDays;
    // A null policy value means "not configured"; fall back to the previous
    // inline default so a pending policy cannot silently drop retention.
    const retention = toRetentionDays(retentionDays ?? 30);
    const logGroup: ILogGroup = props.adoptLogGroup
      ? LogGroup.fromLogGroupName(this, "McpLogGroup", logGroupName)
      : new LogGroup(this, "McpLogGroup", {
          logGroupName,
          retention,
        });
    if (props.adoptLogGroup) {
      new LogRetention(this, "McpLogGroupRetention", {
        logGroupName,
        retention,
      });
    }

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
        // Empty lets the runtime derive `<MUTANT_MCP_RESOURCE_URI>/analysis.read`.
        MUTANT_OAUTH_SCOPE: props.oauthScope ?? "",
        // Empty lets the runtime derive `<MUTANT_MCP_RESOURCE_URI>/dna.import`.
        MUTANT_OAUTH_SCOPE_DNA_IMPORT: props.oauthScopeDnaImport ?? "",
        MUTANT_MCP_RESOURCE_URI: resourceUri,
        MUTANT_CORS_ORIGINS:
          props.corsOrigins ?? "https://chatgpt.com,https://chat.openai.com",
        MUTANT_DEV_MODE: props.devMode ? "true" : "false",
        // Synthetic routing-trace capture. Off by default: an ordinary log must
        // never carry an argument value.
        MUTANT_TRACE_CAPTURE: props.traceCapture ? "true" : "false",
        MUTANT_TRACE_CAPTURE_ID: props.traceCaptureId ?? "",
        MUTANT_PLAN_INFO_URL: props.planInfoUrl ?? "https://mutantgenomics.com/plans",
        MUTANT_ONBOARDING_URL: props.onboardingUrl ?? "https://mutantgenomics.com/onboarding",
        MUTANT_CONSENT_URL: props.consentUrl ?? "https://mutantgenomics.com/consent",
        MUTANT_REQUEST_TIMEOUT_MS: String(props.requestTimeoutMs ?? 20000),
        MUTANT_MAX_RESPONSE_BYTES: String(props.maxResponseBytes ?? 512000),
        MUTANT_SNP_CATALOG_MAX_BYTES: String(props.snpCatalogMaxBytes ?? 2000000),
        // Defaults below the 6 MiB synchronous lambda:InvokeFunction limit.
        MUTANT_MAX_REQUEST_BYTES: String(props.maxRequestBytes ?? 5 * 1024 * 1024),
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

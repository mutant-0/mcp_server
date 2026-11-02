/** Read-only deployment check. Never print Lambda environment values. */
import { GetFunctionConfigurationCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyBackendPagination(functionArn: string | undefined): Promise<void> {
  const arn = functionArn?.trim();
  const region = arn?.split(":")[3];
  if (!arn || !region || !/^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+(?::[^:]+)?$/.test(arn)) {
    throw new Error("Set MUTANT_SERVICE_LAMBDA_ARN to the backend Lambda ARN before deployment.");
  }

  const client = new LambdaClient({ region });
  let config;
  try {
    // Preserve any version or alias: check the same target the MCP server invokes.
    config = await client.send(new GetFunctionConfigurationCommand({ FunctionName: arn }));
  } catch {
    // SDK errors can contain upstream details; keep the deployment output fixed.
    throw new Error(
      "Cannot inspect the backend Lambda configuration. Check the ARN, AWS credentials, and " +
        "the deployment role's lambda:GetFunctionConfiguration permission.",
    );
  } finally {
    client.destroy();
  }

  if (config.Environment?.Error) {
    throw new Error(
      "Cannot read the backend Lambda environment. Check its encryption configuration.",
    );
  }
  if (!config.Environment?.Variables?.MCP_CURSOR_SECRET?.trim()) {
    throw new Error(
      "The backend Lambda is missing MCP_CURSOR_SECRET. Set the report-generator stack's " +
        "McpCursorSecret parameter to a persistent random value for this environment before " +
        "deploying the plugin. Findings requests can fail on the first page when more results exist.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyBackendPagination(process.env.MUTANT_SERVICE_LAMBDA_ARN);
    console.log("Backend pagination configuration verified.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backend configuration check failed.");
    process.exitCode = 1;
  }
}

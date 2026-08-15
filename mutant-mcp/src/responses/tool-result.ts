import type { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";

function textContent(text: string): TextContent {
  return { type: "text", text };
}

export interface NotImplementedPayload {
  status: "not_implemented";
  tool: string;
  message: string;
}

export interface UpgradeRequiredPayload {
  status: "upgrade_required";
  required_tier: "paid";
  upgrade_url: string;
  message: string;
}

export function notImplementedResult(tool: string): CallToolResult {
  const payload: NotImplementedPayload = {
    status: "not_implemented",
    tool,
    message:
      "The tool is registered, but its Mutant data integration has not been implemented.",
  };
  return {
    content: [textContent(JSON.stringify(payload, null, 2))],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

export function upgradeRequiredResult(config: AppConfig): CallToolResult {
  const payload: UpgradeRequiredPayload = {
    status: "upgrade_required",
    required_tier: "paid",
    upgrade_url: config.MUTANT_UPGRADE_URL,
    message: "Detailed root-cause analysis is available with Mutant Full Access.",
  };
  return {
    content: [textContent(JSON.stringify(payload, null, 2))],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

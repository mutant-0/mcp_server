import type { AppConfig } from "../config.js";
import type { ToolResponse } from "../contract.js";

const DEFAULT_UPGRADE_URL = "https://mutantgenomics.com/cart";

/** Use the MCP deployment's public checkout URL instead of a backend-local URL. */
export function withPublicUpgradeUrl(response: ToolResponse, config: AppConfig): ToolResponse {
  if (!response.ok || !response.data) return response;
  const data = response.data;
  const upgrade = data.upgrade;
  const hasUpgrade = upgrade && typeof upgrade === "object" && !Array.isArray(upgrade);
  if (!hasUpgrade && typeof data.upgrade_url !== "string") return response;

  let url = DEFAULT_UPGRADE_URL;
  try {
    const configured = new URL(config.MUTANT_UPGRADE_URL);
    if (configured.protocol === "https:") url = configured.href;
  } catch {
    // The public default is still usable if the deployment setting is malformed.
  }

  return {
    ...response,
    data: {
      ...data,
      ...(hasUpgrade ? { upgrade: { ...upgrade, url } } : {}),
      ...(typeof data.upgrade_url === "string" ? { upgrade_url: url } : {}),
    },
  };
}

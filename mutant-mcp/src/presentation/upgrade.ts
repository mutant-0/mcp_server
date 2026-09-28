import type { AppConfig } from "../config.js";
import type { ToolResponse } from "../contract.js";

const DEFAULT_UPGRADE_URL = "https://mutantgenomics.com/upgrade";

/**
 * Tag every upgrade link with where it was opened. The card is only ever shown
 * to a Free account with locked findings, so the link always means "a wider view
 * was withheld here in ChatGPT" and the destination can route accordingly.
 */
const UPGRADE_SOURCE = "chatgpt";

/** Append the ChatGPT source tag without discarding any existing query. */
function withUpgradeSource(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("source", UPGRADE_SOURCE);
    return parsed.href;
  } catch {
    // An unparseable override stays as-is; the public default is always valid.
    return url;
  }
}

/**
 * Resolve the one public checkout destination for this deployment.
 *
 * A backend-supplied link (either the success `upgrade`/`upgrade_url` or the
 * `PLAN_REQUIRED` error's recovery link) is never used verbatim: it can point at
 * a local or internal origin. The configured public URL wins, and it always
 * carries the ChatGPT source tag.
 */
function publicUpgradeUrl(config: AppConfig): string {
  let url = DEFAULT_UPGRADE_URL;
  try {
    const configured = new URL(config.MUTANT_UPGRADE_URL);
    if (configured.protocol === "https:") url = configured.href;
  } catch {
    // The public default is still usable if the deployment setting is malformed.
  }
  return withUpgradeSource(url);
}

/** Use the MCP deployment's public checkout URL instead of a backend-local URL. */
export function withPublicUpgradeUrl(response: ToolResponse, config: AppConfig): ToolResponse {
  if (!response.ok || !response.data) {
    // A `PLAN_REQUIRED` error carries its own recovery link. Point it at the same
    // tagged public destination so the model can never surface an internal URL.
    if (response.error && typeof response.error.upgrade_url === "string") {
      return {
        ...response,
        error: { ...response.error, upgrade_url: publicUpgradeUrl(config) },
      };
    }
    return response;
  }
  const data = response.data;
  const upgrade = data.upgrade;
  const hasUpgrade = upgrade && typeof upgrade === "object" && !Array.isArray(upgrade);
  if (!hasUpgrade && typeof data.upgrade_url !== "string") return response;

  const url = publicUpgradeUrl(config);

  return {
    ...response,
    data: {
      ...data,
      ...(hasUpgrade ? { upgrade: { ...upgrade, url } } : {}),
      ...(typeof data.upgrade_url === "string" ? { upgrade_url: url } : {}),
    },
  };
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { AppConfig } from "../../config.js";
import { OPENAI_OUTPUT_TEMPLATE_KEY, UI_RESOURCE_URI_LEGACY_KEY } from "../dna-import/resource.js";
import { ANALYSIS_FOLLOWUPS_HTML } from "./generated/html.js";

/**
 * Canonical Apps SDK UI resource URI for the compact analysis follow-up card.
 *
 * Deliberately stable - do not add a version token. ChatGPT resolves a widget
 * through a stored template snapshot keyed by this pointer, so changing the URI
 * (even to bust a CSS cache) makes the app hard-fail with
 * "Failed to fetch template" until OpenAI re-ingests the template.
 *
 * This is a separate document from `ui://mutant/dna-import/v1.html` on purpose:
 * the follow-up card is small and navigation-only, so it can be hosted and
 * cached independently of the large overview/import bundle.
 */
export const ANALYSIS_FOLLOWUPS_UI_URI = "ui://mutant/analysis-followups/v1.html";

/**
 * The UI descriptor attached to a tool descriptor and echoed onto the tool
 * result, so a host can mount the component whether it reads `_meta` from
 * `tools/list` or from the `tools/call` result.
 */
export function analysisFollowupsUiMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: ANALYSIS_FOLLOWUPS_UI_URI, visibility: ["model", "app"] },
    [UI_RESOURCE_URI_LEGACY_KEY]: ANALYSIS_FOLLOWUPS_UI_URI,
    [OPENAI_OUTPUT_TEMPLATE_KEY]: ANALYSIS_FOLLOWUPS_UI_URI,
  };
}

/**
 * Register the compact analysis follow-up UI resource.
 *
 * The document is self-contained and its Content Security Policy is intentionally
 * empty: the card reaches the server only through the host bridge, and the
 * plan-information destination goes through `App.openLink`, so it needs no connect or
 * resource domains.
 *
 * Read-only: this resource carries no account data, so it is the same document
 * for every authenticated user.
 */
export function registerAnalysisFollowupsUi(
  server: Pick<McpServer, "registerResource">,
  _config: AppConfig,
): void {
  registerAppResource(
    server,
    "Mutant follow-up",
    ANALYSIS_FOLLOWUPS_UI_URI,
    {
      title: "Mutant follow-up",
      description: "Keep exploring a Mutant finding with context-specific next steps.",
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: ANALYSIS_FOLLOWUPS_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: ANALYSIS_FOLLOWUPS_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              // No CSP domains: the component only talks over the host bridge.
              csp: {},
            },
          },
        },
      ],
    }),
  );
}

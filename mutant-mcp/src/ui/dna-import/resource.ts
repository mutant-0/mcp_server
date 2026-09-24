import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { AppConfig } from "../../config.js";
import { DNA_IMPORT_HTML } from "./generated/html.js";

/**
 * Canonical Apps SDK UI resource URI for the DNA import experience.
 *
 * Deliberately stable — do not add a version token. ChatGPT resolves a widget
 * through a stored template snapshot keyed by this pointer, so changing the URI
 * (even to bust a CSS cache) makes the app hard-fail with
 * "Failed to fetch template" until OpenAI re-ingests the template. Layout and
 * CSS changes ride along with the document under this one URI.
 */
export const DNA_IMPORT_UI_URI = "ui://mutant/dna-import/v1.html";

/**
 * Legacy alias keys for the UI descriptor. `ui/resourceUri` is the pre-`_meta.ui`
 * MCP Apps key; `openai/outputTemplate` is the ChatGPT Apps SDK key. Both are
 * emitted alongside `_meta.ui.resourceUri` so the component still mounts on
 * hosts that predate the current spec.
 */
export const UI_RESOURCE_URI_LEGACY_KEY = "ui/resourceUri";
export const OPENAI_OUTPUT_TEMPLATE_KEY = "openai/outputTemplate";

/**
 * The UI descriptor attached to a tool descriptor and echoed onto the tool
 * result, so a host can mount the component whether it reads `_meta` from
 * `tools/list` or from the `tools/call` result.
 */
export function dnaImportUiMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: DNA_IMPORT_UI_URI, visibility: ["model", "app"] },
    [UI_RESOURCE_URI_LEGACY_KEY]: DNA_IMPORT_UI_URI,
    [OPENAI_OUTPUT_TEMPLATE_KEY]: DNA_IMPORT_UI_URI,
  };
}

/**
 * Register the shared analysis overview and DNA import UI resource.
 *
 * The component is served as a single self-contained HTML document so the host
 * can cache it independently of tool results. Its Content Security Policy is
 * intentionally left empty: the component reaches the server exclusively through
 * the host bridge (`tools/call`), so it needs no `connectDomains` (fetch/XHR/
 * WebSocket) and no `resourceDomains` (scripts, styles, images) — nothing is
 * loaded from an external origin and no request leaves the iframe directly.
 *
 * Read-only: this resource carries no account data, so it is the same document
 * for every authenticated user.
 */
export function registerDnaImportUi(
  server: Pick<McpServer, "registerResource">,
  _config: AppConfig,
): void {
  registerAppResource(
    server,
    "Mutant Genomics",
    DNA_IMPORT_UI_URI,
    {
      title: "Mutant Genomics",
      description:
        "View your analysis findings and hints, or import DNA processed locally in the browser.",
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: DNA_IMPORT_UI_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: DNA_IMPORT_HTML,
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

import { describe, expect, it } from "vitest";
import {
  ANALYSIS_TOOL_NAMES,
  CONTRACT_VERSION,
  DNA_IMPORT_TOOL_NAMES,
  TOOL_NAMES,
} from "../src/contract.js";
import { TOOL_DEFINITIONS, toolMeta } from "../src/tools/index.js";
import { readOnlyAnnotations, type MutantToolDefinition } from "../src/tools/types.js";
import { dnaImportUiMeta, DNA_IMPORT_UI_URI } from "../src/ui/dna-import/resource.js";
import { ANALYSIS_FOLLOWUPS_UI_URI } from "../src/ui/analysis-followups/resource.js";
import { ANALYSIS_SCOPE, DNA_SCOPE, makeConfig } from "./helpers.js";

/**
 * Input property names for a tool, whether it declares a raw Zod shape or a
 * prebuilt Zod object schema (as `create_report` does so it can be strict).
 */
function inputKeys(tool: MutantToolDefinition): string[] {
  const schema = tool.inputSchema as { shape?: unknown };
  const shape = schema.shape;
  if (shape && typeof shape === "object") return Object.keys(shape as Record<string, unknown>);
  return Object.keys(tool.inputSchema as Record<string, unknown>);
}

describe("tool definitions", () => {
  it("exposes exactly the eleven contract tools in order", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_DEFINITIONS).toHaveLength(
      ANALYSIS_TOOL_NAMES.length + DNA_IMPORT_TOOL_NAMES.length,
    );
  });

  it("gives every tool a description, schemas, and annotations", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBeDefined();
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  it("documents the concise explanation, support architecture, and personal-context boundary", () => {
    const details = TOOL_DEFINITIONS.find((tool) => tool.name === "explain_health_hypothesis");
    expect(details?.description).toContain("what it means");
    expect(details?.description).toContain("what could clarify it");
    expect(details?.description).toContain("support architecture");
    expect(details?.description).toContain("not that it is broadly distributed");
    expect(details?.description).toContain("authorized context source");
    expect(details?.description).toContain("catalog cofactors, confounders, cautions");
    expect(details?.description).toContain("disease probability");
    expect(details?.description).toContain("get_supporting_evidence");

    const evidence = TOOL_DEFINITIONS.find((tool) => tool.name === "get_supporting_evidence");
    expect(evidence?.description).toContain('"modules"');
    expect(evidence?.description).toContain("include_context");
    expect(inputKeys(evidence!)).toContain("include_context");
  });

  it("keeps every tool except create_report read-only and idempotent", () => {
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.name === "create_report") continue;
      expect(tool.annotations).toMatchObject(readOnlyAnnotations);
    }
    const createReport = TOOL_DEFINITIONS.find((tool) => tool.name === "create_report");
    expect(createReport?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("never exposes an analysis, account, or plan argument", () => {
    const forbidden = ["analysis_id", "analysisId", "account_id", "accountId", "plan", "user_id"];
    for (const tool of TOOL_DEFINITIONS) {
      for (const key of forbidden) {
        expect(inputKeys(tool)).not.toContain(key);
      }
    }
  });

  it("uses contract version 3.4.0", () => {
    expect(CONTRACT_VERSION).toBe("3.4.0");
  });

  it("requires analysis.read for analysis tools and dna.import for DNA import tools", () => {
    const analysisNames = new Set<string>(ANALYSIS_TOOL_NAMES);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.scope).toBe(analysisNames.has(tool.name) ? "analysis.read" : "dna.import");
    }
  });

  it("advertises each tool's own scope in _meta.securitySchemes", () => {
    const config = makeConfig();
    for (const tool of TOOL_DEFINITIONS) {
      const meta = toolMeta(tool, config) as {
        securitySchemes?: Array<{ type: string; scopes: string[] }>;
      };
      const expected = tool.scope === "dna.import" ? DNA_SCOPE : ANALYSIS_SCOPE;
      expect(meta.securitySchemes).toEqual([{ type: "oauth2", scopes: [expected] }]);
    }
  });

  it("attaches the Apps SDK UI descriptor to the three display tools only", () => {
    const config = makeConfig();
    const displayUris: Record<string, string> = {
      show_dna_import: DNA_IMPORT_UI_URI,
      show_analysis_overview: DNA_IMPORT_UI_URI,
      show_analysis_followups: ANALYSIS_FOLLOWUPS_UI_URI,
    };
    for (const tool of TOOL_DEFINITIONS) {
      const meta = toolMeta(tool, config) as Record<string, unknown>;
      const expectedUri = displayUris[tool.name];
      if (!expectedUri) {
        expect(meta["openai/outputTemplate"]).toBeUndefined();
        expect(meta["ui/resourceUri"]).toBeUndefined();
        continue;
      }
      expect(meta.ui).toEqual({
        resourceUri: expectedUri,
        visibility: ["model", "app"],
      });
      // Legacy aliases keep the component mounting on older hosts.
      expect(meta["ui/resourceUri"]).toBe(expectedUri);
      expect(meta["openai/outputTemplate"]).toBe(expectedUri);
    }
  });

  it("hides the component-support tools from the model", () => {
    const config = makeConfig();
    for (const name of ["poll_analysis_status", "get_snp_catalog", "create_report"]) {
      const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(tool?.uiVisibility).toEqual(["app"]);
      const meta = toolMeta(tool!, config) as { ui?: { visibility?: string[] } };
      expect(meta.ui?.visibility).toEqual(["app"]);
    }
  });

  it("prohibits future-capability speculation in the status instructions", () => {
    const status = TOOL_DEFINITIONS.find((tool) => tool.name === "get_analysis_status");
    const description = status?.description ?? "";
    expect(description).toContain('"PROCESSING_INITIAL"');
    expect(description).toContain('"REFRESH_PROCESSING_NO_USABLE_ANALYSIS"');
    expect(description).toContain("Do not describe, preview, or speculate about future");
    expect(description).toContain("Do not enumerate future genes, modules, rsIDs");
    expect(description).toContain("let it own the experience");
    expect(description).toContain("do not initiate assistant polling loops");
    expect(description).toContain("Silence is preferred");
    // The known-bad response is named explicitly, and the description no longer
    // claims this tool is what the component polls.
    expect(description).toContain("Once processing completes, I can show your DNA at");
    expect(description).toContain("poll_analysis_status");
    expect(description).not.toContain("polls this tool");
  });

  it("policy-describes the three entry prompts and the catalog-search rule", () => {
    const status = TOOL_DEFINITIONS.find((tool) => tool.name === "get_analysis_status");
    const description = status?.description ?? "";
    expect(description).toContain("Show my current Mutant findings.");
    expect(description).toContain("Help me add my DNA data to Mutant.");
    expect(description).toContain("Call this tool first for all three");
    expect(description).toContain("Pass only catalog-topic keywords to list_health_hypotheses");
    expect(description).toContain("never the user's health-history prose");
  });

  it("explains the Free search boundary on the list tool description", () => {
    const list = TOOL_DEFINITIONS.find((tool) => tool.name === "list_health_hypotheses");
    const description = list?.description ?? "";
    // The server-authored scope is named, and a Free miss is bounded to it.
    expect(description).toContain("search_scope");
    expect(description).toContain("broader_ranked_search_available");
    expect(description).toContain("no_match_in_accessible_scope");
    expect(description).toContain("does not say whether the locked ranked");
    // The Full miss stays limited to the catalog search fields, and no pitch.
    expect(description).toContain("catalog search fields");
    expect(description).not.toContain("Upgrade now");
  });

  it("echoes the UI descriptor on the show_dna_import result metadata", () => {
    expect(dnaImportUiMeta()).toEqual({
      ui: { resourceUri: DNA_IMPORT_UI_URI, visibility: ["model", "app"] },
      "ui/resourceUri": DNA_IMPORT_UI_URI,
      "openai/outputTemplate": DNA_IMPORT_UI_URI,
    });
  });
});

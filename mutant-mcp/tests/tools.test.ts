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
  it("exposes exactly the nine contract tools in order", () => {
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

  it("documents the module-first explanation and the modules evidence kind", () => {
    const details = TOOL_DEFINITIONS.find((tool) => tool.name === "explain_health_hypothesis");
    expect(details?.description).toContain("broad or concentrated");
    expect(details?.description).toContain("modules and retained patterns");
    expect(details?.description).toContain("Explain modules and patterns before individual genes");

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

  it("uses contract version 2.0.0", () => {
    expect(CONTRACT_VERSION).toBe("2.0.0");
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

  it("attaches the Apps SDK UI descriptor to show_dna_import only", () => {
    const config = makeConfig();
    for (const tool of TOOL_DEFINITIONS) {
      const meta = toolMeta(tool, config) as Record<string, unknown>;
      if (tool.name !== "show_dna_import") {
        expect(meta["openai/outputTemplate"]).toBeUndefined();
        expect(meta["ui/resourceUri"]).toBeUndefined();
        continue;
      }
      expect(meta.ui).toEqual({
        resourceUri: DNA_IMPORT_UI_URI,
        visibility: ["model", "app"],
      });
      // Legacy aliases keep the component mounting on older hosts.
      expect(meta["ui/resourceUri"]).toBe(DNA_IMPORT_UI_URI);
      expect(meta["openai/outputTemplate"]).toBe(DNA_IMPORT_UI_URI);
    }
  });

  it("hides the component-support tools from the model", () => {
    const config = makeConfig();
    for (const name of ["get_snp_catalog", "create_report"]) {
      const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(tool?.uiVisibility).toEqual(["app"]);
      const meta = toolMeta(tool!, config) as { ui?: { visibility?: string[] } };
      expect(meta.ui?.visibility).toEqual(["app"]);
    }
  });

  it("echoes the UI descriptor on the show_dna_import result metadata", () => {
    expect(dnaImportUiMeta()).toEqual({
      ui: { resourceUri: DNA_IMPORT_UI_URI, visibility: ["model", "app"] },
      "ui/resourceUri": DNA_IMPORT_UI_URI,
      "openai/outputTemplate": DNA_IMPORT_UI_URI,
    });
  });
});

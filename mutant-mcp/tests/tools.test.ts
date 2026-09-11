import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, TOOL_NAMES } from "../src/contract.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";
import { readOnlyAnnotations } from "../src/tools/types.js";

describe("tool definitions", () => {
  it("exposes exactly the six contract tools in order", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("gives every tool a description, schemas, and read-only annotations", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toMatchObject(readOnlyAnnotations);
    }
  });

  it("never exposes an analysis, account, or plan argument", () => {
    const forbidden = ["analysis_id", "analysisId", "account_id", "accountId", "plan", "user_id"];
    for (const tool of TOOL_DEFINITIONS) {
      for (const key of forbidden) {
        expect(Object.keys(tool.inputSchema)).not.toContain(key);
      }
    }
  });

  it("uses contract version 1.0.0", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
  });
});

import { describe, it, expect } from "vitest";
import { TOOL_ACCESS, TOOL_NAMES } from "../src/entitlements/access-policy.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";
import { makeConfig, makeUser } from "./helpers.js";

describe("tool definitions", () => {
  it("registers all seven tools with stable names", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(7);
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("matches the access tiers defined in the policy", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.accessTier).toBe(TOOL_ACCESS[definition.name]);
    }
  });

  it("exposes input schema, output schema, and read-only annotations", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema).toBeDefined();
      expect(definition.outputSchema).toBeDefined();
      expect(definition.title).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(definition.annotations.readOnlyHint).toBe(true);
    }
  });

  it("has four free tools and three paid tools", () => {
    expect(TOOL_DEFINITIONS.filter((t) => t.accessTier === "free")).toHaveLength(4);
    expect(TOOL_DEFINITIONS.filter((t) => t.accessTier === "paid")).toHaveLength(3);
  });

  it("handlers return not_implemented placeholders", async () => {
    for (const definition of TOOL_DEFINITIONS) {
      const result = await definition.handler({}, makeUser("paid"), makeConfig());
      const structured = result.structuredContent as { status: string; tool: string };
      expect(structured.status).toBe("not_implemented");
      expect(structured.tool).toBe(definition.name);
    }
  });
});

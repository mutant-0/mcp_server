import { analysisContextDataSchema } from "../src/schemas/outputs.js";
import { makeContextData } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";
import { SERVER_INSTRUCTIONS } from "../src/server.js";

describe("scoring v3.4 descriptions", () => {
  it("distinguishes explanatory convergence from contributing storm evidence", () => {
    for (const name of ["explain_health_hypothesis", "get_supporting_evidence"]) {
      const description = TOOL_DEFINITIONS.find(t => t.name === name)!.description;
      expect(description).toContain("without a separate ranking bonus");
      expect(description).toContain("historical reports");
      expect(description).toContain("shared evidence once");
    }
    expect(SERVER_INSTRUCTIONS).toContain("Confidence modulates genetic priority");
  });
});

import { analysisContextDataSchema } from "../src/schemas/outputs.js";
import { makeContextData } from "./helpers.js";

it("accepts historical and new interpretation contracts during rollout", () => {
  const data = makeContextData({ suggested_prompts: [] });
  const interpretation = data.interpretation as Record<string, unknown>;
  for (const version of ["2.7", "2.8"]) {
    expect(analysisContextDataSchema.safeParse({ ...data, interpretation: { ...interpretation, version } }).success).toBe(true);
  }
  expect(analysisContextDataSchema.safeParse({ ...data, interpretation: { ...interpretation, version: "2.9" } }).success).toBe(false);
});

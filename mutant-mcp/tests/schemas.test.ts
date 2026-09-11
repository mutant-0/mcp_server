import { describe, expect, it } from "vitest";
import { toolResponseOutputSchema } from "../src/schemas/index.js";
import { makeErrorResponse, makeSuccessResponse } from "./helpers.js";

describe("toolResponseOutputSchema", () => {
  it("accepts a success envelope", () => {
    expect(toolResponseOutputSchema.safeParse(makeSuccessResponse()).success).toBe(true);
  });

  it("accepts an error envelope", () => {
    expect(
      toolResponseOutputSchema.safeParse(
        makeErrorResponse("ANALYSIS_CHANGED", "changed"),
      ).success,
    ).toBe(true);
  });

  it("accepts a null analysis version", () => {
    expect(
      toolResponseOutputSchema.safeParse(makeErrorResponse("INVALID_CURSOR")).success,
    ).toBe(true);
  });

  it("rejects a payload missing required envelope fields", () => {
    expect(toolResponseOutputSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

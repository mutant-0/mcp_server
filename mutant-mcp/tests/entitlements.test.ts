import { describe, it, expect } from "vitest";
import { canAccess, requiredTier, TOOL_ACCESS, TOOL_NAMES } from "../src/entitlements/access-policy.js";
import { makeUser } from "./helpers.js";

describe("entitlements / access-policy", () => {
  it("defines four free tools and three paid tools", () => {
    expect(TOOL_NAMES).toHaveLength(7);
    const tiers = TOOL_NAMES.map((name) => requiredTier(name));
    expect(tiers.filter((t) => t === "free")).toHaveLength(4);
    expect(tiers.filter((t) => t === "paid")).toHaveLength(3);
  });

  it("lets any user access free tools", () => {
    for (const name of TOOL_NAMES) {
      if (TOOL_ACCESS[name] === "free") {
        expect(canAccess(name, makeUser("free"))).toBe(true);
        expect(canAccess(name, makeUser("paid"))).toBe(true);
      }
    }
  });

  it("only lets paid users access paid tools", () => {
    for (const name of TOOL_NAMES) {
      if (TOOL_ACCESS[name] === "paid") {
        expect(canAccess(name, makeUser("paid"))).toBe(true);
        expect(canAccess(name, makeUser("free"))).toBe(false);
      }
    }
  });
});

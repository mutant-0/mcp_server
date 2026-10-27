import { MockMutantBackendClient } from "../src/clients/mutant-lambda-client.js";
import { describe, expect, it } from "vitest";
import { getConsentTool, saveConsentTool } from "../src/tools/consent.js";
import { attachConsentPendingAction } from "../src/tools/consent-pending.js";
import { explainHealthHypothesisTool } from "../src/tools/explain-health-hypothesis.js";
import { createReportTool } from "../src/tools/create-report.js";
import { enforceScope } from "../src/tools/scope-guard.js";
import { toolMeta } from "../src/tools/index.js";
import { ANALYSIS_SCOPE, DNA_SCOPE, makeConfig, makeUser } from "./helpers.js";
import type { ToolRuntime } from "../src/tools/types.js";

describe("consent tool boundaries", () => {
  it("keeps local development consent across per-request clients and isolated by connection", async () => {
    const user = makeUser({ userId: "consent-dev-test", clientId: "connector-a" });
    const saved = await new MockMutantBackendClient().invoke(
      "save_consent",
      { notice_version: "2026-10-01", purposes: ["chatgpt_sharing"] },
      user,
      "r1",
    );
    expect(saved.ok).toBe(true);
    const read = await new MockMutantBackendClient().invoke("get_consent", {}, user, "r2");
    expect(JSON.stringify(read.data)).toContain('"current":true');
    const other = await new MockMutantBackendClient().invoke(
      "get_consent",
      {},
      { ...user, clientId: "connector-b" },
      "r3",
    );
    expect(JSON.stringify(other.data)).not.toContain('"current":true');
  });
  it("keeps both tools app-only and saving explicitly marked as a write", () => {
    for (const tool of [getConsentTool, saveConsentTool]) {
      expect(toolMeta(tool, makeConfig()).ui).toEqual({ visibility: ["app"] });
    }
    expect(getConsentTool.annotations.readOnlyHint).toBe(true);
    expect(saveConsentTool.annotations.readOnlyHint).toBe(false);
    expect(saveConsentTool.annotations.idempotentHint).toBe(true);
  });
  it("uses the existing write scope, denying read-only connections for saving", () => {
    const runtime = {
      config: makeConfig(),
      user: makeUser({ scopes: [ANALYSIS_SCOPE] }),
    } as ToolRuntime;
    expect(enforceScope(getConsentTool, runtime)).toBeNull();
    expect(enforceScope(saveConsentTool, runtime)?.error?.code).toBe("INSUFFICIENT_SCOPE");
    runtime.user.scopes.push(DNA_SCOPE);
    expect(enforceScope(saveConsentTool, runtime)).toBeNull();
  });
  it("retains only analytical routing arguments for a blocked question", () => {
    const result = attachConsentPendingAction(
      { content: [], structuredContent: { error: { code: "CONSENT_REQUIRED" } } },
      explainHealthHypothesisTool,
      {
        hypothesis_id: "RC_A",
        analysis_version: "v1",
        user_id: "other",
        token: "secret",
        snps: { rs1: "AA" },
      },
    );
    expect((result._meta?.mutant as Record<string, unknown>).pending_action).toEqual({
      tool: "explain_health_hypothesis",
      args: { hypothesis_id: "RC_A", analysis_version: "v1" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("rs1");
  });
  it("never copies an import payload into continuation metadata", () => {
    const source = { content: [], structuredContent: { error: { code: "CONSENT_REQUIRED" } } };
    expect(attachConsentPendingAction(source, createReportTool, { snps: { rs1: "AA" } })).toBe(
      source,
    );
  });
});

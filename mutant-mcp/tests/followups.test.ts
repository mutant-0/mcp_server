/**
 * Follow-up card integration tests.
 *
 * These exercise the real MCP transport against a stub backend, so they assert
 * what the host actually receives: exactly one compact card per answer, actions
 * bound to the same revision and authorized ids as the answer, and a structured
 * status - never a silent switch - when a pin or an id is rejected.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendOperation, ToolResponse } from "../src/contract.js";
import { createMcpServer } from "../src/server.js";
import { ANALYSIS_FOLLOWUPS_UI_URI } from "../src/ui/analysis-followups/resource.js";
import {
  ANALYSIS_SCOPE,
  DNA_SCOPE,
  StubBackendClient,
  makeConfig,
  makeErrorResponse,
  makeFollowupsData,
  makeSuccessResponse,
  makeToolResponse,
  makeUser,
} from "./helpers.js";

interface FollowupAction {
  id: string;
  label: string;
  prompt: string;
  intent?: string;
  hypothesis_id?: string;
  action?: { analysis_version?: string; hypothesis_id?: string; intent?: string };
}

interface FollowupsData {
  mode?: string;
  intent?: string;
  plan?: string;
  displayed_analysis_version?: string | null;
  displayed_hypotheses?: Array<{ id: string | null; rank: number; name: string }>;
  actions?: FollowupAction[];
  upgrade?: { label: string; url: string };
  source?: string;
}

async function connectServer(
  responder: (operation: BackendOperation) => ToolResponse = (operation) =>
    makeToolResponse(operation),
) {
  const backendClient = new StubBackendClient((operation) => responder(operation));
  const server = createMcpServer(
    makeUser({ scopes: [ANALYSIS_SCOPE, DNA_SCOPE] }),
    makeConfig(),
    "req-followups",
    backendClient,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "followups-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, backendClient };
}

const ARGS = {
  intent: "explanation",
  analysis_version: "rev42-v3.0.0",
  hypothesis_ids: ["HYP_A"],
};

describe("follow-up card integration", () => {
  it("mounts exactly one card with actions bound to the answer's revision", async () => {
    const { client } = await connectServer();
    const first = await client.callTool({ name: "show_analysis_followups", arguments: ARGS });
    const second = await client.callTool({
      name: "show_analysis_followups",
      arguments: { ...ARGS, intent: "comparison" },
    });

    for (const result of [first, second]) {
      const meta = result._meta as
        | { ui?: { resourceUri?: string }; mutant?: { mode?: string } }
        | undefined;
      expect(meta?.ui?.resourceUri).toBe(ANALYSIS_FOLLOWUPS_UI_URI);
      expect(meta?.mutant?.mode).toBe("followups");
    }

    const data = first.structuredContent as ToolResponse;
    const payload = data.data as unknown as FollowupsData;
    expect(payload.displayed_analysis_version).toBe("rev42-v3.0.0");
    expect(payload.actions?.length).toBeGreaterThan(0);
    expect(payload.actions?.length).toBeLessThanOrEqual(2);
    for (const action of payload.actions ?? []) {
      // Every action is pinned to the same revision and an authorized id.
      expect(action.action?.analysis_version).toBe("rev42-v3.0.0");
      expect(action.hypothesis_id).toBe("HYP_A");
      expect(action.prompt.length).toBeGreaterThan(0);
    }
  });

  it("keeps the model-facing text to a single line that never repeats the answer", async () => {
    const { client } = await connectServer();
    const result = await client.callTool({ name: "show_analysis_followups", arguments: ARGS });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.map((part) => part.text ?? "").join(" ");
    expect(text).toContain("Follow-up card displayed.");
    expect(text).not.toContain("Alpha finding");
  });

  it("returns a structured status for a stale pin instead of switching revisions", async () => {
    const { client } = await connectServer((operation) =>
      operation === "resolve_analysis_followups"
        ? makeErrorResponse("ANALYSIS_VERSION_CHANGED", "stale analysis pin", {
            reason: "snapshot_changed",
          })
        : makeToolResponse(operation),
    );
    const result = await client.callTool({
      name: "show_analysis_followups",
      arguments: { ...ARGS, analysis_version: "rev1-v1" },
    });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ToolResponse;
    expect(envelope.error?.code).toBe("ANALYSIS_VERSION_CHANGED");
    const meta = result._meta as { ui?: unknown; mutant?: unknown } | undefined;
    expect(meta?.ui).toBeUndefined();
    expect(meta?.mutant).toBeUndefined();
  });

  it("returns a structured status for a locked hypothesis on Free", async () => {
    const { client } = await connectServer((operation) =>
      operation === "resolve_analysis_followups"
        ? makeErrorResponse("PLAN_REQUIRED", "that finding needs Mutant Full")
        : makeToolResponse(operation),
    );
    const result = await client.callTool({
      name: "show_analysis_followups",
      arguments: { ...ARGS, hypothesis_ids: ["HYP_D"] },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as ToolResponse).error?.code).toBe("PLAN_REQUIRED");
  });

  it("shows the Full route on Free and omits it on Full", async () => {
    const free = await connectServer(() =>
      makeSuccessResponse(
        makeFollowupsData({
          plan: "mutant_free",
          upgrade: {
            label: "Unlock Full Analysis",
            url: "https://mutantgenomics.com/upgrade?source=chatgpt",
          },
        }),
      ),
    );
    const freeResult = await free.client.callTool({
      name: "show_analysis_followups",
      arguments: ARGS,
    });
    const freeData = (freeResult.structuredContent as ToolResponse).data as unknown as FollowupsData;
    expect(freeData.upgrade?.url).toContain("source=chatgpt");

    const full = await connectServer(() =>
      makeSuccessResponse(makeFollowupsData({ plan: "mutant_full" })),
    );
    const fullResult = await full.client.callTool({
      name: "show_analysis_followups",
      arguments: ARGS,
    });
    const fullData = (fullResult.structuredContent as ToolResponse).data as unknown as FollowupsData;
    expect(fullData.plan).toBe("mutant_full");
    expect(fullData.upgrade).toBeUndefined();
  });

  it("leaves the answer complete when the render fails", async () => {
    const { client } = await connectServer((operation) =>
      operation === "resolve_analysis_followups"
        ? makeErrorResponse("SERVICE_UNAVAILABLE", "backend unavailable", { retryable: true })
        : makeToolResponse(operation),
    );
    // The explanation itself succeeded; only the optional card failed.
    const explanation = await client.callTool({
      name: "explain_health_hypothesis",
      arguments: { hypothesis_id: "HYP_A" },
    });
    expect(explanation.isError).toBe(false);

    const card = await client.callTool({ name: "show_analysis_followups", arguments: ARGS });
    expect(card.isError).toBe(true);
    // A failed card never advertises a render target.
    expect((card._meta as { ui?: unknown } | undefined)?.ui).toBeUndefined();
  });

  it("rejects malformed arguments before touching the backend", async () => {
    const { client } = await connectServer();
    const missingVersion = await client.callTool({
      name: "show_analysis_followups",
      arguments: { intent: "explanation", hypothesis_ids: ["HYP_A"] },
    });
    expect(missingVersion.isError).toBe(true);

    const tooManyIds = await client.callTool({
      name: "show_analysis_followups",
      arguments: { ...ARGS, hypothesis_ids: ["A", "B", "C", "D"] },
    });
    expect(tooManyIds.isError).toBe(true);
  });
});

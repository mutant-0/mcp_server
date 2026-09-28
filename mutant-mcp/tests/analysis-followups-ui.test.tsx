// @vitest-environment jsdom
/**
 * Component tests for the compact analysis follow-up card.
 *
 * The card is navigation only, so these tests assert what it may and may not do:
 * mount at most two bound actions, send the server-selected prompt on click,
 * route Free users to the upgrade page, never repeat the answer, and stay usable
 * at a narrow viewport. The card talks to the server only through the host
 * bridge, so the harness is the same fake host the DNA import tests use.
 */
import "./setup-ui";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/ext-apps";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisFollowupsApp } from "../src/ui/analysis-followups/app";
import { makeErrorResponse, makeFollowupsData, makeSuccessResponse } from "./helpers.js";

type ToolResponse = ReturnType<typeof makeSuccessResponse>;

const INITIALIZE_RESULT = {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  hostInfo: { name: "fake-host", version: "1.0.0" },
  hostCapabilities: {},
  hostContext: { theme: "light" },
};

function deliverToApp(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
}

/** The tool-result notification shape a host pushes after the tool returns. */
function toolResultNotification(structured: ToolResponse, meta?: Record<string, unknown>) {
  return {
    method: "ui/notifications/tool-result",
    params: {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
      isError: false,
      ...(meta ? { _meta: meta } : {}),
    },
  };
}

interface FollowupsBridge {
  openLinks: string[];
  sendToolResult(structured: ToolResponse, meta?: Record<string, unknown>): void;
  stop(): void;
}

let activeBridge: FollowupsBridge | null = null;

function installHostBridge(): FollowupsBridge {
  const openLinks: string[] = [];

  function reply(id: number, result: unknown): void {
    deliverToApp({ jsonrpc: "2.0", id, result });
  }

  function onMessage(event: MessageEvent): void {
    const message = event.data as {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: { url?: string };
    };
    if (!message || message.jsonrpc !== "2.0") return;
    if (typeof message.method !== "string" || message.id === undefined) return;

    if (message.method === "ui/initialize") {
      reply(message.id, INITIALIZE_RESULT);
      return;
    }
    if (message.method === "ui/open-link") {
      openLinks.push(String(message.params?.url ?? ""));
      reply(message.id, {});
      return;
    }
    reply(message.id, {});
  }

  window.addEventListener("message", onMessage);
  const bridge: FollowupsBridge = {
    openLinks,
    sendToolResult: (structured, meta) => {
      deliverToApp({ jsonrpc: "2.0", ...toolResultNotification(structured, meta) });
    },
    stop: () => window.removeEventListener("message", onMessage),
  };
  activeBridge = bridge;
  return bridge;
}

const FOLLOWUPS_META = { mutant: { mode: "followups" } };

function renderCard(): FollowupsBridge {
  const bridge = installHostBridge();
  render(<AnalysisFollowupsApp />);
  return bridge;
}

let sendFollowUpMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendFollowUpMessage = vi.fn().mockResolvedValue(undefined);
  (window as Window & { openai?: unknown }).openai = { sendFollowUpMessage };
});

afterEach(() => {
  activeBridge?.stop();
  activeBridge = null;
  cleanup();
  delete (window as Window & { openai?: unknown }).openai;
});

describe("analysis follow-up card", () => {
  it("renders only after a successful follow-up result and never repeats the answer", async () => {
    const bridge = renderCard();
    // Before any result the card renders nothing: a missing UI leaves the answer
    // complete rather than showing an empty shell.
    expect(screen.queryByRole("button")).toBeNull();

    bridge.sendToolResult(
      makeSuccessResponse(makeFollowupsData(), "rev42-v3.0.0"),
      FOLLOWUPS_META,
    );

    await screen.findByText("Explore this finding");
    // The hypothesis name is navigation context for the server, not card copy.
    expect(screen.queryByText("Alpha finding")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("sends the server-selected prompt on click", async () => {
    const bridge = renderCard();
    bridge.sendToolResult(
      makeSuccessResponse(makeFollowupsData(), "rev42-v3.0.0"),
      FOLLOWUPS_META,
    );

    const button = await screen.findByRole("button", { name: "Why this rank?" });
    fireEvent.click(button);

    await waitFor(() =>
      expect(sendFollowUpMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("rank where it did"),
        }),
      ),
    );
  });

  it("uses the comparison label and shows the history action's non-assuming prompt", async () => {
    const bridge = renderCard();
    bridge.sendToolResult(
      makeSuccessResponse(
        makeFollowupsData({
          intent: "comparison",
          actions: [
            {
              id: "explain-first",
              label: "Explain #1",
              prompt: "Explain my #1 finding in plain English.",
              intent: "explain",
              hypothesis_id: "HYP_A",
            },
            {
              id: "compare-with-history",
              label: "Compare with my history",
              prompt:
                "If I have not shared any health history in this conversation, ask me what I want to share before comparing.",
              intent: "comparison",
              hypothesis_id: "HYP_A",
            },
          ],
        }),
        "rev42-v3.0.0",
      ),
      FOLLOWUPS_META,
    );

    await screen.findByText("Keep exploring");
    fireEvent.click(screen.getByRole("button", { name: "Compare with my history" }));
    await waitFor(() =>
      expect(sendFollowUpMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.stringContaining("ask me what I want to share") }),
      ),
    );
  });

  it("never renders more than two actions", async () => {
    const bridge = renderCard();
    const data = makeFollowupsData();
    (data.actions as unknown[]).push({
      id: "third",
      label: "A third action",
      prompt: "Third",
      intent: "explain",
      hypothesis_id: "HYP_A",
    });
    bridge.sendToolResult(makeSuccessResponse(data, "rev42-v3.0.0"), FOLLOWUPS_META);

    await screen.findByText("Explore this finding");
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText("A third action")).toBeNull();
  });

  it("opens the upgrade route for Free and only hints at search for Full", async () => {
    const free = renderCard();
    free.sendToolResult(
      makeSuccessResponse(
        makeFollowupsData({
          plan: "mutant_free",
          upgrade: {
            label: "Unlock Full Analysis",
            url: "https://mutantgenomics.com/upgrade?source=chatgpt",
          },
        }),
        "rev42-v3.0.0",
      ),
      FOLLOWUPS_META,
    );

    const link = await screen.findByRole("link", { name: "Explore all findings with Full" });
    expect(link.getAttribute("href")).toContain("source=chatgpt");
    fireEvent.click(link);
    await waitFor(() =>
      expect(free.openLinks).toContain("https://mutantgenomics.com/upgrade?source=chatgpt"),
    );

    cleanup();
    activeBridge = null;

    const full = renderCard();
    full.sendToolResult(
      makeSuccessResponse(makeFollowupsData({ plan: "mutant_full" }), "rev42-v3.0.0"),
      FOLLOWUPS_META,
    );
    await screen.findByText("Explore this finding");
    expect(screen.queryByRole("link", { name: "Explore all findings with Full" })).toBeNull();
    expect(screen.getByText(/Search any ranked finding by topic/)).toBeTruthy();
  });

  it("renders nothing when the follow-up result is a structured error", async () => {
    const bridge = renderCard();
    bridge.sendToolResult(
      makeErrorResponse("ANALYSIS_VERSION_CHANGED", "stale pin", { reason: "snapshot_changed" }),
      FOLLOWUPS_META,
    );

    // No payload means no card: never a stale finding or a dead button.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Explore this finding")).toBeNull();
  });

  it("stacks its actions in one column for a narrow viewport", async () => {
    const bridge = renderCard();
    bridge.sendToolResult(
      makeSuccessResponse(makeFollowupsData(), "rev42-v3.0.0"),
      FOLLOWUPS_META,
    );

    const button = await screen.findByRole("button", { name: "Why this rank?" });
    const container = button.parentElement as HTMLElement;
    // One full-width track: the buttons never squeeze below the tap target.
    expect(container.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect((button as HTMLElement).style.width).toBe("100%");
  });
});

// @vitest-environment jsdom
import "./setup-ui";
import type { App } from "@modelcontextprotocol/ext-apps";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedConsent } from "../src/ui/dna-import/EmbeddedConsent";
import { makeConsentData, makeErrorResponse, makeSuccessResponse } from "./helpers.js";

afterEach(cleanup);
function setup(options: { saveFails?: boolean; confirmFails?: boolean; getFails?: boolean } = {}) {
  let accepted: string[] = [];
  const completed = vi.fn();
  const cancelled = vi.fn();
  const callServerTool = vi.fn(async ({ name, arguments: args }) => {
    if (name === "get_consent" && options.getFails)
      return { structuredContent: makeErrorResponse("SERVICE_UNAVAILABLE", "Unavailable") };
    if (name === "save_consent") {
      if (options.saveFails)
        return { structuredContent: makeErrorResponse("SERVICE_UNAVAILABLE", "Unavailable") };
      if (!options.confirmFails) accepted = args.purposes;
    }
    return { structuredContent: makeSuccessResponse(makeConsentData(accepted)) };
  });
  render(
    <EmbeddedConsent
      app={{ callServerTool } as unknown as App}
      requiredPurpose="chatgpt_sharing"
      onComplete={completed}
      onCancel={cancelled}
    />,
  );
  return { callServerTool, completed, cancelled };
}

describe("embedded consent", () => {
  it("loads the notice, leaves missing permissions unchecked, and saves only explicit choices", async () => {
    const test = setup();
    await screen.findByText("Notice version 2026-10-01");
    const choices = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(choices.every((choice) => !choice.checked)).toBe(true);
    const submit = screen.getByRole("button", { name: "Agree and continue" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Allow Mutant to share my results with ChatGPT" }),
    );
    fireEvent.click(submit);
    await waitFor(() => expect(test.completed).toHaveBeenCalledOnce());
    expect(test.callServerTool.mock.calls.map(([call]) => call.name)).toEqual([
      "get_consent",
      "save_consent",
      "get_consent",
    ]);
    expect(test.callServerTool.mock.calls[1]?.[0]).toEqual({
      name: "save_consent",
      arguments: { notice_version: "2026-10-01", purposes: ["chatgpt_sharing"] },
    });
  });
  it("does not save or continue when declined", async () => {
    const test = setup();
    await screen.findByText("Notice version 2026-10-01");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(test.cancelled).toHaveBeenCalledOnce();
    expect(test.completed).not.toHaveBeenCalled();
    expect(test.callServerTool).toHaveBeenCalledTimes(1);
  });
  it.each([{ saveFails: true }, { confirmFails: true }])(
    "never continues after failed or unconfirmed writes: %o",
    async (options) => {
      const test = setup(options);
      await screen.findByText("Notice version 2026-10-01");
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Allow Mutant to share my results with ChatGPT" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Agree and continue" }));
      await screen.findByRole("alert");
      expect(test.completed).not.toHaveBeenCalled();
    },
  );
  it("offers recovery without saving when the notice is unavailable", async () => {
    const test = setup({ getFails: true });
    await screen.findByRole("alert");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(test.completed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload privacy notice" }));
    await waitFor(() => expect(test.callServerTool).toHaveBeenCalledTimes(2));
  });
  it("requires fresh choices when the notice changes between display and confirmation", async () => {
    let reads = 0;
    const completed = vi.fn();
    const callServerTool = vi.fn(async ({ name }) => {
      if (name === "get_consent") reads++;
      const data = makeConsentData();
      if (reads > 1) data.notice.version = "2026-11-01";
      return { structuredContent: makeSuccessResponse(data) };
    });
    render(
      <EmbeddedConsent
        app={{ callServerTool } as unknown as App}
        requiredPurpose="chatgpt_sharing"
        onComplete={completed}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Allow Mutant to share my results with ChatGPT",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agree and continue" }));
    await screen.findByText("Notice version 2026-11-01");
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Allow Mutant to share my results with ChatGPT",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(completed).not.toHaveBeenCalled();
  });
  it("displays current grants as accepted without treating stale grants as acceptance", async () => {
    const data = makeConsentData(["genetic_processing", "chatgpt_sharing"]);
    const stale = data.purposes.find((row) => row.purpose === "chatgpt_sharing")!;
    stale.notice_version = "old";
    stale.current = false;
    render(
      <EmbeddedConsent
        app={
          {
            callServerTool: async () => ({ structuredContent: makeSuccessResponse(data) }),
          } as unknown as App
        }
        requiredPurpose="chatgpt_sharing"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const processing = (await screen.findByRole("checkbox", {
      name: "Allow Mutant to process my genetic data",
    })) as HTMLInputElement;
    expect(processing.checked).toBe(true);
    expect(processing.disabled).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Allow Mutant to share my results with ChatGPT",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
  it("prevents duplicate saves while the first is in progress", async () => {
    let release!: () => void;
    const completed = vi.fn();
    let accepted = false;
    const callServerTool = vi.fn(async ({ name }) => {
      if (name === "save_consent") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        accepted = true;
      }
      return {
        structuredContent: makeSuccessResponse(
          makeConsentData(accepted ? ["chatgpt_sharing"] : []),
        ),
      };
    });
    render(
      <EmbeddedConsent
        app={{ callServerTool } as unknown as App}
        requiredPurpose="chatgpt_sharing"
        onComplete={completed}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Allow Mutant to share my results with ChatGPT",
      }),
    );
    const submit = screen.getByRole("button", { name: "Agree and continue" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(callServerTool.mock.calls.filter(([call]) => call.name === "save_consent")).toHaveLength(
      1,
    );
    release();
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
  });
});

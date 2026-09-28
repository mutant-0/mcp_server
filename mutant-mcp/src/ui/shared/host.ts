/**
 * Shared host bridge for the Mutant Apps SDK components.
 *
 * Both the overview document and the compact follow-up document need to hand a
 * prompt back to the host conversation, and both must behave identically when the
 * host does not support it. Keeping the transport here means the two documents
 * cannot drift on which API wins or on what a failure looks like.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

/**
 * The ChatGPT Apps SDK host API, injected as `window.openai` in the widget
 * iframe. Only `sendFollowUpMessage` is used here: it posts a real user turn to
 * the conversation, unlike the MCP Apps bridge which some hosts do not wire up.
 */
interface ChatGptHostApi {
  sendFollowUpMessage?: (args: {
    prompt: string;
    scrollToBottom?: boolean;
  }) => void | Promise<void>;
}

/** Read `window.openai` without assuming the host injected it. */
export function chatGptHost(): ChatGptHostApi | null {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { openai?: ChatGptHostApi }).openai;
  return host && typeof host === "object" ? host : null;
}

/** Bridge-level failures are diagnostic; user-facing failures come from envelopes. */
export function logBridgeError(err: unknown): void {
  if (typeof console === "undefined" || typeof console.debug !== "function") return;
  console.debug("[mutant-ui] host bridge error", err);
}

/** What happened when a component tried to hand a prompt to the host chat. */
export type FollowUpOutcome = "sent" | "failed" | "unavailable";

/**
 * Post a follow-up user turn into the host conversation.
 *
 * ChatGPT injects `window.openai.sendFollowUpMessage`, which is the API that
 * actually advances a chatgpt.com conversation from inside a widget, so it wins
 * when the host provides it. Every other host exposes the equivalent MCP Apps
 * `ui/message` request through `App.sendMessage`.
 *
 * The prompt is only ever handed to the host. Nothing here renders it in the
 * widget: a missing or rejected API is reported back to the caller instead.
 */
export async function deliverFollowUp(app: App | null, prompt: string): Promise<FollowUpOutcome> {
  const host = chatGptHost();
  if (host && typeof host.sendFollowUpMessage === "function") {
    try {
      await host.sendFollowUpMessage({ prompt, scrollToBottom: true });
      return "sent";
    } catch (err) {
      logBridgeError(err);
      return "failed";
    }
  }

  if (app && typeof app.sendMessage === "function") {
    try {
      const result = await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: prompt }],
      });
      return result && result.isError === true ? "failed" : "sent";
    } catch (err) {
      logBridgeError(err);
      return "failed";
    }
  }

  return "unavailable";
}

/** User-visible copy for a handoff the host could not perform. Never a prompt. */
export const FOLLOW_UP_UNAVAILABLE_MESSAGE =
  "ChatGPT can't send a follow-up message from this panel. Reopen the panel and try again.";
export const FOLLOW_UP_FAILED_MESSAGE =
  "ChatGPT couldn't send that follow-up message. Please try again.";

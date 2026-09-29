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
 *
 * `widgetState` / `setWidgetState` are the ChatGPT widget-state mechanism. They
 * are used to persist only a non-sensitive sent action id and label so the click
 * acknowledgment survives a host remount of the card. Nothing else is stored.
 */
interface ChatGptHostApi {
  sendFollowUpMessage?: (args: {
    prompt: string;
    scrollToBottom?: boolean;
  }) => void | Promise<void>;
  widgetState?: unknown;
  setWidgetState?: (state: Record<string, unknown>) => void | Promise<void>;
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

/** Copy for a card whose bound analysis revision is no longer current. */
export const STALE_CARD_MESSAGE = "These results have changed. Open your current findings.";

/**
 * Fixed recovery handoff for a stale card. It carries no revision pin, so the
 * model re-resolves the current analysis and mounts the current overview card.
 */
export const STALE_CARD_RECOVERY_PROMPT = "Show my current Mutant findings.";
export const STALE_CARD_RECOVERY_HEADING = "Mutant follow-up: Current findings";

/**
 * Prefix every server-authored card-follow-up heading shares. The heading is
 * bounded display metadata: it names the action and, where applicable, the
 * finding, so the new assistant reply identifies itself immediately.
 */
export const FOLLOW_UP_HEADING_PREFIX = "Mutant follow-up: ";

/** Server-authored headings are bounded so a handoff prompt cannot balloon. */
const MAX_HEADING_CHARS = 80;

/**
 * Prepend the one generic heading instruction to a card action's prompt.
 *
 * This is the only place the card adds text to a server-selected prompt: the
 * label, prompt, and heading all come from the server. There is no
 * action-specific string in the React components.
 */
export function withCardHeading(prompt: string, heading: string | null | undefined): string {
  const trimmed = (heading ?? "").trim().slice(0, MAX_HEADING_CHARS);
  if (!trimmed) return prompt;
  return (
    `Start your reply with this heading on its own line: "${trimmed}". ` +
    `Then answer the question below.\n\n${prompt}`
  );
}

/** What the card remembers about the last action it sent, and shows as an ack. */
export interface SentAction {
  id: string;
  label: string;
}

/** Widget-state key. Only this non-sensitive acknowledgment is persisted. */
const SENT_ACTION_STATE_KEY = "mutantSentAction";

/** Read the persisted sent action from host widget state, when supported. */
export function readSentAction(): SentAction | null {
  const host = chatGptHost();
  const state = host?.widgetState;
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[SENT_ACTION_STATE_KEY];
  const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  const id = typeof row?.id === "string" ? row.id : null;
  const label = typeof row?.label === "string" ? row.label : null;
  if (!id || !label) return null;
  return { id, label };
}

/**
 * Persist only `{ id, label }` through the host widget state so the click
 * acknowledgment survives a remount. The full prompt, the analysis version, and
 * any health history are never stored. A host without the API is silently
 * accepted: the acknowledgment then lasts for the mounted lifetime only.
 */
export function persistSentAction(action: SentAction): void {
  const host = chatGptHost();
  if (!host || typeof host.setWidgetState !== "function") return;
  const current =
    host.widgetState && typeof host.widgetState === "object"
      ? (host.widgetState as Record<string, unknown>)
      : {};
  try {
    void Promise.resolve(
      host.setWidgetState({ ...current, [SENT_ACTION_STATE_KEY]: { id: action.id, label: action.label } }),
    ).catch(logBridgeError);
  } catch (err) {
    logBridgeError(err);
  }
}

/** Result of checking a card's bound revision against the current analysis. */
export type BoundVersionCheck = "current" | "stale" | "unknown";

/**
 * Compare a card's bound analysis version with the account's current analysis.
 *
 * The host handoff only transmits a prompt string, so a card's pinned
 * `analysis_version` never reaches the model's next tool call. The card narrows
 * that window by asking the app-only status channel before sending; a version
 * that no longer matches stops the handoff instead of silently explaining a
 * different finding. `unknown` means the check could not be completed (no bind,
 * no bridge, a scope gap, or a transient error) and the handoff proceeds: the
 * server's own `ANALYSIS_VERSION_CHANGED` remains the backstop.
 */
export async function verifyBoundVersion(
  app: App | null,
  boundVersion: string | null,
): Promise<BoundVersionCheck> {
  if (!app || typeof app.callServerTool !== "function" || !boundVersion) return "unknown";
  try {
    const result = await app.callServerTool({ name: "poll_analysis_status", arguments: {} });
    if ((result as { isError?: boolean }).isError === true) return "unknown";
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    const envelope =
      structured && typeof structured === "object"
        ? (structured as Record<string, unknown>)
        : null;
    if (!envelope || envelope.ok !== true) return "unknown";
    const version = typeof envelope.analysis_version === "string" ? envelope.analysis_version : null;
    if (!version) return "unknown";
    return version === boundVersion ? "current" : "stale";
  } catch (err) {
    logBridgeError(err);
    return "unknown";
  }
}

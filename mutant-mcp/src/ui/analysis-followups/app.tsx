/**
 * Mutant analysis follow-up - Apps SDK component.
 *
 * A compact companion to the overview card, mounted only by the deliberate
 * `show_analysis_followups` render tool after an explanation or comparison. It
 * is navigation, not a summary: a context label, at most two action buttons
 * bound to the hypothesis ids and the analysis revision the answer already
 * covered, and - Free only - a quiet route to Mutant Full.
 *
 * The card never repeats the generated answer, never renders hypothesis prose,
 * and never asks for or displays health history. It talks to the host only
 * through the bridge; the history action's prompt explicitly asks the user what
 * they wish to share.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useApp, useDocumentTheme, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { DARK_PALETTE, LIGHT_PALETTE, paletteVars } from "../shared/theme";
import {
  FOLLOW_UP_FAILED_MESSAGE,
  FOLLOW_UP_UNAVAILABLE_MESSAGE,
  deliverFollowUp,
  logBridgeError,
} from "../shared/host";

/** The host context shape App exposes once connected. */
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

/** One server-selected action: a label, the prompt it sends, and its bound id. */
interface FollowupAction {
  id: string;
  label: string;
  prompt: string;
  hypothesisId: string | null;
}

/** The verified payload this card renders. Nothing here is derived client-side. */
export interface FollowupsPayload {
  mode: "followups";
  intent: "explanation" | "comparison";
  plan: "mutant_free" | "mutant_full";
  analysisVersion: string | null;
  hypotheses: Array<{ id: string | null; rank: number; name: string }>;
  actions: FollowupAction[];
  upgradeUrl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Only allow browser-safe destinations supplied by the analysis service. */
function safeUpgradeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Read the envelope out of a bridge tool result. The structured envelope is
 * authoritative; the text mirror exists only for hosts without structured data.
 */
function envelopeOf(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): Record<string, unknown> | null {
  const structured = asRecord(result.structuredContent);
  if (structured) return structured;
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Pull the card payload out of a `show_analysis_followups` data object.
 *
 * Defensive by design: anything missing means the card renders nothing, so a
 * malformed result can never show a wrong finding or a dead button.
 */
export function followupsFrom(data: unknown): FollowupsPayload | null {
  const row = asRecord(data);
  if (!row || row.mode !== "followups") return null;
  const intent = row.intent === "comparison" ? "comparison" : row.intent === "explanation" ? "explanation" : null;
  if (!intent) return null;
  const plan = row.plan === "mutant_full" ? "mutant_full" : "mutant_free";

  const hypotheses: FollowupsPayload["hypotheses"] = [];
  if (Array.isArray(row.displayed_hypotheses)) {
    for (const entry of row.displayed_hypotheses) {
      const item = asRecord(entry);
      if (!item) continue;
      const rank = typeof item.rank === "number" ? item.rank : hypotheses.length + 1;
      hypotheses.push({
        id: firstString(item.id),
        rank,
        name: firstString(item.name) ?? "Finding",
      });
    }
  }

  const actions: FollowupAction[] = [];
  if (Array.isArray(row.actions)) {
    for (const entry of row.actions) {
      const item = asRecord(entry);
      const label = firstString(item?.label);
      const prompt = firstString(item?.prompt);
      if (!item || !label || !prompt) continue;
      const bound = asRecord(item.action);
      actions.push({
        id: firstString(item.id) ?? String(actions.length),
        label,
        prompt,
        hypothesisId: firstString(item.hypothesis_id, bound?.hypothesis_id),
      });
    }
  }

  const upgrade = asRecord(row.upgrade);
  return {
    mode: "followups",
    intent,
    plan,
    analysisVersion: firstString(row.displayed_analysis_version),
    hypotheses,
    // The server selects at most two; the client never invents more.
    actions: actions.slice(0, 2),
    upgradeUrl: safeUpgradeUrl(firstString(upgrade?.url)),
  };
}

const styles = {
  card: {
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--color-text-primary, #1a1a1a)",
    background: "var(--color-background-primary, #ffffff)",
    padding: "16px 18px",
    minWidth: 0,
  } as CSSProperties,
  label: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-secondary, #4b5563)",
  } as CSSProperties,
  actions: {
    display: "grid",
    // One column by default so the card stays usable at a narrow viewport; the
    // buttons never squeeze below the host's minimum tap target.
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 8,
    marginTop: 12,
  } as CSSProperties,
  action: {
    display: "block",
    width: "100%",
    minHeight: 40,
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--mutant-accent)",
    background: "transparent",
    color: "var(--mutant-accent)",
    fontSize: 14,
    fontWeight: 600,
    textAlign: "left",
    cursor: "pointer",
  } as CSSProperties,
  primaryAction: {
    background: "var(--mutant-accent)",
    color: "var(--mutant-accent-text)",
  } as CSSProperties,
  hint: {
    margin: "12px 0 0",
    fontSize: 12,
    color: "var(--color-text-secondary, #6b7280)",
  } as CSSProperties,
  upgradeLink: {
    display: "inline-block",
    marginTop: 12,
    fontSize: 13,
    color: "var(--color-text-secondary, #4b5563)",
    textDecoration: "underline",
    cursor: "pointer",
  } as CSSProperties,
  error: {
    margin: "10px 0 0",
    fontSize: 12,
    color: "var(--mutant-error-text, #7f1d1d)",
  } as CSSProperties,
};

function Shell({ children }: { children: ReactNode }) {
  const theme = useDocumentTheme();
  const palette = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  return <div style={{ ...styles.card, ...paletteVars(palette) }}>{children}</div>;
}

/** The card's only heading: it never restates the answer or the findings. */
function contextLabel(intent: FollowupsPayload["intent"]): string {
  return intent === "comparison" ? "Keep exploring" : "Explore this finding";
}

export function AnalysisFollowupsApp() {
  const [payload, setPayload] = useState<FollowupsPayload | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const { app, isConnected } = useApp({
    appInfo: { name: "Mutant Genomics", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.onerror = logBridgeError;
      // Register before `connect` so the one-shot tool result is not missed.
      created.ontoolresult = (result) => {
        const envelope = envelopeOf(result);
        if (!envelope || envelope.ok !== true) return;
        const next = followupsFrom(envelope.data);
        if (!next) return;
        setPayload(next);
      };
    },
  });

  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  useEffect(() => {
    if (!isConnected || !app) return;
    setHostContext(app.getHostContext() ?? null);
  }, [isConnected, app]);
  useHostStyles(app, hostContext);

  const runAction = useCallback(
    async (action: FollowupAction) => {
      setHandoffError(null);
      const outcome = await deliverFollowUp(app, action.prompt);
      if (outcome === "unavailable") setHandoffError(FOLLOW_UP_UNAVAILABLE_MESSAGE);
      else if (outcome === "failed") setHandoffError(FOLLOW_UP_FAILED_MESSAGE);
    },
    [app],
  );

  const openUpgrade = useCallback(
    (url: string) => {
      if (!app) return;
      void app.openLink({ url }).then(
        (result) => {
          if (result.isError) setHandoffError("The upgrade page could not be opened.");
        },
        () => setHandoffError("The upgrade page could not be opened."),
      );
    },
    [app],
  );

  // A missing or failed payload leaves the chat answer complete: render nothing
  // rather than an empty shell or a fabricated finding.
  if (!payload || payload.actions.length === 0) return null;

  return (
    <Shell>
      <p style={styles.label}>{contextLabel(payload.intent)}</p>
      <div style={styles.actions}>
        {payload.actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            style={index === 0 ? { ...styles.action, ...styles.primaryAction } : styles.action}
            onClick={() => void runAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
      {payload.upgradeUrl ? (
        <a
          href={payload.upgradeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.upgradeLink}
          onClick={(event) => {
            event.preventDefault();
            openUpgrade(payload.upgradeUrl as string);
          }}
        >
          Explore all findings with Full
        </a>
      ) : payload.plan === "mutant_full" ? (
        <p style={styles.hint}>Search any ranked finding by topic to keep exploring.</p>
      ) : null}
      {handoffError ? <p style={styles.error}>{handoffError}</p> : null}
    </Shell>
  );
}

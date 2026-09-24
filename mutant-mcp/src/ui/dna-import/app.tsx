/**
 * Mutant DNA import - Apps SDK component.
 *
 * Renders the DNA upload experience inside ChatGPT and owns the entire
 * asynchronous lifecycle: file selection, the local parse, report creation, then
 * polling `get_analysis_status` until the analysis is ready or fails. The user
 * never has to ask ChatGPT again just to find out whether processing finished.
 *
 * The raw file is read here, in the sandboxed app iframe, and never leaves it:
 * the component uploads no bytes and makes no direct network request. It talks to
 * the Mutant MCP server only through the host bridge (`app.callServerTool`):
 *
 *   get_snp_catalog -> parse the raw file locally -> create_report
 *   get_analysis_status -> poll while processing -> list_health_hypotheses
 *
 * so the only things that cross the boundary are the normalized subset of
 * Mutant-relevant variants and ordinary analysis reads.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { useApp, useDocumentTheme, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { appErrorCode, type AppErrorCode, type ToolResponse } from "../../contract";
import { parseDnaFile } from "./parseFile";

/** Client-side ceiling mirroring the server's MAX_SNP_ENTRIES transport guard. */
const MAX_SNP_ENTRIES = 20000;

/**
 * Largest file the component will try to read locally. A whole-genome .vcf.gz or
 * a mis-selected BAM can be hundreds of megabytes; parsing one of those is
 * minutes of work and more memory than the app iframe is likely allowed. An
 * obviously wrong selection is rejected before the parse starts rather than after
 * it has stalled the panel.
 */
const MAX_LOCAL_FILE_BYTES = 1024 * 1024 * 1024;

/**
 * How often the component asks whether the analysis is ready, and how long it
 * keeps asking before handing the user a recoverable "still working" state. The
 * observed processing time is a couple of minutes, so the ceiling is generous
 * enough that only a genuinely stuck analysis reaches it.
 */
const DEFAULT_POLL_INTERVAL_MS = 7000;
const DEFAULT_MAX_POLLING_MS = 10 * 60 * 1000;
/** Consecutive transient failures tolerated before polling stops with a notice. */
const DEFAULT_MAX_POLL_FAILURES = 3;

/** Long-running thresholds, after which the expectation copy changes. */
const SLOW_ANALYSIS_MS = 3 * 60 * 1000;
const VERY_SLOW_ANALYSIS_MS = 5 * 60 * 1000;

/** Findings requested by the ready-state CTA. Free accounts see their top three. */
const FREE_FINDINGS_LIMIT = 3;
const FULL_FINDINGS_LIMIT = 10;

interface Catalog {
  version?: number;
  snp_count?: number;
  snps?: Record<string, unknown>;
  aliases?: Record<string, string[]>;
  reference_alleles?: Record<string, { GRCh37?: string; GRCh38?: string }>;
}

interface ParsedResult {
  supported: boolean;
  snps: Record<string, string>;
  wgsVariantCalls: Record<string, unknown>;
  provider: string;
  providerLabel: string;
  genomeBuild: string | null;
  /**
   * Locally inferred sex-chromosome pattern, sent to the backend as a transient
   * `analysis_context` only when high confidence. Never persisted or echoed.
   */
  sexChromosome: { pattern: string; confidence: string } | null;
  fileName: string;
  fileSizeBytes: number;
  coverage: { matched: number; total: number };
  totalLines: number;
}

/**
 * The stage the card is displaying. Explicit rather than a generic `loading`
 * flag, so the UI always knows which part of the flow it is painting.
 */
type Stage =
  | "loading_catalog"
  | "waiting_for_file"
  | "parsing_file"
  | "review_variants"
  | "submitting_variants"
  | "analysis_processing"
  | "analysis_ready"
  | "analysis_failed";

type LifecycleStatus = "not_started" | "processing" | "ready" | "failed";
type DnaStatus = "missing" | "available" | "unknown";

/**
 * Why the host rendered this component. `regenerate` is an explicit
 * user-selected refresh and always requires resubmitting DNA, so it must open
 * the resubmission flow. Falling back to the ready card would re-offer the same
 * refresh the user just accepted, and every click would loop.
 */
type ImportMode = "initial" | "regenerate" | "overview";

/** What `get_analysis_status` told us about the account. */
interface StatusInfo {
  dnaStatus: DnaStatus;
  analysisStatus: LifecycleStatus | "unknown";
  analysisId: string | null;
  createdAt: string | null;
  planLabel: string | null;
  planSlug: string | null;
  hypothesisScope: string | null;
  upgradeUrl: string | null;
  /** A refreshed analysis is available; current results stay usable unless required. */
  regenerate: boolean;
  /** Resubmission is required (the current analysis is not usable). */
  regenerationRequired: boolean;
  /** Whether the current results remain usable while the refresh is offered. */
  regenerationUsable: boolean;
}

interface AnalysisState {
  id: string | null;
  createdAt: string | null;
  planLabel: string | null;
  planSlug: string | null;
  hypothesisScope: string | null;
  upgradeUrl: string | null;
  regenerate: boolean;
  regenerationRequired: boolean;
  regenerationUsable: boolean;
}

/** A host-rendered follow-up chip from the server's `suggested_prompts`. */
interface PromptChip {
  id: string;
  label: string;
  prompt: string;
}

/** Why polling is not running, when it is not: each is a recoverable notice. */
interface PollState {
  /** The polling ceiling was reached; the analysis may still be processing. */
  exhausted: boolean;
  /** A user-facing message after repeated transient failures. */
  error: string | null;
  /** The grant lacks the scope this check needs, so ChatGPT reports instead. */
  scopeBlocked: boolean;
}

interface Finding {
  id: string | null;
  rank: number;
  title: string;
  summary: string | null;
}

type FindingsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; items: Finding[] }
  | { status: "error"; message: string };

const INITIAL_POLL: PollState = { exhausted: false, error: null, scopeBlocked: false };

/** Host context (theme, styles, display mode) as negotiated during initialize. */
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

/** Stable, user-facing copy for each application-level error code. */
const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Your Mutant connection expired. Reconnect Mutant in ChatGPT and try again.",
  insufficient_scope: "Mutant needs DNA import permission for this. Reconnect Mutant to grant it.",
  catalog_unavailable:
    "Mutant could not prepare the variant catalog. This is usually temporary; try again shortly.",
  invalid_dna_payload: "The processed DNA data could not be accepted.",
  unsupported_format:
    "That file format is not supported. Upload a 23andMe or AncestryDNA .txt file, or a .vcf / .vcf.gz file.",
  unsupported_genome_build:
    "Mutant could not resolve the genome build of that file. Check the VCF header and try again.",
  report_generation_failed: "Mutant could not start your analysis. Please try again.",
  payload_too_large:
    "The processed DNA data is too large to submit in one request. Contact support@mutantbiotech.com.",
  service_unavailable: "Mutant is temporarily unavailable. Please try again in a moment.",
  analysis_failed:
    "Mutant could not finish your analysis. Your DNA file was imported; you can try again.",
  analysis_timeout: "Your analysis is taking longer than expected.",
};

const LOCAL_FILE_TOO_LARGE_MESSAGE =
  "That file is too large to process locally. Select a 23andMe or AncestryDNA export, or a .vcf / .vcf.gz file.";

const UNSUPPORTED_CLIENT_MESSAGE =
  "This browser could not read the file locally. Mutant never uploads your raw DNA, so the import cannot continue here.";

function messageFor(code: string | undefined): string {
  if (!code) return ERROR_MESSAGES.service_unavailable as string;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.service_unavailable!;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** `1:24` - an elapsed timer, never a countdown or a made-up estimate. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Bridge-level failures are diagnostic; user-facing failures come from envelopes. */
function logBridgeError(err: unknown): void {
  if (typeof console === "undefined" || typeof console.debug !== "function") return;
  console.debug("[dna-import] host bridge error", err);
}

/**
 * Classify a recovery state the component derived itself. These codes
 * (`analysis_failed`, `analysis_timeout`) are never shown to the user: they
 * exist so a support engineer can trace what the panel decided from the console
 * without the card exposing backend vocabulary.
 */
function logAnalysisState(code: AppErrorCode, detail?: string): void {
  if (typeof console === "undefined" || typeof console.debug !== "function") return;
  console.debug(`[dna-import] ${code}${detail ? `: ${detail}` : ""}`);
}

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
function chatGptHost(): ChatGptHostApi | null {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { openai?: ChatGptHostApi }).openai;
  return host && typeof host === "object" ? host : null;
}

/** What happened when the component tried to hand a prompt to the host chat. */
type FollowUpOutcome = "sent" | "failed" | "unavailable";

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
const FOLLOW_UP_UNAVAILABLE_MESSAGE =
  "ChatGPT can't send a follow-up message from this panel. Reopen the panel and try again.";
const FOLLOW_UP_FAILED_MESSAGE = "ChatGPT couldn't send that follow-up message. Please try again.";

/**
 * Read the envelope out of a bridge tool result. The structured envelope is
 * authoritative; the text mirror exists only for hosts without structured
 * content, so it is parsed as a fallback.
 */
function envelopeOf(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): ToolResponse | null {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && "ok" in structured) {
    return structured as unknown as ToolResponse;
  }
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as ToolResponse;
  } catch {
    return null;
  }
}

/**
 * Read the selected mode out of a display-tool result. Results without one
 * are ignored, so unrelated tool calls cannot change the component's intent.
 */
function importModeFrom(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  _meta?: unknown;
}): ImportMode | null {
  const envelope = envelopeOf(result);
  const data = envelope ? asRecord(envelope.data) : null;
  const metaMode = asRecord(asRecord(result._meta)?.mutant)?.mode;
  const mode = data?.mode ?? metaMode;
  if (mode === "regenerate" || mode === "initial" || mode === "overview") return mode;
  return null;
}

function toCatalog(response: ToolResponse): Catalog | null {
  const data = response.data;
  if (!data || typeof data !== "object") return null;
  const catalog = data as Catalog;
  if (!catalog.snps || typeof catalog.snps !== "object") return null;
  return catalog;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** First non-empty string among the candidates; null when none is usable. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Collapse the status lifecycle words to the four states the component paints.
 * Anything unrecognized stays `null` so an upstream change cannot make the card
 * claim a state that is not real.
 */
function normalizeStatus(value: unknown): LifecycleStatus | null {
  if (typeof value !== "string") return null;
  if (value === "not_started" || value === "unavailable") return "not_started";
  if (value === "ready" || value === "failed") return value;
  if (
    value === "processing" ||
    value === "queued" ||
    value === "pending" ||
    value === "running" ||
    value === "in_progress"
  ) {
    return "processing";
  }
  return null;
}

/**
 * Read the routing and plan fields out of a `get_analysis_status` envelope. This
 * is the only input to the component's lifecycle: whatever the server says on
 * mount is what lets a rerender (or a reopened panel) resume an existing
 * analysis instead of starting a new one.
 */
function statusOf(envelope: ToolResponse): StatusInfo {
  const data = asRecord(envelope.data) ?? {};
  const analysis = asRecord(data.analysis);
  const entitlement = asRecord(data.entitlement);
  const upgrade = asRecord(data.upgrade);
  const regeneration = asRecord(data.regeneration);

  const analysisStatus = normalizeStatus(data.analysis_status) ?? normalizeStatus(analysis?.status);
  const rawDna = data.dna_status;
  const dnaStatus: DnaStatus =
    rawDna === "missing" || rawDna === "available"
      ? rawDna
      : analysisStatus && analysisStatus !== "not_started"
        ? "available"
        : "unknown";

  return {
    dnaStatus,
    analysisStatus: analysisStatus ?? "unknown",
    analysisId: firstString(data.analysis_id, analysis?.analysis_id, analysis?.id),
    createdAt: firstString(
      data.created_at,
      analysis?.created_at,
      analysis?.started_at,
      analysis?.requested_at,
    ),
    planLabel: firstString(data.plan, entitlement?.plan_label),
    planSlug: firstString(data.plan_slug, entitlement?.plan),
    hypothesisScope: firstString(entitlement?.hypothesis_scope, data.hypothesis_scope),
    upgradeUrl: firstString(upgrade?.url, data.upgrade_url),
    regenerate: data.regenerate === true,
    regenerationRequired: regeneration?.required === true,
    regenerationUsable: regeneration?.current_results_usable !== false,
  };
}

/** Expand the analysis summary from a status payload, keeping what we know. */
function analysisFromStatus(previous: AnalysisState | null, info: StatusInfo): AnalysisState {
  return {
    id: info.analysisId ?? previous?.id ?? null,
    createdAt: info.createdAt ?? previous?.createdAt ?? null,
    planLabel: info.planLabel ?? previous?.planLabel ?? null,
    planSlug: info.planSlug ?? previous?.planSlug ?? null,
    hypothesisScope: info.hypothesisScope ?? previous?.hypothesisScope ?? null,
    upgradeUrl: info.upgradeUrl ?? previous?.upgradeUrl ?? null,
    regenerate: info.regenerate,
    regenerationRequired: info.regenerationRequired,
    regenerationUsable: info.regenerationUsable,
  };
}

/** Free accounts see a fixed top three; Full accounts can see the whole set. */
function isFullAccount(analysis: AnalysisState | null): boolean {
  return analysis?.hypothesisScope === "all" || analysis?.planSlug === "mutant_full";
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
 * Pull the hypothesis summaries out of a `list_health_hypotheses` payload. The
 * shapes are accepted defensively: this renders whatever the backend sends and
 * falls back to the ChatGPT handoff when nothing usable is there.
 */
function findingsFrom(data: unknown): Finding[] {
  const row = asRecord(data);
  const raw = Array.isArray(row?.items)
    ? row.items
    : Array.isArray(row?.hypotheses)
      ? row.hypotheses
      : [];
  const findings: Finding[] = [];
  raw.forEach((entry, index) => {
    const item = asRecord(entry);
    if (!item) return;
    const title = firstString(item.title, item.name);
    if (!title) return;
    const rank = typeof item.rank === "number" ? item.rank : index + 1;
    findings.push({
      id: firstString(item.id, item.hypothesis_id),
      rank,
      title,
      summary: firstString(item.summary, item.description),
    });
  });
  return findings;
}

/** Pull the state-aware suggestion chips out of a context envelope. */
function promptsFrom(data: unknown): PromptChip[] {
  const row = asRecord(data);
  const raw = Array.isArray(row?.suggested_prompts) ? row.suggested_prompts : [];
  const chips: PromptChip[] = [];
  raw.forEach((entry) => {
    const item = asRecord(entry);
    if (!item) return;
    const label = firstString(item.label);
    const prompt = firstString(item.prompt);
    if (!label || !prompt) return;
    chips.push({ id: firstString(item.id) ?? String(chips.length), label, prompt });
  });
  return chips.slice(0, 5);
}

/**
 * Theme-dependent colors. Everything else the component paints comes from host
 * CSS variables applied by `useHostStyles`, with a light-mode fallback. These few
 * literals are exposed as custom properties on the shell so the shared style
 * objects below can stay constant.
 */
interface Palette {
  accent: string;
  accentText: string;
  errorBackground: string;
  errorBorder: string;
  errorText: string;
  dropActive: string;
}

const LIGHT_PALETTE: Palette = {
  accent: "#1f7a3f",
  accentText: "#ffffff",
  errorBackground: "#fdecea",
  errorBorder: "#f5c6cb",
  errorText: "#7f1d1d",
  dropActive: "#f0fff4",
};

const DARK_PALETTE: Palette = {
  accent: "#4ea86e",
  accentText: "#0b1a10",
  errorBackground: "#3a1d1d",
  errorBorder: "#5c2b2b",
  errorText: "#ffb4ab",
  dropActive: "#16301f",
};

function paletteVars(palette: Palette): CSSProperties {
  return {
    "--mutant-accent": palette.accent,
    "--mutant-accent-text": palette.accentText,
    "--mutant-error-bg": palette.errorBackground,
    "--mutant-error-border": palette.errorBorder,
    "--mutant-error-text": palette.errorText,
    "--mutant-drop-active": palette.dropActive,
  } as CSSProperties;
}

const styles = {
  card: {
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--color-text-primary, #1a1a1a)",
    background: "var(--color-background-primary, #ffffff)",
    padding: "20px 22px",
    // Fill the host card instead of centering a fixed column: the component is
    // the whole body of the iframe, so a bounded width would reserve an empty
    // right-hand column the host is not painting anything into.
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    boxSizing: "border-box",
  } as const,
  /**
   * Single full-width column. There is no optional sidebar in this component, so
   * the grid never opens a second (empty) track; `minmax(0, 1fr)` stops a wide
   * child from forcing a horizontal scrollbar.
   */
  main: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    boxSizing: "border-box",
  } as const,
  h1: { fontSize: 17, fontWeight: 600, margin: "0 0 4px" } as const,
  subtitle: { margin: "0 0 16px", color: "var(--color-text-secondary, #5f6368)" } as const,
  dropzone: {
    border: "2px dashed var(--color-border-secondary, #ced4da)",
    borderRadius: 10,
    padding: "26px 20px",
    textAlign: "center",
    background: "var(--color-background-secondary, #fafbfc)",
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    boxSizing: "border-box",
  } as const,
  primaryButton: {
    display: "inline-block",
    background: "var(--mutant-accent, #1f7a3f)",
    color: "var(--mutant-accent-text, #ffffff)",
    border: "none",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  } as const,
  secondaryButton: {
    background: "transparent",
    color: "var(--color-text-secondary, #5f6368)",
    border: "1px solid var(--color-border-secondary, #ced4da)",
    borderRadius: 8,
    padding: "9px 16px",
    fontSize: 14,
    cursor: "pointer",
  } as const,
  subtleButton: {
    background: "transparent",
    color: "var(--color-text-secondary, #5f6368)",
    border: "none",
    padding: "6px 0",
    fontSize: 13,
    textDecoration: "underline",
    cursor: "pointer",
  } as const,
  privacy: {
    background: "var(--color-background-secondary, #f0f9f0)",
    border: "1px solid var(--color-border-secondary, #cdeacd)",
    borderRadius: 8,
    padding: "12px 14px",
    margin: "16px 0",
    fontSize: 13,
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    boxSizing: "border-box",
  } as const,
  notice: {
    background: "var(--color-background-secondary, #f5f7f6)",
    border: "1px solid var(--color-border-secondary, #ced4da)",
    borderRadius: 8,
    padding: "12px 14px",
    margin: "0 0 14px",
    fontSize: 13,
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    boxSizing: "border-box",
  } as const,
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "7px 0",
    borderBottom: "1px solid var(--color-border-secondary, #eceff1)",
  } as const,
  progress: {
    height: 8,
    borderRadius: 4,
    background: "var(--color-background-secondary, #eceff1)",
    overflow: "hidden",
    margin: "12px 0",
  } as const,
  progressBar: {
    height: "100%",
    background: "var(--mutant-accent, #1f7a3f)",
    transition: "width 120ms linear",
  } as const,
  error: {
    background: "var(--mutant-error-bg, #fdecea)",
    border: "1px solid var(--mutant-error-border, #f5c6cb)",
    borderRadius: 8,
    padding: "12px 14px",
    color: "var(--mutant-error-text, #7f1d1d)",
    marginBottom: 14,
    fontSize: 13,
  } as const,
  buttonRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } as const,
  stageList: {
    listStyle: "none",
    margin: "14px 0 10px",
    padding: 0,
    fontSize: 13,
  } as const,
  stageItem: { display: "flex", gap: 8, padding: "3px 0", alignItems: "baseline" } as const,
  stageMarker: { width: 12, color: "var(--mutant-accent, #1f7a3f)" } as const,
  meta: {
    margin: "0 0 12px",
    fontSize: 13,
    color: "var(--color-text-secondary, #5f6368)",
  } as const,
  small: {
    margin: "0 0 12px",
    fontSize: 13,
    color: "var(--color-text-secondary, #5f6368)",
  } as const,
  findingList: { listStyle: "none", margin: "14px 0", padding: 0 } as const,
  finding: {
    border: "1px solid var(--color-border-secondary, #eceff1)",
    borderRadius: 8,
    padding: "10px 12px",
    marginBottom: 8,
  } as const,
  findingTitle: { margin: "0 0 4px", fontSize: 14, fontWeight: 600 } as const,
  findingSummary: {
    margin: "0 0 6px",
    fontSize: 13,
    color: "var(--color-text-secondary, #5f6368)",
  } as const,
  handoffError: {
    margin: "0 0 12px",
    padding: "10px 12px",
    borderRadius: 8,
    background: "var(--mutant-error-bg, #fdecea)",
    border: "1px solid var(--mutant-error-border, #f5c6cb)",
    color: "var(--mutant-error-text, #7f1d1d)",
    fontSize: 13,
  } as const,
  refreshBanner: {
    background: "var(--color-background-secondary, #f5f7f6)",
    border: "1px solid var(--color-border-secondary, #ced4da)",
    borderRadius: 8,
    padding: "12px 14px",
    margin: "0 0 14px",
  } as const,
  chipRow: { display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" } as const,
  chip: {
    background: "transparent",
    color: "var(--mutant-accent, #1f7a3f)",
    border: "1px solid var(--mutant-accent, #1f7a3f)",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  } as const,
};

/** The three broad stages that are always true after `create_report` succeeds. */
const STAGE_STEPS = [
  { label: "DNA file processed", state: "done" },
  { label: "Relevant variants imported", state: "done" },
  { label: "Analyzing genetic patterns and health hypotheses", state: "active" },
] as const;

/**
 * Every state renders inside this shell so the host palette is applied in one
 * place. `useDocumentTheme` reads the `data-theme` attribute (or `dark` class)
 * that `useHostStyles` sets from the host's own theme, so the accent colors
 * follow dark mode without any polling.
 */
function Shell({ children }: { children: ReactNode }) {
  const theme = useDocumentTheme();
  const palette = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  return (
    <div style={{ ...styles.card, ...paletteVars(palette) }}>
      <main style={styles.main}>{children}</main>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <Shell>
      <h1 style={styles.h1}>Mutant Genomics</h1>
      <p style={styles.subtitle}>{label}</p>
    </Shell>
  );
}

interface ErrorPanelProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

function ErrorPanel({ message, onRetry, retryLabel = "Try again" }: ErrorPanelProps) {
  return (
    <div style={styles.error} role="alert">
      <strong>Something went wrong</strong>
      <p style={{ margin: "6px 0 0" }}>{message}</p>
      {onRetry ? (
        <button
          type="button"
          style={{ ...styles.secondaryButton, marginTop: 10 }}
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export interface DnaImportAppProps {
  /** How often the analysis status is polled while processing. */
  pollIntervalMs?: number;
  /** How long polling continues before the recoverable "still working" state. */
  maxPollingMs?: number;
  /** Consecutive transient poll failures tolerated before stopping. */
  maxPollFailures?: number;
  /**
   * Import intent at mount. A host that renders this component from a
   * `show_dna_import` result delivers the mode through the tool-result
   * notification; this prop exposes the same intent for tests and for hosts
   * that mount the component directly.
   */
  mode?: ImportMode;
}

export function DnaImportApp({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollingMs = DEFAULT_MAX_POLLING_MS,
  maxPollFailures = DEFAULT_MAX_POLL_FAILURES,
  mode = "initial",
}: DnaImportAppProps = {}) {
  const [stage, setStage] = useState<Stage>("loading_catalog");
  const [hostContext, setHostContext] = useState<HostContext | undefined>(undefined);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [accountMissing, setAccountMissing] = useState(false);
  const [dnaOnFile, setDnaOnFile] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [poll, setPoll] = useState<PollState>(INITIAL_POLL);
  const [findings, setFindings] = useState<FindingsState>({ status: "idle" });
  /** State-aware follow-up chips from `get_analysis_context`. */
  const [prompts, setPrompts] = useState<PromptChip[]>([]);
  /** Set when a follow-up handoff failed; holds copy, never the prompt itself. */
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  /** Ticks while processing so the elapsed timer advances without polling state. */
  const [now, setNow] = useState(() => Date.now());
  /** Bumped to restart the polling loop after a recoverable stop. */
  const [resumeToken, setResumeToken] = useState(0);
  /**
   * The host-selected import intent. Held in a ref as well as state so the
   * async `loadStatus` callback can read the latest value without a stale
   * closure, and so a late tool result can still redirect the card.
   */
  const [importMode, setImportMode] = useState<ImportMode>(mode);
  const importModeRef = useRef<ImportMode>(mode);
  const selectImportMode = useCallback((next: ImportMode) => {
    importModeRef.current = next;
    setImportMode((current) => (current === next ? current : next));
  }, []);

  const {
    app,
    isConnected,
    error: connectError,
  } = useApp({
    appInfo: { name: "Mutant Genomics", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      created.onerror = logBridgeError;
      // The display tool result tells the component why it was rendered.
      // Register before `connect` so the one-shot notification is not missed.
      created.ontoolresult = (result) => {
        const next = importModeFrom(result);
        if (next) selectImportMode(next);
      };
    },
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** One idempotency key per import attempt, reused across retries of that attempt. */
  const importRequestIdRef = useRef<string | null>(null);
  /**
   * When this analysis started, in epoch ms. Preferred source is the backend's
   * `created_at`; the local timestamp is the fallback when the backend does not
   * send one, and is never persisted across reloads.
   */
  const startedAtRef = useRef<number | null>(null);
  /** End of the current polling window; null until polling starts. */
  const deadlineRef = useRef<number | null>(null);
  /** Read inside the polling loop without making the loop depend on state. */
  const findingsRef = useRef<FindingsState>({ status: "idle" });

  const setFindingsState = useCallback((next: FindingsState) => {
    findingsRef.current = next;
    setFindings(next);
  }, []);

  // Host styling has to be seeded explicitly: the hook applies the host's CSS
  // variables and theme when it is handed a context, and there is no `app` yet
  // when `onAppCreated` runs, so the negotiated context is read after connect.
  useEffect(() => {
    if (!isConnected || !app) return;
    setHostContext(app.getHostContext());
    const onHostContextChanged = (context: HostContext) => {
      setHostContext((previous) => ({ ...previous, ...context }));
    };
    app.addEventListener("hostcontextchanged", onHostContextChanged);
    return () => app.removeEventListener("hostcontextchanged", onHostContextChanged);
  }, [isConnected, app]);

  useHostStyles(app, hostContext);

  const loadCatalog = useCallback(async (client: App) => {
    setCatalogError(null);
    try {
      const result = await client.callServerTool({ name: "get_snp_catalog", arguments: {} });
      const envelope = envelopeOf(result);
      if (result.isError || !envelope || !envelope.ok) {
        setCatalogError(messageFor(envelope?.error?.app_code ?? envelope?.error?.code));
        return;
      }
      const next = toCatalog(envelope);
      if (!next) {
        setCatalogError(messageFor("catalog_unavailable"));
        return;
      }
      setCatalog(next);
    } catch {
      setCatalogError(messageFor("service_unavailable"));
    }
  }, []);

  /**
   * Ask the server where this account stands. This is the component's only
   * source of lifecycle truth, so a rerender or a reopened panel resumes the
   * existing analysis rather than restarting the import (§18).
   *
   * A failure here never blocks the import: at worst the component opens on the
   * file picker and the submit path reports its own errors.
   */
  const loadStatus = useCallback(async (client: App) => {
    try {
      const result = await client.callServerTool({ name: "get_analysis_status", arguments: {} });
      const envelope = envelopeOf(result);
      if (result.isError || !envelope || !envelope.ok) {
        const code = envelope?.error?.code;
        const appCode = envelope?.error?.app_code ?? (code ? appErrorCode(code) : undefined);
        if (code === "AUTHENTICATION_REQUIRED" || code === "ACCOUNT_NOT_AVAILABLE") {
          setAccountMissing(true);
        } else if (appCode === "insufficient_scope") {
          // A dna.import-only grant can submit but cannot read status, so the
          // card explains that ChatGPT reports completion instead.
          setPoll((previous) => ({ ...previous, scopeBlocked: true }));
        }
        setStage("waiting_for_file");
        return;
      }

      const info = statusOf(envelope);
      setAnalysis((previous) => analysisFromStatus(previous, info));
      if (info.createdAt) {
        const startedAt = Date.parse(info.createdAt);
        if (Number.isFinite(startedAt)) startedAtRef.current = startedAt;
      }

      if (info.analysisStatus === "processing") {
        if (startedAtRef.current === null) startedAtRef.current = Date.now();
        setNow(Date.now());
        setStage("analysis_processing");
        return;
      }
      if (info.analysisStatus === "ready") {
        // A user-selected refresh must not bounce back to the ready card: the
        // banner would re-offer the same refresh and loop. Send the user to the
        // resubmission flow instead.
        if (importModeRef.current === "regenerate") {
          setDnaOnFile(true);
          setStage("waiting_for_file");
          return;
        }
        setStage("analysis_ready");
        return;
      }
      if (info.analysisStatus === "failed") {
        logAnalysisState("analysis_failed", "status reported failed on mount");
        setStage("analysis_failed");
        return;
      }
      setDnaOnFile(info.dnaStatus === "available");
      setStage("waiting_for_file");
    } catch (err) {
      logBridgeError(err);
      setStage("waiting_for_file");
    }
  }, []);

  // Exactly one automatic load per mount. Keying this off `catalogError` would
  // re-fire when the retry clears the error, double-fetching the catalog.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!isConnected || !app || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void loadCatalog(app);
    void loadStatus(app);
  }, [isConnected, app, loadCatalog, loadStatus]);

  // A refresh selected after mount (the host pushes the `show_dna_import`
  // result to the running view) must still leave the ready screen. Otherwise
  // the refresh banner re-renders unchanged and the next click repeats it.
  useEffect(() => {
    if (importMode !== "regenerate") return;
    setStage((current) =>
      current === "loading_catalog" || current === "analysis_ready" ? "waiting_for_file" : current,
    );
  }, [importMode]);

  /** Tell the model the component owns this state, so it does not narrate it. */
  const reportToModel = useCallback(
    (text: string) => {
      if (!app) return;
      void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
    },
    [app],
  );

  const resetImport = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    importRequestIdRef.current = null;
    startedAtRef.current = null;
    deadlineRef.current = null;
    setParsed(null);
    setUploadError(null);
    setProgress(0);
    setPoll(INITIAL_POLL);
    setFindingsState({ status: "idle" });
    setStage("waiting_for_file");
  }, [setFindingsState]);

  const openFilePicker = useCallback(() => {
    resetImport();
    const input = fileInputRef.current;
    if (!input) return;
    try {
      input.value = "";
    } catch {
      // Some hosts deny writes to the input; selecting the same file still fires.
    }
    input.click();
  }, [resetImport]);

  /**
   * Stop an in-flight parse.
   *
   * The idle state is restored here rather than waiting for the parse to unwind:
   * a worker-based parse settles promptly on abort (the worker is terminated),
   * but a main-thread parse only notices the signal between chunks, so a stalled
   * read could otherwise leave the panel stuck on the progress screen.
   */
  const cancelParse = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(0);
    setStage("waiting_for_file");
  }, []);

  const handleFile = useCallback(
    async (file: File | null | undefined, client: App, activeCatalog: Catalog) => {
      if (!file) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setUploadError(null);
      setParsed(null);
      setProgress(0);

      if (file.size > MAX_LOCAL_FILE_BYTES) {
        setUploadError(LOCAL_FILE_TOO_LARGE_MESSAGE);
        setStage("waiting_for_file");
        return;
      }

      setStage("parsing_file");
      // A new file starts a new import attempt, so it gets a fresh idempotency key.
      importRequestIdRef.current = crypto.randomUUID();

      try {
        const result = (await parseDnaFile(file, {
          catalog: activeCatalog,
          signal: controller.signal,
          onProgress: setProgress,
        })) as ParsedResult;

        if (controller.signal.aborted) return;

        if (!result.supported) {
          setUploadError(UNSUPPORTED_CLIENT_MESSAGE);
          setStage("waiting_for_file");
          return;
        }

        const matched = result.coverage.matched;
        if (!matched) {
          setUploadError(
            `Your ${result.providerLabel} file was read successfully but contained none of the variants in the Mutant panel. Check that you selected a raw DNA data file rather than a report or summary.`,
          );
          setStage("waiting_for_file");
          return;
        }
        if (matched > MAX_SNP_ENTRIES) {
          setUploadError(messageFor("payload_too_large"));
          setStage("waiting_for_file");
          return;
        }

        setParsed(result);
        setStage("review_variants");
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setUploadError(messageFor("invalid_dna_payload"));
        setStage("waiting_for_file");
      } finally {
        // Only the attempt that still owns the ref may clear the abort state: a
        // cancelled or superseded attempt must not disturb the current one.
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [],
  );

  const submit = useCallback(
    async (client: App) => {
      if (!parsed) return;
      const importRequestId = importRequestIdRef.current ?? crypto.randomUUID();
      importRequestIdRef.current = importRequestId;

      setStage("submitting_variants");
      setUploadError(null);

      const args: Record<string, unknown> = {
        snps: parsed.snps,
        upload_meta: {
          provider: parsed.provider,
          file_name: parsed.fileName,
          file_size_bytes: parsed.fileSizeBytes,
        },
        import_request_id: importRequestId,
      };
      if (Object.keys(parsed.wgsVariantCalls).length) {
        args.wgs_variant_calls = parsed.wgsVariantCalls;
      }
      // Request-only context: only a high-confidence XX/XY detection is sent, so
      // sex-specific storm conditions can be evaluated in memory. The backend
      // never stores, logs, or returns it.
      if (
        parsed.sexChromosome &&
        parsed.sexChromosome.confidence === "high" &&
        (parsed.sexChromosome.pattern === "XX" || parsed.sexChromosome.pattern === "XY")
      ) {
        args.analysis_context = {
          sex_chromosome_pattern: parsed.sexChromosome.pattern,
          sex_chromosome_confidence: "high",
        };
      }

      try {
        const result = await client.callServerTool({ name: "create_report", arguments: args });
        const envelope = envelopeOf(result);
        if (result.isError || !envelope || !envelope.ok) {
          setUploadError(
            messageFor(
              envelope?.error?.app_code ??
                (envelope?.error?.code ? appErrorCode(envelope.error.code) : undefined),
            ),
          );
          // The review screen survives so the same file can be resubmitted.
          setStage("review_variants");
          return;
        }

        const data = (envelope.data ?? {}) as { analysis_id?: string; status?: string };
        const submittedStatus = normalizeStatus(data.status);
        // The local clock is the fallback; the first poll replaces it with the
        // backend's `created_at` when one is available (§11).
        startedAtRef.current = Date.now();
        deadlineRef.current = Date.now() + maxPollingMs;
        setNow(Date.now());
        // `scopeBlocked` survives a submit: it describes the grant, not the
        // attempt, so a dna.import-only connection stays on the ChatGPT hint.
        setPoll((previous) => ({ ...INITIAL_POLL, scopeBlocked: previous.scopeBlocked }));
        setFindingsState({ status: "idle" });
        setAnalysis((previous) => ({
          ...(previous ?? {
            planLabel: null,
            planSlug: null,
            hypothesisScope: null,
            upgradeUrl: null,
            regenerate: false,
            regenerationRequired: false,
            regenerationUsable: true,
          }),
          id: data.analysis_id ?? null,
          createdAt: null,
        }));

        if (submittedStatus === "ready") {
          setStage("analysis_ready");
        } else if (submittedStatus === "failed") {
          logAnalysisState("analysis_failed", "create_report returned failed");
          setStage("analysis_failed");
        } else {
          setStage("analysis_processing");
          reportToModel(
            "The user's DNA was imported from the Mutant DNA import component and an analysis is " +
              "being generated. The component polls the status and shows progress and completion " +
              "itself: do not restate DNA or analysis status.",
          );
        }
      } catch {
        setUploadError(messageFor("service_unavailable"));
        setStage("review_variants");
      }
    },
    [parsed, maxPollingMs, reportToModel, setFindingsState],
  );

  // Poll `get_analysis_status` until the analysis is terminal, the ceiling is
  // reached, the grant cannot read status, or the component unmounts. The loop
  // is self-scheduling (`setTimeout` per tick) so the interval is measured from
  // each response rather than from the moment polling started.
  useEffect(() => {
    if (stage !== "analysis_processing" || !app) return;
    if (poll.exhausted || poll.scopeBlocked) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    if (deadlineRef.current === null) deadlineRef.current = Date.now() + maxPollingMs;

    const sleep = () =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollIntervalMs);
      });

    void (async () => {
      while (!cancelled) {
        await sleep();
        if (cancelled) return;

        if (Date.now() > (deadlineRef.current ?? 0)) {
          logAnalysisState("analysis_timeout", "polling ceiling reached");
          setPoll((previous) => ({ ...previous, exhausted: true }));
          return;
        }

        let result;
        try {
          result = await app.callServerTool({ name: "get_analysis_status", arguments: {} });
        } catch (err) {
          logBridgeError(err);
          failures += 1;
          if (failures >= maxPollFailures) {
            setPoll((previous) => ({
              ...previous,
              error: messageFor("service_unavailable"),
            }));
            return;
          }
          continue;
        }
        if (cancelled) return;

        const envelope = envelopeOf(result);
        if (result.isError || !envelope || !envelope.ok) {
          const code = envelope?.error?.code;
          const appCode = envelope?.error?.app_code ?? (code ? appErrorCode(code) : undefined);
          if (appCode === "insufficient_scope" || appCode === "unauthorized") {
            setPoll((previous) => ({ ...previous, scopeBlocked: true }));
            return;
          }
          failures += 1;
          if (failures >= maxPollFailures) {
            setPoll((previous) => ({ ...previous, error: messageFor(appCode) }));
            return;
          }
          continue;
        }

        failures = 0;
        const info = statusOf(envelope);
        if (info.createdAt) {
          const startedAt = Date.parse(info.createdAt);
          if (Number.isFinite(startedAt)) startedAtRef.current = startedAt;
        }
        setAnalysis((previous) => analysisFromStatus(previous, info));

        if (info.analysisStatus === "ready") {
          setStage("analysis_ready");
          reportToModel(
            "The Mutant analysis is ready and the DNA import component is showing the completion " +
              "card. Do not restate the analysis status; wait for the user to ask about their " +
              "results.",
          );
          return;
        }
        if (info.analysisStatus === "failed") {
          logAnalysisState("analysis_failed", "status reported failed");
          setStage("analysis_failed");
          return;
        }
        // Any other state (including a transient `not_started`) still means the
        // analysis has not arrived, so polling continues.
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    stage,
    app,
    poll.exhausted,
    poll.scopeBlocked,
    pollIntervalMs,
    maxPollingMs,
    maxPollFailures,
    resumeToken,
    reportToModel,
  ]);

  // One tick per second while processing drives the elapsed timer.
  useEffect(() => {
    if (stage !== "analysis_processing") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const startedAt = startedAtRef.current;
  const elapsedMs = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const isFull = isFullAccount(analysis);
  const upgradeUrl = isFull ? null : safeUpgradeUrl(analysis?.upgradeUrl ?? null);

  /** Resume polling after the ceiling or a run of transient failures. */
  const checkAgain = useCallback(() => {
    deadlineRef.current = Date.now() + maxPollingMs;
    setNow(Date.now());
    setPoll(INITIAL_POLL);
    setResumeToken((token) => token + 1);
  }, [maxPollingMs]);

  /** Re-submit the variants still in memory; a resumed session has none. */
  const tryAgain = useCallback(() => {
    if (!parsed || !app) {
      openFilePicker();
      return;
    }
    // A new attempt gets a fresh idempotency key: the previous analysis failed,
    // so the new one must not be deduplicated onto it.
    importRequestIdRef.current = crypto.randomUUID();
    void submit(app);
  }, [app, openFilePicker, parsed, submit]);

  const loadPromptChips = useCallback(async () => {
    if (!app) return;
    try {
      const result = await app.callServerTool({ name: "get_analysis_context", arguments: {} });
      const envelope = envelopeOf(result);
      if (result.isError || !envelope || !envelope.ok) return;
      setPrompts(promptsFrom(envelope.data));
      const upgrade = asRecord(asRecord(envelope.data)?.upgrade);
      const url = safeUpgradeUrl(firstString(upgrade?.url));
      if (url) {
        setAnalysis((previous) => (previous ? { ...previous, upgradeUrl: url } : previous));
      }
    } catch {
      // Chips are an enhancement; a failure must not disturb the findings card.
    }
  }, [app]);

  const loadFindings = useCallback(async () => {
    if (!app) return;
    if (findingsRef.current.status === "loading" || findingsRef.current.status === "loaded") return;
    setFindingsState({ status: "loading" });
    try {
      const result = await app.callServerTool({
        name: "list_health_hypotheses",
        arguments: { limit: isFull ? FULL_FINDINGS_LIMIT : FREE_FINDINGS_LIMIT },
      });
      const envelope = envelopeOf(result);
      if (result.isError || !envelope || !envelope.ok) {
        setFindingsState({
          status: "error",
          message: messageFor(envelope?.error?.app_code ?? envelope?.error?.code),
        });
        return;
      }
      const items = findingsFrom(envelope.data);
      if (!items.length) {
        setFindingsState({
          status: "error",
          message: "Mutant did not return any findings for this analysis yet.",
        });
        return;
      }
      setFindingsState({ status: "loaded", items });
      void loadPromptChips();
    } catch {
      setFindingsState({ status: "error", message: messageFor("service_unavailable") });
    }
  }, [app, isFull, loadPromptChips, setFindingsState]);

  // The overview route opens directly on its findings and follow-up hints.
  useEffect(() => {
    if (stage === "analysis_ready" && importMode === "overview") void loadFindings();
  }, [stage, importMode, loadFindings]);

  /**
   * Hand control back to ChatGPT only when the user asks for interpretation.
   *
   * The prompt goes to the host chat API; it is never appended to the card. If
   * no host API is available (or the host rejects it) the user sees an error.
   */
  const askChatGpt = useCallback(
    async (text: string) => {
      setHandoffError(null);
      const outcome = await deliverFollowUp(app, text);
      if (outcome === "unavailable") setHandoffError(FOLLOW_UP_UNAVAILABLE_MESSAGE);
      else if (outcome === "failed") setHandoffError(FOLLOW_UP_FAILED_MESSAGE);
    },
    [app],
  );

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (!app || !catalog) return;
      const file = event.dataTransfer?.files?.[0];
      void handleFile(file, app, catalog);
    },
    [app, catalog, handleFile],
  );

  const totalMarkers = useMemo(() => {
    if (!catalog) return null;
    if (typeof catalog.snp_count === "number") return catalog.snp_count;
    return catalog.snps ? Object.keys(catalog.snps).length : null;
  }, [catalog]);

  if (connectError) {
    return (
      <Shell>
        <ErrorPanel message="Mutant could not connect to ChatGPT. Reopen this panel and try again." />
      </Shell>
    );
  }
  if (!isConnected || !app) {
    return <Loading label="Connecting to Mutant…" />;
  }
  if (stage === "loading_catalog") {
    return <Loading label="Preparing DNA import…" />;
  }

  /**
   * The picker input is rendered by every card that offers a way back to the file
   * dialog, so `openFilePicker` always finds it already mounted: the click has to
   * happen in the same tick as the ref read, before React swaps the card.
   */
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".txt,.vcf,.gz,.bgz"
      style={{ display: "none" }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file || !catalog) return;
        void handleFile(file, app, catalog);
      }}
    />
  );

  if (stage === "analysis_processing") {
    const slow = elapsedMs >= SLOW_ANALYSIS_MS;
    const verySlow = elapsedMs >= VERY_SLOW_ANALYSIS_MS;
    return (
      <Shell>
        <h1 style={styles.h1}>Generating your analysis</h1>
        <p style={styles.subtitle}>Your DNA was imported successfully.</p>
        <p style={styles.meta}>We're generating your analysis now.</p>
        <ul style={styles.stageList}>
          {STAGE_STEPS.map((step) => (
            <li key={step.label} style={styles.stageItem}>
              <span style={styles.stageMarker} aria-hidden="true">
                {step.state === "done" ? "✓" : "●"}
              </span>
              <span>{step.label}</span>
            </li>
          ))}
        </ul>

        {poll.exhausted ? (
          <>
            <p style={styles.meta}>
              Your analysis is still processing. You can leave this conversation and return later.
              Your DNA has already been imported successfully.
            </p>
            <p style={styles.small}>
              Mutant stopped checking automatically. Check again to keep watching.
            </p>
          </>
        ) : poll.error ? (
          <p style={styles.meta}>{poll.error}</p>
        ) : poll.scopeBlocked ? (
          <p style={styles.meta}>
            Ask ChatGPT when your analysis is ready; this panel cannot check the status on its own.
          </p>
        ) : (
          <>
            {verySlow ? (
              <p style={styles.meta}>
                Your analysis is still processing. You can leave this conversation and return later.
                Your DNA has already been imported successfully.
              </p>
            ) : slow ? (
              <p style={styles.meta}>
                Still working on your analysis. Some files take a little longer to process.
              </p>
            ) : (
              <p style={styles.meta}>This usually takes about 2–3 minutes.</p>
            )}
            <p style={styles.small}>Elapsed: {formatElapsed(elapsedMs)}</p>
          </>
        )}

        {poll.exhausted || poll.error || poll.scopeBlocked ? (
          <div style={styles.buttonRow}>
            <button type="button" style={styles.secondaryButton} onClick={checkAgain}>
              {poll.scopeBlocked ? "Check status" : "Check again"}
            </button>
          </div>
        ) : null}
      </Shell>
    );
  }

  if (stage === "analysis_ready") {
    const loaded = findings.status === "loaded" ? findings.items : null;
    return (
      <Shell>
        <h1 style={styles.h1}>Analysis ready</h1>
        <p style={styles.subtitle}>Your DNA analysis is complete.</p>

        {analysis?.regenerate ? (
          <div style={styles.refreshBanner} role="status">
            <p style={{ ...styles.meta, margin: "0 0 8px" }}>
              {analysis.regenerationRequired
                ? "A refreshed analysis is needed to include the newer patterns. Resubmit your DNA to refresh it."
                : "A newer analysis platform is available. Your current results are still usable, and refreshing is optional."}
            </p>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => {
                selectImportMode("regenerate");
                setDnaOnFile(true);
                setStage("waiting_for_file");
              }}
            >
              Refresh analysis
            </button>
          </div>
        ) : null}

        {loaded ? (
          <ol style={styles.findingList}>
            {loaded.map((finding) => (
              <li key={`${finding.rank}-${finding.title}`} style={styles.finding}>
                <p style={styles.findingTitle}>
                  {finding.rank}. {finding.title}
                </p>
                {finding.summary ? <p style={styles.findingSummary}>{finding.summary}</p> : null}
                <button
                  type="button"
                  style={styles.subtleButton}
                  onClick={() =>
                    void askChatGpt(
                      `Explain my "${finding.title}" finding from my Mutant analysis in useful detail. Retrieve the full finding details first. Cover what it means, why it ranked where it did, the main module and pattern evidence, what is provisional or uncertain, what would strengthen or weaken it, and the specific confirmation options returned for this finding. Use clear headings and distinguish my genetic results from symptoms or test results I have not shared.`,
                    )
                  }
                >
                  Explain this finding
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p style={styles.meta}>
            {isFull
              ? "Every analyzed health hypothesis is included with Mutant Full."
              : "Your top 3 ranked health hypotheses are included with Mutant Free. Mutant Full unlocks every analyzed hypothesis."}
          </p>
        )}

        {findings.status === "error" ? <ErrorPanel message={findings.message} /> : null}

        {loaded ? null : (
          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => void loadFindings()}
              disabled={findings.status === "loading"}
            >
              {findings.status === "loading"
                ? "Loading your findings…"
                : isFull
                  ? "View my findings"
                  : "View my top 3 findings"}
            </button>
          </div>
        )}

        {handoffError ? (
          <p role="alert" style={styles.handoffError}>
            {handoffError}
          </p>
        ) : null}

        {prompts.length > 0 ? (
          <div style={styles.chipRow}>
            {prompts.map((chip) => (
              <button
                key={chip.id}
                type="button"
                style={styles.chip}
                onClick={() => void askChatGpt(chip.prompt)}
              >
                {chip.label}
              </button>
            ))}
          </div>
        ) : null}

        <div style={{ ...styles.buttonRow, marginTop: 14 }}>
          {loaded ? (
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => void askChatGpt("Ask ChatGPT about my Mutant results.")}
            >
              Ask ChatGPT about my results
            </button>
          ) : null}
          <button type="button" style={styles.subtleButton} onClick={openFilePicker}>
            Replace DNA data
          </button>
        </div>
        {upgradeUrl ? (
          <div style={{ marginTop: 12 }}>
            <a
              href={upgradeUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.subtleButton}
              onClick={(event) => {
                if (!app) return;
                event.preventDefault();
                void app.openLink({ url: upgradeUrl }).then(
                  (result) => {
                    if (result.isError) setHandoffError("The upgrade page could not be opened.");
                  },
                  () => setHandoffError("The upgrade page could not be opened."),
                );
              }}
            >
              Upgrade to Mutant Full
            </a>
          </div>
        ) : null}
        {fileInput}
      </Shell>
    );
  }

  if (stage === "analysis_failed") {
    return (
      <Shell>
        <h1 style={styles.h1}>Analysis couldn't be completed</h1>
        <p style={styles.subtitle}>We couldn't complete your analysis.</p>
        <p style={styles.meta}>
          Your DNA file was imported, but analysis generation did not finish successfully.
        </p>
        <div style={styles.buttonRow}>
          <button type="button" style={styles.primaryButton} onClick={tryAgain}>
            Try again
          </button>
          <button type="button" style={styles.secondaryButton} onClick={openFilePicker}>
            Replace DNA data
          </button>
        </div>
        {fileInput}
      </Shell>
    );
  }

  if (catalogError) {
    return (
      <Shell>
        <ErrorPanel message={catalogError} onRetry={() => void loadCatalog(app)} />
      </Shell>
    );
  }
  if (!catalog) {
    return <Loading label="Preparing DNA import…" />;
  }

  if (stage === "submitting_variants") {
    return (
      <Shell>
        <h1 style={styles.h1}>DNA processed</h1>
        <p style={styles.subtitle}>Creating your analysis…</p>
        {parsed ? (
          <div style={{ marginBottom: 16 }}>
            <div style={styles.summaryRow}>
              <span>Relevant variants found</span>
              <strong>{formatCount(parsed.coverage.matched)}</strong>
            </div>
            {parsed.genomeBuild ? (
              <div style={{ ...styles.summaryRow, borderBottom: "none" }}>
                <span>Genome build</span>
                <strong>{parsed.genomeBuild}</strong>
              </div>
            ) : null}
          </div>
        ) : null}
        <p style={styles.small}>
          Your raw DNA file stayed on your device; only variants used by Mutant were submitted.
        </p>
      </Shell>
    );
  }

  if (stage === "parsing_file") {
    return (
      <Shell>
        <h1 style={styles.h1}>Reading DNA file…</h1>
        <div style={styles.progress}>
          <div style={{ ...styles.progressBar, width: `${progress}%` }} />
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--color-text-secondary, #5f6368)" }}>
          <li>Detecting file format</li>
          <li>Detecting genome build</li>
          <li>Finding Mutant variants</li>
        </ul>
        <p style={{ marginTop: 12, fontSize: 13, color: "var(--color-text-secondary, #5f6368)" }}>
          Your raw DNA file is processed locally. Only variants used by Mutant are submitted.
        </p>
        <button type="button" style={styles.secondaryButton} onClick={cancelParse}>
          Cancel
        </button>
      </Shell>
    );
  }

  if (stage === "review_variants" && parsed) {
    return (
      <Shell>
        <h1 style={styles.h1}>Ready to submit</h1>
        <p style={styles.subtitle}>
          Review what will be sent to Mutant. Your raw DNA file is not uploaded.
        </p>
        {uploadError ? <ErrorPanel message={uploadError} /> : null}
        <div style={{ marginBottom: 16 }}>
          <div style={styles.summaryRow}>
            <span>Source</span>
            <strong>{parsed.providerLabel}</strong>
          </div>
          {parsed.genomeBuild ? (
            <div style={styles.summaryRow}>
              <span>Genome build</span>
              <strong>{parsed.genomeBuild}</strong>
            </div>
          ) : null}
          {parsed.sexChromosome && parsed.sexChromosome.confidence === "high" ? (
            <div style={styles.summaryRow}>
              <span>Sex-chromosome context</span>
              <strong>
                {parsed.sexChromosome.pattern} · used for sex-specific rules only, not stored
              </strong>
            </div>
          ) : null}
        </div>
        <div style={styles.buttonRow}>
          <button type="button" style={styles.primaryButton} onClick={() => void submit(app)}>
            Create my Mutant analysis
          </button>
          <button type="button" style={styles.secondaryButton} onClick={openFilePicker}>
            Choose a different file
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={styles.h1}>
        {importMode === "regenerate" ? "Refresh your analysis" : "Add your DNA data"}
      </h1>

      {importMode === "regenerate" && !accountMissing ? (
        <div style={styles.notice} role="status">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Resubmit your DNA to refresh</p>
          <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
            Mutant cannot rescore a stored file, so submit your DNA again to include the newer
            patterns. Your current results stay available until the refreshed analysis is ready.
          </p>
        </div>
      ) : null}

      {accountMissing ? (
        <div style={styles.notice} role="status">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Connect your Mutant account first</p>
          <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
            Your Mutant account is not linked yet. Reconnect Mutant in ChatGPT, then reopen this
            panel to add DNA data.
          </p>
        </div>
      ) : null}

      {dnaOnFile && !accountMissing && importMode !== "regenerate" ? (
        <div style={styles.notice} role="status">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>DNA data is already on file</p>
          <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
            You can ask ChatGPT about your Mutant analysis. Importing another file replaces it.
          </p>
        </div>
      ) : null}

      {uploadError ? <ErrorPanel message={uploadError} onRetry={openFilePicker} /> : null}

      {accountMissing ? null : (
        <div
          style={{
            ...styles.dropzone,
            borderColor: isDragging
              ? "var(--mutant-accent, #1f7a3f)"
              : "var(--color-border-secondary, #ced4da)",
            background: isDragging
              ? "var(--mutant-drop-active, #f0fff4)"
              : "var(--color-background-secondary, #fafbfc)",
          }}
          onDrop={onDrop}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
        >
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Drag and drop your DNA file here</p>
          <p
            style={{
              margin: "0 0 16px",
              fontSize: 13,
              color: "var(--color-text-secondary, #5f6368)",
            }}
          >
            Accepted formats: .txt (23andMe, AncestryDNA), .vcf, and .vcf.gz
          </p>
          <button type="button" style={styles.primaryButton} onClick={openFilePicker}>
            Choose DNA file
          </button>
        </div>
      )}

      <div style={styles.privacy}>
        <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
          Your raw DNA file is processed locally.
        </p>
        <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
          Only variants used by Mutant are submitted
          {totalMarkers ? ` (${formatCount(totalMarkers)} markers in the Mutant panel)` : ""}. Your
          file is never uploaded or stored by Mutant.
        </p>
      </div>

      <p style={styles.meta}>Generating your analysis usually takes about 2–3 minutes.</p>

      {fileInput}
    </Shell>
  );
}

/**
 * Mutant DNA import - Apps SDK component.
 *
 * Renders the DNA upload experience inside ChatGPT. The raw file is read here,
 * in the sandboxed app iframe, and never leaves it: the component uploads no
 * bytes and makes no direct network request. It talks to the Mutant MCP server
 * only through the host bridge (`app.callServerTool`):
 *
 *   get_snp_catalog -> parse the raw file locally -> create_report
 *
 * so the only thing that crosses the boundary is the normalized subset of
 * Mutant-relevant variants.
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
import { appErrorCode, type ErrorCodeValue, type ToolResponse } from "../../contract";
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
  fileName: string;
  fileSizeBytes: number;
  coverage: { matched: number; total: number };
  totalLines: number;
}

interface SubmitOutcome {
  analysisId: string | null;
  status: string | null;
}

/** Routing state the host passed to `show_dna_import`, read off its tool result. */
interface ImportContext {
  accountStatus: string | null;
  dnaStatus: string | null;
}

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

/** Bridge-level failures are diagnostic; user-facing failures come from envelopes. */
function logBridgeError(err: unknown): void {
  if (typeof console === "undefined" || typeof console.debug !== "function") return;
  console.debug("[dna-import] host bridge error", err);
}

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

function toCatalog(response: ToolResponse): Catalog | null {
  const data = response.data;
  if (!data || typeof data !== "object") return null;
  const catalog = data as Catalog;
  if (!catalog.snps || typeof catalog.snps !== "object") return null;
  return catalog;
}

/**
 * Extract the `show_dna_import` routing state from a tool result, or null for
 * any other result the host forwards to this component.
 *
 * The component is mounted by `show_dna_import`, so the enclosing tool result is
 * the only one that describes which state to open in. The tool reports the
 * precondition it was called under rather than a fresh backend read, so this is
 * used to set expectations, never to block an upload.
 */
function importContextOf(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): ImportContext | null {
  const data = envelopeOf(result)?.data;
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const accountStatus = typeof row.account_status === "string" ? row.account_status : null;
  const dnaStatus = typeof row.dna_status === "string" ? row.dna_status : null;
  if (!accountStatus && !dnaStatus) return null;
  return { accountStatus, dnaStatus };
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
    maxWidth: 520,
  } as const,
  h1: { fontSize: 17, fontWeight: 600, margin: "0 0 4px" } as const,
  subtitle: { margin: "0 0 16px", color: "var(--color-text-secondary, #5f6368)" } as const,
  dropzone: {
    border: "2px dashed var(--color-border-secondary, #ced4da)",
    borderRadius: 10,
    padding: "26px 20px",
    textAlign: "center",
    background: "var(--color-background-secondary, #fafbfc)",
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
  privacy: {
    background: "var(--color-background-secondary, #f0f9f0)",
    border: "1px solid var(--color-border-secondary, #cdeacd)",
    borderRadius: 8,
    padding: "12px 14px",
    margin: "16px 0",
    fontSize: 13,
  } as const,
  notice: {
    background: "var(--color-background-secondary, #f5f7f6)",
    border: "1px solid var(--color-border-secondary, #ced4da)",
    borderRadius: 8,
    padding: "12px 14px",
    margin: "0 0 14px",
    fontSize: 13,
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
};

/**
 * Every state renders inside this shell so the host palette is applied in one
 * place. `useDocumentTheme` reads the `data-theme` attribute (or `dark` class)
 * that `useHostStyles` sets from the host's own theme, so the accent colors
 * follow dark mode without any polling.
 */
function Shell({ children }: { children: ReactNode }) {
  const theme = useDocumentTheme();
  const palette = theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  return <div style={{ ...styles.card, ...paletteVars(palette) }}>{children}</div>;
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

export function DnaImportApp() {
  const [importContext, setImportContext] = useState<ImportContext | null>(null);
  const [hostContext, setHostContext] = useState<HostContext | undefined>(undefined);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<null | "parsing" | "submitting">(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const {
    app,
    isConnected,
    error: connectError,
  } = useApp({
    appInfo: { name: "Mutant DNA Import", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (created) => {
      // The host mounts this component because of show_dna_import, so its result
      // carries the account/DNA state to open in. Results for any other tool are
      // ignored rather than misread.
      created.ontoolresult = (result) => {
        const context = importContextOf(result);
        if (context) setImportContext(context);
      };
      created.onerror = logBridgeError;
    },
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** One idempotency key per import attempt, reused across retries of that attempt. */
  const importRequestIdRef = useRef<string | null>(null);

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

  // Exactly one automatic load per mount. Keying this off `catalogError` would
  // re-fire when the retry clears the error, double-fetching the catalog.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!isConnected || !app || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void loadCatalog(app);
  }, [isConnected, app, loadCatalog]);

  const resetImport = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    importRequestIdRef.current = null;
    setParsed(null);
    setUploadError(null);
    setOutcome(null);
    setProgress(0);
    setBusy(null);
  }, []);

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
    setBusy(null);
  }, []);

  const handleFile = useCallback(
    async (file: File | null | undefined, client: App, activeCatalog: Catalog) => {
      if (!file) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setUploadError(null);
      setParsed(null);
      setOutcome(null);
      setProgress(0);

      if (file.size > MAX_LOCAL_FILE_BYTES) {
        setUploadError(LOCAL_FILE_TOO_LARGE_MESSAGE);
        return;
      }

      setBusy("parsing");
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
          return;
        }

        const matched = result.coverage.matched;
        if (!matched) {
          setUploadError(
            `Your ${result.providerLabel} file was read successfully but contained none of the variants in the Mutant panel. Check that you selected a raw DNA data file rather than a report or summary.`,
          );
          return;
        }
        if (matched > MAX_SNP_ENTRIES) {
          setUploadError(messageFor("payload_too_large"));
          return;
        }

        setParsed(result);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setUploadError(messageFor("invalid_dna_payload"));
      } finally {
        // Only the attempt that still owns the ref may clear the busy state: a
        // cancelled or superseded attempt must not disturb the current one.
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(null);
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

      setBusy("submitting");
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

      try {
        const result = await client.callServerTool({ name: "create_report", arguments: args });
        const envelope = envelopeOf(result);
        if (result.isError || !envelope || !envelope.ok) {
          setUploadError(
            messageFor(
              (envelope?.error?.app_code ??
                (envelope?.error?.code ? appErrorCode(envelope.error.code) : undefined)) as
                ErrorCodeValue | undefined,
            ),
          );
          return;
        }
        const data = (envelope.data ?? {}) as { analysis_id?: string; status?: string };
        setOutcome({ analysisId: data.analysis_id ?? null, status: data.status ?? null });

        // Let the model know the analysis now exists so it can continue with the
        // analysis tools. Best-effort: never fail the import over this.
        void client
          .updateModelContext({
            content: [
              {
                type: "text",
                text: "The user's DNA has been imported and a Mutant analysis is being generated. You can now continue with the Mutant analysis tools.",
              },
            ],
          })
          .catch(() => undefined);
      } catch {
        setUploadError(messageFor("service_unavailable"));
      } finally {
        setBusy(null);
      }
    },
    [parsed],
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

  if (outcome) {
    return (
      <Shell>
        <h1 style={styles.h1}>DNA data added</h1>
        <p style={styles.subtitle}>Your Mutant analysis is being generated.</p>
        {outcome.analysisId || outcome.status ? (
          <div style={{ marginTop: 8 }}>
            {outcome.status ? (
              <div style={styles.summaryRow}>
                <span>Status</span>
                <strong>{outcome.status}</strong>
              </div>
            ) : null}
            {outcome.analysisId ? (
              <div style={{ ...styles.summaryRow, borderBottom: "none" }}>
                <span>Analysis</span>
                <strong>{outcome.analysisId}</strong>
              </div>
            ) : null}
          </div>
        ) : null}
        <p style={{ margin: "16px 0", color: "var(--color-text-secondary, #5f6368)" }}>
          You can now ask ChatGPT about your Mutant analysis.
        </p>
        <button type="button" style={styles.secondaryButton} onClick={openFilePicker}>
          Import another file
        </button>
      </Shell>
    );
  }

  if (busy === "submitting") {
    return (
      <Shell>
        <h1 style={styles.h1}>Creating your Mutant analysis…</h1>
        <p style={styles.subtitle}>
          Submitting {formatCount(parsed?.coverage.matched ?? 0)} relevant variants. Your raw DNA
          file stayed on your device.
        </p>
      </Shell>
    );
  }

  if (busy === "parsing") {
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

  if (parsed) {
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
          <div style={styles.summaryRow}>
            <span>Relevant variants found</span>
            <strong>{formatCount(parsed.coverage.matched)}</strong>
          </div>
          {Object.keys(parsed.wgsVariantCalls).length ? (
            <div style={styles.summaryRow}>
              <span>Non-SNV capture targets</span>
              <strong>{formatCount(Object.keys(parsed.wgsVariantCalls).length)}</strong>
            </div>
          ) : null}
          <div style={{ ...styles.summaryRow, borderBottom: "none" }}>
            <span>Panels covered</span>
            <strong>
              {formatCount(parsed.coverage.matched)} of {formatCount(parsed.coverage.total)}
            </strong>
          </div>
        </div>
        <div style={styles.buttonRow}>
          <button
            type="button"
            style={styles.primaryButton}
            onClick={() => void submit(app)}
            disabled={busy !== null}
          >
            Create my Mutant analysis
          </button>
          <button type="button" style={styles.secondaryButton} onClick={openFilePicker}>
            Choose a different file
          </button>
        </div>
      </Shell>
    );
  }

  // Routing state from show_dna_import. It reflects the precondition the tool was
  // called under, not a fresh entitlement check, so it sets expectations without
  // removing the user's ability to import.
  const unlinked = importContext?.accountStatus === "unlinked";
  const alreadyImported = importContext?.dnaStatus === "available";

  return (
    <Shell>
      <h1 style={styles.h1}>Mutant Genomics</h1>
      <p style={styles.subtitle}>Add your DNA data</p>

      {unlinked ? (
        <div style={styles.notice} role="status">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Connect your Mutant account first</p>
          <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
            Your Mutant account is not linked yet. Reconnect Mutant in ChatGPT, then reopen this
            panel to add DNA data.
          </p>
        </div>
      ) : null}

      {alreadyImported ? (
        <div style={styles.notice} role="status">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>DNA data is already on file</p>
          <p style={{ margin: 0, color: "var(--color-text-secondary, #5f6368)" }}>
            You can ask ChatGPT about your Mutant analysis. Importing another file replaces it.
          </p>
        </div>
      ) : null}

      {uploadError ? <ErrorPanel message={uploadError} onRetry={openFilePicker} /> : null}

      {unlinked ? null : (
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
            Choose DNA File
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

      <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-secondary, #5f6368)" }}>
        Supported formats: 23andMe, Ancestry, VCF / WGS. Whole-genome files can take several minutes
        to process locally.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.vcf,.gz,.bgz"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          void handleFile(file, app, catalog);
        }}
      />
    </Shell>
  );
}

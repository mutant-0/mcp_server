import { useEffect, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { consentDataSchema, type ConsentData } from "../../schemas/consent";

type Props = {
  app: App | null;
  requiredPurpose: string | null;
  onComplete: () => void;
  onCancel: () => void;
};
const PURPOSE_COPY = {
  genetic_processing: {
    title: "Allow Mutant to process my genetic data",
    body: "Mutant processes the genetic calls selected from your DNA file and stores them with your analysis. Your raw DNA file stays on your device and is never uploaded or stored by Mutant.",
  },
  chatgpt_sharing: {
    title: "Allow Mutant to share my results with ChatGPT",
    body: "When you ask about your results, Mutant can return relevant findings, hypotheses, and genotypes to ChatGPT. Your raw DNA file is never shared.",
  },
};

async function consentCall(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<ConsentData> {
  const result = await app.callServerTool({ name, arguments: args });
  const envelope = result.structuredContent as
    { ok?: boolean; data?: unknown; error?: { code?: string } } | undefined;
  if (!envelope?.ok) {
    if (
      envelope?.error?.code === "INSUFFICIENT_SCOPE" ||
      envelope?.error?.code === "AUTHENTICATION_REQUIRED"
    ) {
      throw new Error(
        "Your Mutant connection needs authorization to save privacy choices. Reconnect Mutant in ChatGPT, then try again.",
      );
    }
    if (envelope?.error?.code === "INTEGRATION_REVOKED") {
      throw new Error(
        "This Mutant connection was disconnected. Reconnect it before saving privacy choices.",
      );
    }
    if (envelope?.error?.code === "INVALID_ARGUMENT") {
      throw new Error(
        "The privacy notice may have changed. Reload the notice and review your choices again.",
      );
    }
    throw new Error(
      "Mutant could not confirm your privacy choices. Try again or use the website option below.",
    );
  }
  const parsed = consentDataSchema.safeParse(envelope.data);
  if (!parsed.success)
    throw new Error("The privacy notice could not be verified. Reload it before continuing.");
  return parsed.data;
}

/** All writes use the authenticated MCP bridge; no portal login or browser fetch. */
export function EmbeddedConsent({ app, requiredPurpose, onComplete, onCancel }: Props) {
  const [data, setData] = useState<ConsentData | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setSelected([]);
    setError(null);
    if (app)
      void consentCall(app, "get_consent", {})
        .then((value) => {
          if (active) setData(value);
        })
        .catch(() => {
          if (active)
            setError(
              "The privacy notice could not be loaded. Reload it or use the website option below.",
            );
        });
    return () => {
      active = false;
    };
  }, [app, reload]);

  const required = data?.purposes.find((row) => row.purpose === requiredPurpose);
  const canContinue = Boolean(
    data && required && (required.current || selected.includes(required.purpose)),
  );
  async function save() {
    if (!app || !data || !canContinue || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (selected.length)
        await consentCall(app, "save_consent", {
          notice_version: data.notice.version,
          purposes: selected,
        });
      // Re-read the authoritative store; a partial write or concurrent withdrawal
      // must not be mistaken for success. Preserve choices for an idempotent retry.
      const confirmed = await consentCall(app, "get_consent", {});
      setData(confirmed);
      if (confirmed.notice.version !== data.notice.version) {
        setSelected([]);
        throw new Error("The privacy notice changed. Review it and select your choices again.");
      }
      if (
        !confirmed.purposes.some((row) => row.purpose === requiredPurpose && row.current) ||
        selected.some(
          (purpose) => !confirmed.purposes.some((row) => row.purpose === purpose && row.current),
        )
      ) {
        throw new Error("Your choices could not all be confirmed. Try saving again.");
      }
      onComplete();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Your choices could not be saved. Try again.",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <div aria-busy={busy}>
      {!data && !error ? <p role="status">Loading privacy notice…</p> : null}
      {data ? (
        <>
          <p>
            <strong>Notice version {data.notice.version}</strong>
          </p>
          <p>{data.notice.summary}</p>
          {data.notice.sections.map((section) => (
            <div key={section.heading}>
              <h3 style={{ fontSize: 15 }}>{section.heading}</h3>
              <p>{section.body}</p>
            </div>
          ))}
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: "16px 0" }}>
            <legend style={{ fontSize: 16, fontWeight: 600 }}>Your privacy choices</legend>
            {data.purposes.map((row) => (
              <div key={row.purpose} style={{ margin: "12px 0" }}>
                <label style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={row.current || selected.includes(row.purpose)}
                    disabled={row.current}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, row.purpose]
                          : previous.filter((purpose) => purpose !== row.purpose),
                      )
                    }
                  />
                  <strong>{PURPOSE_COPY[row.purpose].title}</strong>
                </label>
                <p style={{ margin: "6px 0 0 24px" }}>{PURPOSE_COPY[row.purpose].body}</p>
                <small style={{ marginLeft: 24 }}>
                  {row.current
                    ? "Already accepted"
                    : row.purpose === requiredPurpose
                      ? "Required to continue this request"
                      : "Optional for this request"}
                </small>
              </div>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={!canContinue || busy}
            onClick={() => void save()}
            style={{
              padding: "10px 16px",
              borderRadius: 8,
              border: 0,
              background: "var(--mutant-accent, #176a49)",
              color: "white",
              cursor: "pointer",
              opacity: !canContinue || busy ? 0.55 : 1,
            }}
          >
            {busy ? "Saving…" : "Agree and continue"}
          </button>
        </>
      ) : null}
      <button type="button" disabled={busy} onClick={onCancel} style={{ margin: 12 }}>
        Not now
      </button>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>
            Reload privacy notice
          </button>
        </div>
      ) : null}
    </div>
  );
}

import type { AppConfig } from "../config.js";
import type { ToolResponse } from "../contract.js";

/**
 * The only host an informational plan link may point at. Mirrors the backend's
 * `PLAN_INFO_HOST`; the apex and its subdomains (e.g. `dev.mutantgenomics.com`)
 * are accepted.
 */
const PLAN_INFO_HOST = "mutantgenomics.com";

/**
 * Fallback label for a substituted link. The backend authors the notice copy;
 * this is only used when the notice's own label is absent but the notice is
 * otherwise present.
 */
const DEFAULT_PLAN_LEARN_MORE_LABEL = "Learn about Mutant plans";

/** Return the URL when it is an https URL on the approved Mutant domain. */
function approvedPlanInfoUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== PLAN_INFO_HOST && !host.endsWith(`.${PLAN_INFO_HOST}`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The configured public destination, validated; `null` when unusable. */
function configuredPlanInfoUrl(config: AppConfig): string | null {
  return approvedPlanInfoUrl(config.MUTANT_PLAN_INFO_URL);
}

/**
 * Validate one server-authored notice.
 *
 * The factual `text` is passed through untouched. The optional `learn_more`
 * link is validated against the approved Mutant domain; a supplied link that is
 * missing, insecure, or off-domain is replaced by the configured public URL when
 * that is valid, and dropped otherwise. It is never rewritten to a checkout or
 * cart destination.
 */
function sanitizeNotice(value: unknown, config: AppConfig): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const text = typeof row.text === "string" && row.text.trim() ? row.text : null;
  if (!text) return null;

  const notice: Record<string, unknown> = { text };
  const raw = row.learn_more;
  let label: string | null = null;
  let url: string | null = null;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const learnMore = raw as Record<string, unknown>;
    if (typeof learnMore.label === "string" && learnMore.label.trim()) {
      label = learnMore.label;
    }
    url = approvedPlanInfoUrl(learnMore.url);
  }
  if (!url) url = configuredPlanInfoUrl(config);

  if (url) {
    notice.learn_more = { label: label ?? DEFAULT_PLAN_LEARN_MORE_LABEL, url };
  }
  return notice;
}

/** Remove any legacy 3.0.0 upgrade field so it can never egress publicly. */
function stripLegacyFields(record: Record<string, unknown>): Record<string, unknown> {
  if (!("upgrade" in record) && !("upgrade_url" in record)) return record;
  const copy = { ...record };
  delete copy.upgrade;
  delete copy.upgrade_url;
  return copy;
}

/**
 * Make the public envelope safe for a 3.1.0 client regardless of which backend
 * revision answered.
 *
 * * Every legacy 3.0.0 `upgrade` / `upgrade_url` field is stripped from both the
 *   success payload and the error payload, so a mixed-version deployment can
 *   never expose an upgrade CTA or a transactional URL.
 * * A present `plan_notice` has its optional informational link validated; an
 *   absent or invalid link is substituted with the configured public URL when
 *   that is valid, and omitted otherwise.
 */
export function withValidatedPlanNotice(response: ToolResponse, config: AppConfig): ToolResponse {
  const next: ToolResponse = { ...response };

  if (response.error) {
    const error = stripLegacyFields(
      response.error as unknown as Record<string, unknown>,
    );
    if ("plan_notice" in error) {
      const notice = sanitizeNotice(error.plan_notice, config);
      if (notice) error.plan_notice = notice;
      else delete error.plan_notice;
    }
    next.error = error as unknown as ToolResponse["error"];
  }

  if (response.data) {
    const data = stripLegacyFields(response.data as unknown as Record<string, unknown>);
    if ("plan_notice" in data) {
      const notice = sanitizeNotice(data.plan_notice, config);
      if (notice) data.plan_notice = notice;
      else delete data.plan_notice;
    }
    next.data = data;
  }

  return next;
}

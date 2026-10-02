/**
 * Shared helpers for the PRIV-06 retention scripts.
 *
 * The apply/verify tooling shells out to the AWS CLI rather than pulling in
 * additional AWS SDK clients: it runs operator-side (same style as
 * `docs/privacy/discovery-runbook.md`), it is read-only unless `--apply` is
 * passed, and it keeps the Lambda dependency bundle unchanged.
 */
import { execFileSync } from "node:child_process";

export const REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2";

/** Run the AWS CLI and return stdout. Throws (with stderr attached) on failure. */
export function aws(args: string[]): string {
  return execFileSync("aws", [...args, "--region", REGION], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function awsJson<T>(args: string[]): T {
  return JSON.parse(aws(args)) as T;
}

/** Best-effort AWS CLI call: returns `null` instead of throwing. */
export function awsJsonSafe<T>(args: string[]): T | null {
  try {
    return awsJson<T>(args);
  } catch {
    return null;
  }
}

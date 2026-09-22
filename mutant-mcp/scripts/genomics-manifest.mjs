/**
 * The vendored DNA processor's contract.
 *
 * Shared by the sync script (`scripts/sync-genomics.mjs`) and the drift guard in
 * `tests/genomics-parity.test.ts`, so the manifest and the test cannot disagree
 * about which modules are vendored or how they are hashed.
 *
 * Hashes cover the *module body*: the vendored file without its generated header.
 * Text is normalised to LF before it is hashed or written. Git checks this
 * repository out with `core.autocrlf` on Windows and with LF everywhere else, so
 * hashing raw bytes would make one commit pass locally and fail in CI (which is
 * exactly what happened: every vendored module reported as "modified" on
 * ubuntu-latest while `npm run check:genomics` passed on Windows). `.gitattributes`
 * pins the vendored tree to LF; normalising here keeps the check correct even in
 * a working tree git has not renormalised yet.
 */
import { createHash } from "node:crypto";

/** Upstream directory these modules are copied from, recorded in the manifest. */
export const SOURCE = "front-end-web/src/genomics";

/**
 * The shared processing surface. Kept in sync deliberately: every module here is
 * identical to its upstream counterpart apart from the generated header.
 *
 * The upstream `parseInWorker.js` / `parse.worker.js` are deliberately NOT
 * vendored. They belong to the portal's own upload flow: the client fetches a
 * catalog from the portal over HTTP (workers cannot read the portal session), and
 * the worker returns a result shape the component does not use. The component
 * runs the same `parse.js` / `stream.js` / `catalog.js` through its own worker
 * entry (`src/ui/dna-import/workerEntry.js`) with an injected catalog, so keeping
 * the portal's copies would only add a second, divergent code path.
 *
 * `sexChromosome.js` IS vendored because `parse.js` imports it: the per-line
 * parsers fold X/Y evidence into it during the same pass. The component does not
 * read that evidence (it derives its own context in
 * `src/ui/dna-import/parseCore.js`), but the module has to be present for the
 * vendored `parse.js` to resolve. Keeping it out of the set would make the
 * vendored processor a broken subset of upstream.
 */
export const MODULES = [
  "catalog.js",
  "detect.js",
  "normalize.js",
  "parse.js",
  "parse23andMe.js",
  "parseAncestry.js",
  "parseVcf.js",
  "sexChromosome.js",
  "stream.js",
];

export const GENERATED_HEADER = `// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
`;

export const MANIFEST_NOTE =
  "Hashes are of the upstream module body (without the generated header), with line endings normalized to LF.";

/** Collapse CRLF to LF so a checkout's line endings cannot change a hash. */
export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The hashed part of a vendored file: its text with line endings normalised and
 * the generated header removed. Tolerates a copy that is missing the header, so
 * a hand-edited file is reported as drift rather than crashing the check.
 */
export function readVendoredBody(vendoredText) {
  const text = normalizeNewlines(vendoredText);
  return text.startsWith(GENERATED_HEADER) ? text.slice(GENERATED_HEADER.length) : text;
}

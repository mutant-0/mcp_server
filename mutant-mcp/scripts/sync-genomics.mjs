#!/usr/bin/env node
/**
 * Vendor the browser-side DNA processor from the Mutant portal into the MCP
 * server, so the portal and the ChatGPT Apps SDK component run the *same*
 * parsing implementation instead of two drifting copies.
 *
 * Source of truth: `front-end-web/src/genomics/`. Only the portal-free
 * processing modules are vendored; the React upload UI is not, because the Apps
 * SDK component has its own shell.
 *
 * Usage:
 *   node scripts/sync-genomics.mjs            # write vendored copies + manifest
 *   node scripts/sync-genomics.mjs --check    # verify, exit 1 on drift
 *
 * The source directory is resolved from `MUTANT_GENOMICS_SOURCE` when set. In CI
 * only this repository is checked out, so `--check` always validates the vendored
 * copies against the manifest and *additionally* validates upstream parity when
 * the source directory is present.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_HEADER as HEADER,
  MANIFEST_NOTE,
  MODULES,
  SOURCE,
  normalizeNewlines,
  readVendoredBody,
  sha256,
} from "./genomics-manifest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const SOURCE_DIR = process.env.MUTANT_GENOMICS_SOURCE
  ? path.resolve(process.env.MUTANT_GENOMICS_SOURCE)
  : path.resolve(PROJECT_ROOT, "..", "..", "front-end-web", "front-end-web", "src", "genomics");
const TARGET_DIR = path.join(PROJECT_ROOT, "src", "ui", "genomics");
const MANIFEST_PATH = path.join(TARGET_DIR, "sync-manifest.json");
const API_SHIM_PATH = path.join(PROJECT_ROOT, "src", "ui", "api.js");

async function readUpstream(name) {
  // Normalised so the manifest (and the vendored copy written from it) is
  // identical whichever platform runs the sync.
  return normalizeNewlines(await readFile(path.join(SOURCE_DIR, name), "utf8"));
}

async function readVendored(name) {
  return readVendoredBody(await readFile(path.join(TARGET_DIR, name), "utf8"));
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function buildManifest() {
  const modules = {};
  for (const name of MODULES) {
    modules[name] = sha256(await readUpstream(name));
  }
  return {
    source: SOURCE,
    note: MANIFEST_NOTE,
    modules,
  };
}

async function write() {
  await mkdir(TARGET_DIR, { recursive: true });
  const manifest = await buildManifest();
  // `readUpstream` normalises newlines, so the vendored copy lands as LF on every
  // platform and matches the hash the manifest just recorded.
  for (const name of MODULES) {
    await writeFile(path.join(TARGET_DIR, name), HEADER + (await readUpstream(name)), "utf8");
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeApiShim();
  console.log(`sync:genomics wrote ${MODULES.length} modules from ${SOURCE_DIR}`);
}

/**
 * The single portal dependency inside the vendored set is `catalog.js` importing
 * `fetchSnpCatalog` from `../api`. That is a module-level import only: the
 * component always injects the catalog returned by `get_snp_catalog`, so
 * `fetchCatalog()` is never invoked. This shim makes an accidental portal HTTP
 * call fail loudly instead of silently reaching for a Cognito token.
 */
async function writeApiShim() {
  const shim = `// GENERATED FILE - DO NOT EDIT (written by scripts/sync-genomics.mjs).
//
// Portal API shim for the vendored genomics modules.
//
// The Apps SDK component receives the SNP catalog from the get_snp_catalog MCP
// tool and injects it into the parser, so nothing in the vendored processor may
// reach back to the Mutant portal: there is no portal session, no Cognito token,
// and no cookie in the ChatGPT iframe. Calling this function is a bug, so it
// throws rather than falling back to an unauthenticated request.
export function fetchSnpCatalog() {
  throw new Error(
    "The vendored DNA processor must be given an explicit SNP catalog; it cannot fetch one from the portal inside the ChatGPT app."
  );
}
`;
  await writeFile(API_SHIM_PATH, shim, "utf8");
}

async function check() {
  const manifest = await readManifest();
  if (!manifest) {
    console.error(`check failed: ${MANIFEST_PATH} is missing. Run: npm run sync:genomics`);
    process.exitCode = 1;
    return;
  }

  const failures = [];

  // 1. The vendored copies must match the manifest. This is the half that runs in
  //    CI, where only this repository is checked out. Both sides are hashed with
  //    LF endings, so the result does not depend on the checkout's line endings.
  for (const name of MODULES) {
    let body;
    try {
      body = await readVendored(name);
    } catch {
      failures.push(`missing vendored module: src/ui/genomics/${name}`);
      continue;
    }
    const actual = sha256(body);
    const expected = manifest.modules?.[name];
    if (expected && actual !== expected) {
      failures.push(
        `vendored module modified: src/ui/genomics/${name} (run: npm run sync:genomics)`,
      );
    }
  }

  // 2. When the portal checkout is available, the manifest itself must be current.
  let upstreamChecked = false;
  try {
    const upstream = await buildManifest();
    upstreamChecked = true;
    for (const name of MODULES) {
      if (upstream.modules[name] !== manifest.modules?.[name]) {
        failures.push(
          `upstream drift: front-end-web/src/genomics/${name} changed (run: npm run sync:genomics)`,
        );
      }
    }
    if (!failures.length) {
      for (const name of MODULES) {
        if (!(name in (manifest.modules ?? {}))) {
          failures.push(`manifest is missing ${name} (run: npm run sync:genomics)`);
        }
      }
    }
  } catch {
    console.log("sync:genomics check skipped upstream parity (portal source not present)");
  }

  if (failures.length) {
    for (const failure of failures) console.error(`check failed: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `sync:genomics OK (${MODULES.length} modules${upstreamChecked ? ", upstream parity verified" : ""})`,
  );
}

const isCheck = process.argv.includes("--check");
await (isCheck ? check() : write());

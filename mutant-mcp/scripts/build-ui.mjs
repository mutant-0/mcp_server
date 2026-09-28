#!/usr/bin/env node
/**
 * Build the DNA import Apps SDK component into a single self-contained HTML
 * document, embedded in a TypeScript module so the Lambda bundle carries it
 * without any runtime file reads.
 *
 * Two bundles are produced:
 *
 * 1. The parser worker (`workerEntry.js`) as its own IIFE, embedded into the
 *    component as the `__DNA_IMPORT_WORKER_SOURCE__` string constant. The
 *    component starts it from a `blob:` URL at runtime.
 * 2. The component itself (`main.tsx`), which owns the UI, the host bridge, and
 *    the main-thread fallback used when a worker cannot start.
 *
 * Why one document with an inlined script: an MCP Apps resource is served as a
 * single `text/html;profile=mcp-app` body (`resources/read` returns it inline),
 * so there is no document origin to resolve sibling asset URLs against. Every
 * byte has to be in the response - including the worker, which is why it is
 * inlined as a string rather than emitted as a sibling file.
 *
 * The component declares no CSP `resourceDomains` (it only talks to the host over
 * `tools/call`), so it must not reference an external script/style/image origin,
 * and it cannot declare `worker-src` for the `blob:` worker. A host that blocks
 * the worker is therefore expected, not exceptional: the component falls back to
 * the same parser on the main thread.
 *
 * Usage: node scripts/build-ui.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "ui", "dna-import", "main.tsx");
const WORKER_ENTRY = path.join(PROJECT_ROOT, "src", "ui", "dna-import", "workerEntry.js");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "src", "ui", "dna-import", "generated");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "html.ts");
/**
 * The compact follow-up card is a second, independent document. It gets its own
 * entry and its own generated module so the large overview/import bundle is never
 * re-served just to render two buttons.
 */
const FOLLOWUPS_ENTRY = path.join(PROJECT_ROOT, "src", "ui", "analysis-followups", "main.tsx");
const FOLLOWUPS_OUTPUT_DIR = path.join(PROJECT_ROOT, "src", "ui", "analysis-followups", "generated");
const FOLLOWUPS_OUTPUT_FILE = path.join(FOLLOWUPS_OUTPUT_DIR, "html.ts");

/** Name of the esbuild `define` that carries the worker script into the component. */
const WORKER_SOURCE_DEFINE = "__DNA_IMPORT_WORKER_SOURCE__";

/** Escape a script body so it cannot terminate the surrounding <script> element. */
function escapeForInlineScript(js) {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/**
 * Bundle a browser entry to a single self-contained IIFE. `splitting` is only
 * meaningful for ESM output, so an IIFE is one file by construction - which is
 * what an embedded worker script requires.
 */
async function bundle(entryPoint, { outfile, define = {} } = {}) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"', ...define },
    outfile,
  });

  const js = result.outputFiles?.[0]?.text;
  if (!js) throw new Error(`esbuild produced no output for ${path.basename(entryPoint)}.`);
  return js;
}

function renderHtml(js, title = "Mutant DNA Import") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  /*
   * The whole mount chain is pinned full width. The !important flags are
   * deliberate: the host can inject its own shell stylesheet into this document,
   * and one max-width on html/body/#root is enough to reintroduce the empty
   * right-hand column this layout exists to remove.
   */
  html, body, #root {
    margin: 0;
    padding: 0;
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    background: transparent;
  }
  html, body { overflow-x: hidden; }
  body { -webkit-font-smoothing: antialiased; }
  /* The component root fills the mount node however deep the host nests it. */
  #root > * { width: 100% !important; max-width: none !important; box-sizing: border-box; }
</style>
</head>
<body>
<div id="root"></div>
<script>${escapeForInlineScript(js)}</script>
</body>
</html>
`;
}

async function build() {
  // The worker is bundled first: the component build needs its text to inline.
  const workerJs = await bundle(WORKER_ENTRY, {
    outfile: path.join(OUTPUT_DIR, "worker.js"),
  });

  const js = await bundle(ENTRY, {
    outfile: path.join(OUTPUT_DIR, "bundle.js"),
    define: {
      // Inlines the worker as a JS string literal. A define (rather than a
      // generated module) keeps the worker out of the component's module graph,
      // so no React or DOM-only code can leak into it.
      [WORKER_SOURCE_DEFINE]: JSON.stringify(workerJs),
    },
  });

  const html = renderHtml(js);
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const workerBytes = Buffer.byteLength(workerJs, "utf8");

  const module = `// GENERATED FILE - DO NOT EDIT.
// Built from src/ui/dna-import/main.tsx and src/ui/dna-import/workerEntry.js by
// scripts/build-ui.mjs. Run \`npm run build:ui\` after changing either.
//
// The component is inlined as one self-contained document: an MCP Apps resource
// is served inline from \`resources/read\`, so it has no document origin to load
// sibling assets from, and it declares no CSP resource domains. The parser worker
// is inlined into that document as a string and started from a \`blob:\` URL, with
// a main-thread fallback for hosts that block it.

/** Self-contained HTML document for the ${"ui://mutant/dna-import/v1.html"} resource. */
export const DNA_IMPORT_HTML = ${JSON.stringify(html)};

/** Byte size of the rendered document, for logging and size assertions. */
export const DNA_IMPORT_HTML_BYTES = ${htmlBytes};

/** Byte size of the embedded parser worker script. */
export const DNA_IMPORT_WORKER_BYTES = ${workerBytes};
`;

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, module, "utf8");
  console.log(
    `build:ui wrote src/ui/dna-import/generated/html.ts (${htmlBytes} bytes of HTML, ` +
      `${workerBytes} bytes of embedded worker)`,
  );

  // The follow-up card: a second self-contained document under its own URI. No
  // worker, no embedded asset - just the component, so it stays small.
  const followupsJs = await bundle(FOLLOWUPS_ENTRY, {
    outfile: path.join(FOLLOWUPS_OUTPUT_DIR, "bundle.js"),
  });
  const followupsHtml = renderHtml(followupsJs, "Mutant follow-up");
  const followupsBytes = Buffer.byteLength(followupsHtml, "utf8");

  const followupsModule = `// GENERATED FILE - DO NOT EDIT.
// Built from src/ui/analysis-followups/main.tsx by scripts/build-ui.mjs.
// Run \`npm run build:ui\` after changing it.
//
// A separate single-document bundle from the overview/import component: the
// follow-up card is navigation-only, so it is kept small and served under its own
// stable resource URI. It declares no CSP resource domains either.

/** Self-contained HTML document for the ${"ui://mutant/analysis-followups/v1.html"} resource. */
export const ANALYSIS_FOLLOWUPS_HTML = ${JSON.stringify(followupsHtml)};

/** Byte size of the rendered document, for logging and size assertions. */
export const ANALYSIS_FOLLOWUPS_HTML_BYTES = ${followupsBytes};
`;

  await mkdir(FOLLOWUPS_OUTPUT_DIR, { recursive: true });
  await writeFile(FOLLOWUPS_OUTPUT_FILE, followupsModule, "utf8");
  console.log(
    `build:ui wrote src/ui/analysis-followups/generated/html.ts (${followupsBytes} bytes of HTML)`,
  );
}

await build();

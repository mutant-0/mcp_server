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

function renderHtml(js) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Mutant DNA Import</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { -webkit-font-smoothing: antialiased; }
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
}

await build();

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const localModules = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../mutant-mcp/node_modules');
const { build } = await import('esbuild').catch(() => import(pathToFileURL(path.join(localModules, 'esbuild/lib/main.js')).href));

for (const [format, outfile] of [["esm", "dist/index.mjs"], ["cjs", "dist/index.cjs"]]) {
  await build({
    entryPoints: ["src/index.js"],
    outfile,
    bundle: true,
    format,
    platform: "browser",
    target: "es2022",
    nodePaths: [localModules],
    legalComments: "none",
  });
}

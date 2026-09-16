import { readFileSync } from "node:fs";

const s = readFileSync(
  "node_modules/@modelcontextprotocol/ext-apps/dist/src/react/index.js",
  "utf8",
);
for (const needle of ["requestAnimationFrame", "cancelAnimationFrame"]) {
  let index = s.indexOf(needle);
  console.log(`\n=== ${needle} ===`);
  while (index >= 0) {
    console.log(`--- at ${index} ---`);
    console.log(s.slice(Math.max(0, index - 320), index + 220));
    index = s.indexOf(needle, index + 1);
  }
}

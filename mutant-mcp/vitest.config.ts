import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Normalize the root to a canonical absolute path. Without this, Vitest can
  // load two runtime copies on Windows when the working directory uses a
  // different drive-letter case than Node's canonical path, which makes every
  // suite fail with "Cannot read properties of undefined (reading 'config')".
  root: fileURLToPath(new URL("./", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});

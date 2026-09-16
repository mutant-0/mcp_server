import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Normalize the root to a canonical absolute path. Without this, Vitest can
  // load two runtime copies on Windows when the working directory uses a
  // different drive-letter case than Node's canonical path, which makes every
  // suite fail with "Cannot read properties of undefined (reading 'config')".
  root: fileURLToPath(new URL("./", import.meta.url)),
  // scripts/build-ui.mjs inlines the bundled parser worker as this build-time
  // constant. Tests never build that bundle, so they get a stub instead: the
  // worker startup path stays exercisable without a full UI build, and the
  // main-thread path stays reachable because no test environment defines a real
  // `Worker`.
  define: {
    __DNA_IMPORT_WORKER_SOURCE__: JSON.stringify("/* stub parser worker for tests */"),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});

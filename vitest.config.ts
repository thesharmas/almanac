import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Anything that needs a real warehouse or a real Gateway
    // is opt-in via `*.live.test.ts`, so `npm test` stays fast, hermetic and
    // runnable with no credentials — including on a fresh clone before the
    // interview has been run.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist", "generated", "**/*.live.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
  },
});

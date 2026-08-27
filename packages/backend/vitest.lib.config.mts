import { defineConfig } from "vitest/config";

// Pure Convex helper contracts intentionally live outside the convex-test
// suite. The discovery harness passes only Vitest-authored files as CLI
// filters; this config makes them eligible without ever admitting the
// **/*.convex.test.ts suite owned by vitest.config.ts.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    exclude: ["convex/**/*.convex.test.ts"],
  },
});

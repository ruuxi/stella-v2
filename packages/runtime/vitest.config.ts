import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    // Workspace packages publish TypeScript entrypoints; inline them so Vite
    // transforms them instead of handing raw .ts to Node.
    server: { deps: { inline: true } },
    setupFiles: [
      "./tests/setup/model-registry.ts",
      "./tests/setup/hermetic-env.ts",
    ],
  },
});

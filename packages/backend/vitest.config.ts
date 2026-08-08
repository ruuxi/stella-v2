import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.convex.test.ts"],
    env: {
      SITE_URL: "https://stella.test",
      CONVEX_SITE_URL: "https://convex.test",
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-test-only",
      RESEND_FROM: "test@stella.test",
    },
  },
});

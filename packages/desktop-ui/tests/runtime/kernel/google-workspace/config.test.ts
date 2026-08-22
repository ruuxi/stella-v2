import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logToFile: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/google-workspace/logger", () => ({
  logToFile: mocks.logToFile,
}));

import { loadConfig } from "@stella/runtime/kernel/google-workspace/config";

const ENV_KEYS = [
  "STELLA_GOOGLE_OAUTH_DEMO",
  "WORKSPACE_CLIENT_ID",
  "WORKSPACE_CLIENT_SECRET",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  mocks.logToFile.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Google Workspace OAuth demo configuration", () => {
  it.each([undefined, "0", "true"])(
    "does not inject the demo secret when the demo flag is %s",
    (demoFlag) => {
      process.env.WORKSPACE_CLIENT_SECRET = "test-demo-secret";
      if (demoFlag !== undefined) {
        process.env.STELLA_GOOGLE_OAUTH_DEMO = demoFlag;
      }

      expect(loadConfig()).not.toHaveProperty("clientSecret");
    },
  );

  it("injects the demo secret only for an explicit flag without logging it", () => {
    const secret = "test-demo-secret";
    process.env.STELLA_GOOGLE_OAUTH_DEMO = "1";
    process.env.WORKSPACE_CLIENT_SECRET = secret;

    expect(loadConfig()).toMatchObject({ clientSecret: secret });
    expect(mocks.logToFile).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logToFile.mock.calls)).not.toContain(secret);
  });
});

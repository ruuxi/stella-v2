import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getLocalLlmOAuthApiKey,
  getLlmOAuthCredentialStorePath,
  saveLocalLlmOAuthCredential,
} from "@stella/runtime/kernel/storage/llm-oauth-credentials";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../helpers/protected-storage.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  installTestSafeStorage();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetTestSafeStorage();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("xAI OAuth protected storage refresh", () => {
  it("refreshes an expired token and persists the rotation only through safeStorage", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(os.tmpdir(), "stella-xai-oauth-"),
    );
    tempDirs.push(stellaDataDir);
    saveLocalLlmOAuthCredential(stellaDataDir, {
      provider: "xai",
      label: "xAI",
      credentials: {
        access: "expired-access",
        refresh: "refresh-secret",
        expires: 0,
      },
    });

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "rotated-access",
          expires_in: 3_600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(getLocalLlmOAuthApiKey(stellaDataDir, "xai")).resolves.toBe(
      "rotated-access",
    );
    await expect(getLocalLlmOAuthApiKey(stellaDataDir, "xai")).resolves.toBe(
      "rotated-access",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const stored = await readFile(
      getLlmOAuthCredentialStorePath(stellaDataDir),
      "utf8",
    );
    expect(stored).toContain("stella-protected:llm-oauth-credential:xai:v1:");
    expect(stored).not.toContain("expired-access");
    expect(stored).not.toContain("rotated-access");
    expect(stored).not.toContain("refresh-secret");
  });
});

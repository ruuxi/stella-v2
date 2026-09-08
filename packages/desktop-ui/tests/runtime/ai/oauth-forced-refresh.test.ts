import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getLocalLlmOAuthApiKey,
  saveLocalLlmOAuthCredential,
} from "@stella/runtime/kernel/storage/llm-oauth-credentials";
import {
  OAUTH_REFRESH_SKEW_MS,
  getOAuthApiKey,
} from "@stella/runtime/ai/utils/oauth/index";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../../helpers/protected-storage.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

const accessTokenFor = (accountId: string): string => {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
};

const tokenResponse = (accountId: string) =>
  new Response(
    JSON.stringify({
      access_token: accessTokenFor(accountId),
      refresh_token: `refresh-${accountId}`,
      expires_in: 3_600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const revokedResponse = () =>
  new Response(
    JSON.stringify({
      error: "invalid_grant",
      error_description: "Your refresh token was revoked.",
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

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

const seedCodexCredential = async (expires: number) => {
  const stellaDataDir = await mkdtemp(
    path.join(os.tmpdir(), "stella-codex-oauth-"),
  );
  tempDirs.push(stellaDataDir);
  saveLocalLlmOAuthCredential(stellaDataDir, {
    provider: "openai-codex",
    label: "ChatGPT",
    credentials: {
      access: accessTokenFor("account-stored"),
      refresh: "refresh-stored",
      expires,
      accountId: "account-stored",
    },
  });
  return stellaDataDir;
};

describe("OAuth forced refresh", () => {
  it("returns the stored token untouched while it is comfortably fresh", async () => {
    const stellaDataDir = await seedCodexCredential(Date.now() + 60 * 60_000);
    const fetchSpy = vi.fn(async () => tokenResponse("account-rotated"));
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(
      getLocalLlmOAuthApiKey(stellaDataDir, "openai-codex"),
    ).resolves.toBe(accessTokenFor("account-stored"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes ahead of the recorded expiry by the skew margin", async () => {
    const creds = {
      access: "about-to-expire",
      refresh: "refresh-stored",
      expires: Date.now() + OAUTH_REFRESH_SKEW_MS / 2,
    };
    const fetchSpy = vi.fn(async () => tokenResponse("account-rotated"));
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await getOAuthApiKey("openai-codex", {
      "openai-codex": creds,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result?.apiKey).toBe(accessTokenFor("account-rotated"));
  });

  it("mints a new token on forceRefresh even when the stored one has not expired", async () => {
    const stellaDataDir = await seedCodexCredential(Date.now() + 60 * 60_000);
    const fetchSpy = vi.fn(async () => tokenResponse("account-rotated"));
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(
      getLocalLlmOAuthApiKey(stellaDataDir, "openai-codex", {
        forceRefresh: true,
      }),
    ).resolves.toBe(accessTokenFor("account-rotated"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The rotation is persisted: a plain read now serves the new token.
    await expect(
      getLocalLlmOAuthApiKey(stellaDataDir, "openai-codex"),
    ).resolves.toBe(accessTokenFor("account-rotated"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the stored expiry when a forced refresh is rejected, so validation reports reauth", async () => {
    const stellaDataDir = await seedCodexCredential(Date.now() + 60 * 60_000);
    const fetchSpy = vi.fn(async () => revokedResponse());
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(
      getLocalLlmOAuthApiKey(stellaDataDir, "openai-codex", {
        forceRefresh: true,
      }),
    ).rejects.toThrow(/Failed to refresh OAuth token/);

    // A plain read no longer trusts the stored access token: it retries the
    // refresh and fails again, which is what the settings validator turns
    // into "needs reauth".
    await expect(
      getLocalLlmOAuthApiKey(stellaDataDir, "openai-codex"),
    ).rejects.toThrow(/Failed to refresh OAuth token/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deleteLocalLlmOAuthAccount,
  getLocalLlmOAuthApiKey,
  listLocalLlmOAuthAccounts,
  markLocalLlmOAuthAccountLimited,
  saveLocalLlmOAuthCredential,
  setActiveLocalLlmOAuthAccount,
  setLocalLlmOAuthAutoSwitch,
} from "@stella/runtime/kernel/storage/llm-oauth-credentials";
import { subscriptionLimitOfError } from "@stella/runtime/ai/providers/auth-refresh";
import { claudeCodeSubscriptionLimitOf } from "@stella/runtime/kernel/integrations/claude-code-session-runtime";
import {
  installTestSafeStorage,
  resetTestSafeStorage,
} from "../helpers/protected-storage.js";

const tempDirs: string[] = [];

const codexAccess = (user: string, email: string, plan: string): string => {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: `workspace-${user}`,
        chatgpt_user_id: user,
        chatgpt_plan_type: plan,
      },
      "https://api.openai.com/profile": { email },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
};

const codexLogin = (user: string, email: string, plan = "plus") => ({
  provider: "openai-codex",
  label: "ChatGPT",
  credentials: {
    access: codexAccess(user, email, plan),
    refresh: `refresh-${user}`,
    expires: Date.now() + 3_600_000,
  },
  mode: "login" as const,
});

const freshDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-oauth-accounts-"));
  tempDirs.push(dir);
  return dir;
};

const codexAccounts = (dir: string) =>
  listLocalLlmOAuthAccounts(dir).find((entry) => entry.provider === "openai-codex");

beforeEach(() => {
  installTestSafeStorage();
});

afterEach(async () => {
  resetTestSafeStorage();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("local OAuth accounts", () => {
  it("adds a second login, keeps a re-login as one account, and serves the active one", async () => {
    const dir = await freshDir();
    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    saveLocalLlmOAuthCredential(dir, codexLogin("user-b", "b@example.com", "pro"));

    let state = codexAccounts(dir)!;
    expect(state.accounts.map((row) => [row.email, row.plan, row.active])).toEqual([
      ["a@example.com", "Plus", false],
      ["b@example.com", "Pro", true],
    ]);
    expect(await getLocalLlmOAuthApiKey(dir, "openai-codex")).toBe(
      codexAccess("user-b", "b@example.com", "pro"),
    );

    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    state = codexAccounts(dir)!;
    expect(state.accounts).toHaveLength(2);
    expect(state.accounts.find((row) => row.active)?.email).toBe("a@example.com");
  });

  it("switches the serving account and signs one out", async () => {
    const dir = await freshDir();
    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    saveLocalLlmOAuthCredential(dir, codexLogin("user-b", "b@example.com"));
    const [first, second] = codexAccounts(dir)!.accounts;

    setActiveLocalLlmOAuthAccount(dir, "openai-codex", first!.id);
    expect(await getLocalLlmOAuthApiKey(dir, "openai-codex")).toBe(
      codexAccess("user-a", "a@example.com", "plus"),
    );

    deleteLocalLlmOAuthAccount(dir, "openai-codex", first!.id);
    expect(codexAccounts(dir)!.accounts.map((row) => [row.id, row.active])).toEqual([
      [second!.id, true],
    ]);
    expect(await getLocalLlmOAuthApiKey(dir, "openai-codex")).toBe(
      codexAccess("user-b", "b@example.com", "plus"),
    );
  });

  it("cools a limited account down and auto-switches only when enabled", async () => {
    const dir = await freshDir();
    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    saveLocalLlmOAuthCredential(dir, codexLogin("user-b", "b@example.com"));
    const [first] = codexAccounts(dir)!.accounts;
    setActiveLocalLlmOAuthAccount(dir, "openai-codex", first!.id);
    const resetsAt = Date.now() + 2 * 60 * 60_000;

    expect(markLocalLlmOAuthAccountLimited(dir, "openai-codex", resetsAt)).toEqual({
      switched: false,
    });
    expect(codexAccounts(dir)!.accounts[0]).toMatchObject({
      active: true,
      limitedUntil: resetsAt,
    });

    setLocalLlmOAuthAutoSwitch(dir, "openai-codex", true);
    // A key read with auto-switch on moves off the account still on cooldown.
    expect(await getLocalLlmOAuthApiKey(dir, "openai-codex")).toBe(
      codexAccess("user-b", "b@example.com", "plus"),
    );
    expect(codexAccounts(dir)!.autoSwitch).toBe(true);

    // The second account at its limit too: nothing left to switch to.
    expect(markLocalLlmOAuthAccountLimited(dir, "openai-codex")).toEqual({
      switched: false,
    });
  });

  it("a refresh updates the active account instead of adding one", async () => {
    const dir = await freshDir();
    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    saveLocalLlmOAuthCredential(dir, {
      ...codexLogin("user-a", "a@example.com"),
      credentials: {
        access: "refreshed-access",
        refresh: "refresh-2",
        expires: Date.now() + 3_600_000,
      },
      mode: "refresh",
    });

    expect(codexAccounts(dir)!.accounts).toHaveLength(1);
    expect(await getLocalLlmOAuthApiKey(dir, "openai-codex")).toBe("refreshed-access");
  });

  it("an existing single credential becomes the first account with a stable id", async () => {
    const dir = await freshDir();
    saveLocalLlmOAuthCredential(dir, codexLogin("user-a", "a@example.com"));
    // A file from before multiple accounts: only the single credential slot.
    const file = path.join(dir, "llm_oauth_credentials.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete parsed.accounts;
    await writeFile(file, JSON.stringify(parsed));

    const first = codexAccounts(dir)!.accounts;
    const second = codexAccounts(dir)!.accounts;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ email: "a@example.com", active: true });
    expect(second[0]!.id).toBe(first[0]!.id);
  });
});

describe("subscription limit detection", () => {
  it("recognises usage limits, not ordinary rate limits", () => {
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("You have hit your ChatGPT usage limit."), {
          code: "usage_limit_reached",
          resetsAt: 5_000,
        }),
      ),
    ).toEqual({ resetsAt: 5_000 });
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("429 rate_limit_error"), {
          status: 429,
          headers: new Headers({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": "4102444800",
          }),
        }),
      ),
    ).toEqual({ resetsAt: 4_102_444_800_000 });
    expect(
      subscriptionLimitOfError(
        Object.assign(new Error("429 Too many requests"), { status: 429 }),
      ),
    ).toBeNull();
  });

  it("reads the Claude Code CLI's limit messages", () => {
    expect(
      claudeCodeSubscriptionLimitOf(new Error("Claude AI usage limit reached|4102444800")),
    ).toEqual({ resetsAt: 4_102_444_800_000 });
    expect(
      claudeCodeSubscriptionLimitOf(new Error("5-hour limit reached ∙ resets 3pm")),
    ).toEqual({});
    expect(claudeCodeSubscriptionLimitOf(new Error("Tool call failed"))).toBeNull();
  });
});

import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BeforeUserMessagePayload } from "@stella/runtime/kernel/extensions/types";
import {
  createLinkWalletReminderHook,
  LINK_WALLET_CONNECTED_REMINDER_TEXT,
  LINK_WALLET_DISCONNECTED_REMINDER_TEXT,
} from "@stella/runtime/extensions/stella-runtime/hooks/link-wallet-reminder.hook";
import { createLinkSpendNotifyHook } from "@stella/runtime/extensions/stella-runtime/hooks/link-spend-notify.hook";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const roots: string[] = [];

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-link-wallet-hook-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const storeWith = (
  messages: Array<{ content: string; timestamp: number }> = [],
) => ({
  loadThreadMessages: () => messages,
});

const basePayload = (userPrompt: string): BeforeUserMessagePayload => ({
  agentType: "orchestrator",
  userPrompt,
  conversationId: "conv-1",
  threadKey: "conv-1",
  isUserTurn: true,
  uiVisibility: "visible",
});

describe("link-wallet reminder hook", () => {
  it("reminds the orchestrator to call link_wallet when disconnected", async () => {
    const root = makeRoot();
    const hook = createLinkWalletReminderHook({
      stellaDataDir: root,
      store: storeWith(),
    });
    const result = await hook.handler(basePayload("can you buy this for me?"));
    expect(result?.prependMessages?.[0]?.text).toContain(
      LINK_WALLET_DISCONNECTED_REMINDER_TEXT.slice(0, 40),
    );
    expect(result?.prependMessages?.[0]?.text).toContain("link_wallet");
  });

  it("reminds that the skill exists when connected", async () => {
    const root = makeRoot();
    await mkdir(path.join(root, "wallet"), { recursive: true });
    await writeFile(
      path.join(root, "wallet", "link-auth.json"),
      JSON.stringify({ authenticated: true }),
      "utf8",
    );
    const hook = createLinkWalletReminderHook({
      stellaDataDir: root,
      store: storeWith(),
    });
    const result = await hook.handler(basePayload("pay for checkout please"));
    expect(result?.prependMessages?.[0]?.text).toContain(
      LINK_WALLET_CONNECTED_REMINDER_TEXT.slice(0, 40),
    );
    expect(result?.prependMessages?.[0]?.text).toContain("link-cli");
  });

  it("ignores unrelated prompts", async () => {
    const root = makeRoot();
    const hook = createLinkWalletReminderHook({
      stellaDataDir: root,
      store: storeWith(),
    });
    expect(await hook.handler(basePayload("what's the weather"))).toBeUndefined();
  });
});

describe("link spend notify hook", () => {
  it("notifies on spend-request --request-approval", async () => {
    const calls: Array<{
      merchantName?: string;
      amountCents?: number;
      conversationId?: string;
    }> = [];
    const hook = createLinkSpendNotifyHook({
      notifyLinkSpendApproval: (payload) => {
        calls.push(payload);
      },
    });
    const context: ToolContext = {
      conversationId: "c1",
      deviceId: "d1",
      requestId: "r1",
    };
    await hook.handler({
      tool: "exec_command",
      args: {
        cmd: 'npx --yes @stripe/link-cli spend-request create --merchant-name "Stripe Press" --amount 3500 --request-approval',
      },
      context,
    });
    expect(calls).toEqual([
      {
        merchantName: "Stripe Press",
        amountCents: 3500,
        conversationId: "c1",
      },
    ]);
  });

  it("ignores spend requests without approval", async () => {
    const calls: unknown[] = [];
    const hook = createLinkSpendNotifyHook({
      notifyLinkSpendApproval: (payload) => {
        calls.push(payload);
      },
    });
    await hook.handler({
      tool: "exec_command",
      args: { cmd: "npx --yes @stripe/link-cli spend-request list" },
      context: {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
      },
    });
    expect(calls).toEqual([]);
  });
});

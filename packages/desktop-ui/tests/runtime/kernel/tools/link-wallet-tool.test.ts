import { describe, expect, it, vi } from "vitest";

import {
  createLinkWalletTool,
  type LinkWalletConnectionRequester,
} from "@stella/runtime/kernel/tools/defs/link-wallet";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";
import type { LinkWalletSnapshot } from "@stella/contracts/link-wallet";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const connectedSnapshot: LinkWalletSnapshot = {
  status: "connected",
  paymentMethods: [
    { id: "pm_1", brand: "visa", last4: "4242", isDefault: true },
  ],
  spends: [],
};

const resultText = (result: { result?: unknown; error?: unknown }) =>
  String(result.result ?? result.error);

describe("link_wallet tool", () => {
  it("returns a snapshot summary when already connected", async () => {
    const requester: LinkWalletConnectionRequester = vi.fn(async () => ({
      ok: true as const,
      status: "already_connected" as const,
      snapshot: connectedSnapshot,
    }));
    const tool = createLinkWalletTool({
      requestLinkWalletConnection: requester,
    });
    const result = await tool.execute({}, context);
    expect(requester).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1" }),
      undefined,
    );
    expect(resultText(result)).toContain("•••• 4242");
    expect(resultText(result)).toContain("Spend history: 0");
    expect(result.details).toMatchObject({ status: "connected" });
  });

  it("shows the connect card and continues after approval", async () => {
    const requester: LinkWalletConnectionRequester = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
      snapshot: connectedSnapshot,
    }));
    const tool = createLinkWalletTool({
      requestLinkWalletConnection: requester,
    });
    const result = await tool.execute(
      { reason: "To pay for this order" },
      context,
    );
    expect(requester).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "To pay for this order",
        conversationId: "c1",
      }),
      undefined,
    );
    expect(resultText(result)).toContain("just approved the connect card");
  });

  it("asks the user to add a card before paying when none are on file", async () => {
    const requester: LinkWalletConnectionRequester = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
      snapshot: {
        status: "connected" as const,
        paymentMethods: [],
        spends: [],
      },
    }));
    const tool = createLinkWalletTool({
      requestLinkWalletConnection: requester,
    });
    const result = await tool.execute({}, context);
    expect(resultText(result)).toContain("no card yet");
    expect(resultText(result)).toContain("Wait until they add a card");
  });

  it("reports a decline without retrying", async () => {
    const requester: LinkWalletConnectionRequester = vi.fn(async () => ({
      ok: false as const,
      reason: "declined" as const,
    }));
    const tool = createLinkWalletTool({
      requestLinkWalletConnection: requester,
    });
    const result = await tool.execute({}, context);
    expect(resultText(result)).toContain("declined connecting Link");
    expect(result.details).toMatchObject({ status: "declined" });
  });

  it("errors when the connect flow is unavailable", async () => {
    const tool = createLinkWalletTool({});
    const result = await tool.execute({}, context);
    expect(result.error).toContain("unavailable");
  });
});

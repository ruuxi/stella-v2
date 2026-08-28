import { describe, expect, it } from "vitest";

import {
  parseAuthStatus,
  parseJsonObject,
  parseLoginPrompt,
  parsePaymentMethods,
  parseSpendHistory,
  snapshotFromCli,
} from "@stella/runtime/kernel/wallet/parse";
import { detectLinkCliInvocation } from "@stella/runtime/kernel/wallet/detect";
import {
  formatLinkSpendUsd,
  parseLinkSpendUsd,
} from "@stella/contracts/link-wallet";

describe("link wallet parse", () => {
  it("treats missing auth JSON as disconnected", () => {
    expect(parseAuthStatus(null)).toEqual({ authenticated: false });
    expect(parseAuthStatus(parseJsonObject(""))).toEqual({
      authenticated: false,
    });
  });

  it("reads authenticated from status JSON", () => {
    expect(
      parseAuthStatus({ authenticated: true, scope: "userinfo:read" }),
    ).toEqual({ authenticated: true });
  });

  it("extracts device-code login fields without credential material", () => {
    const prompt = parseLoginPrompt({
      verification_url: "https://link.com/device",
      user_code: "blue-forest",
      access_token: "should-not-surface",
    });
    expect(prompt).toEqual({
      verificationUrl: "https://link.com/device",
      userCode: "blue-forest",
    });
    expect(JSON.stringify(prompt)).not.toMatch(/access_token|card|pan|cvc/i);
  });

  it("maps payment methods to last4 views only", () => {
    const methods = parsePaymentMethods({
      data: [
        {
          id: "csmrpd_1",
          brand: "visa",
          last4: "4242",
          is_default: true,
          number: "4242424242424242",
        },
      ],
    });
    expect(methods).toEqual([
      { id: "csmrpd_1", brand: "visa", last4: "4242", isDefault: true },
    ]);
  });

  it("maps spend history without card fields", () => {
    const spends = parseSpendHistory({
      spend_requests: [
        {
          id: "lsrq_1",
          merchant_name: "Stripe Press",
          amount: 3500,
          status: "approved",
          created_at: 1_700_000_000,
          card: { number: "4000009990001984", cvc: "123" },
        },
      ],
    });
    expect(spends).toEqual([
      {
        id: "lsrq_1",
        merchantName: "Stripe Press",
        amountCents: 3500,
        currency: "usd",
        status: "approved",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    expect(JSON.stringify(spends)).not.toMatch(/4000009990001984|cvc/i);
  });

  it("builds a connected snapshot from CLI payloads", () => {
    const snapshot = snapshotFromCli({
      authenticated: true,
      paymentMethods: [{ id: "pm_1", brand: "visa", last4: "1984" }],
      spends: [],
    });
    expect(snapshot.status).toBe("connected");
    if (snapshot.status === "connected") {
      expect(snapshot.paymentMethods).toHaveLength(1);
    }
  });
});

describe("detectLinkCliInvocation", () => {
  it("ignores unrelated shell", () => {
    expect(detectLinkCliInvocation("ls -la")).toBeNull();
  });

  it("detects auth login", () => {
    expect(
      detectLinkCliInvocation("npx @stripe/link-cli auth login"),
    ).toEqual({ kind: "auth_login" });
  });

  it("detects spend-request approval flags", () => {
    expect(
      detectLinkCliInvocation(
        'bunx @stripe/link-cli spend-request create --merchant-name "Stripe Press" --amount 3500 --request-approval',
      ),
    ).toEqual({
      kind: "spend_request",
      requestsApproval: true,
      merchantName: "Stripe Press",
      amountCents: 3500,
    });
  });
});

describe("link spend display helpers", () => {
  it("formats and parses dollar amounts without leftover fractions", () => {
    expect(formatLinkSpendUsd(3500)).toBe("$35.00");
    expect(parseLinkSpendUsd("$35.00")).toBe(3500);
    expect(parseLinkSpendUsd("not money")).toBeUndefined();
  });
});

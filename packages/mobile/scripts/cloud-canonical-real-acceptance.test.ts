import { describe, expect, test } from "bun:test";

import { assertBun14 } from "./cloud-canonical-real-acceptance";

describe("mobile cloud-canonical real-product harness", () => {
  test("fails closed unless the fixed harness is running on Bun 1.4", () => {
    expect(assertBun14("1.4.0")).toBe("1.4.0");
    expect(assertBun14("1.4.2+build")).toBe("1.4.2+build");
    expect(() => assertBun14("1.3.14")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14("2.0.0")).toThrow("Bun 1.4.x is required");
    expect(() => assertBun14(undefined)).toThrow("Bun 1.4.x is required");
  });

  test("keeps the accepted CLI tied to product modules and a real process boundary", async () => {
    const source = await Bun.file(
      import.meta.path.replace(/\.test\.ts$/u, ".ts"),
    ).text();
    for (const productModule of [
      "cloud-conversation-auth",
      "cloud-conversation-authority",
      "cloud-conversation-socket",
      "cloud-journal-projection",
      "desktop-chat-outbox-state",
      "execution-placement-core",
      "cloud-memory-preference",
      "convex-token-owner",
    ]) {
      expect(source).toContain(productModule);
    }
    expect(source).toContain('phase === "enqueue"');
    expect(source).toContain('phase === "replay"');
    expect(source).toContain("processExitedBeforeAdmission: true");
    expect(source).toContain("new ConversationSocket");
    expect(source).toContain("/api/mobile/execution/submit");
    expect(source).not.toContain("FakeWebSocket");
    expect(source).not.toContain("mockFetch");
  });
});

import { describe, expect, it } from "vitest";
import { magicLinkSendErrorKey } from "@/global/auth/magic-link-send-error";

describe("magicLinkSendErrorKey", () => {
  it("maps disposable-email rejections to a sentence, not the API code", () => {
    expect(magicLinkSendErrorKey("email_not_supported")).toBe(
      "global.auth.emailNotSupported",
    );
  });

  it("does not surface unknown API codes as the message", () => {
    expect(magicLinkSendErrorKey("turnstile_failed")).toBe(
      "global.auth.sendFailed",
    );
    expect(magicLinkSendErrorKey(undefined)).toBe("global.auth.sendFailed");
  });
});

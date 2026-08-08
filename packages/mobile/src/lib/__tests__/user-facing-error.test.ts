import { describe, expect, test } from "bun:test";
import { userFacingError } from "../user-facing-error";

describe("userFacingError", () => {
  test("raw JSON parse garbage never reaches the user", () => {
    expect(
      userFacingError(new Error("JSON Parse error: Unexpected character: <")),
    ).toBe(
      "Your computer sent an unexpected response. Update Stella on your desktop, then try again.",
    );
    expect(
      userFacingError(new Error("Unexpected token < in JSON at position 0")),
    ).toBe(
      "Your computer sent an unexpected response. Update Stella on your desktop, then try again.",
    );
  });

  test("structured endpoint-unavailable errors read as an update prompt", () => {
    expect(
      userFacingError(
        new Error("Desktop bridge endpoint unavailable (HTTP 200)."),
      ),
    ).toBe(
      "Your computer sent an unexpected response. Update Stella on your desktop, then try again.",
    );
  });

  test("ordinary short messages still pass through", () => {
    expect(userFacingError(new Error("Message is required."))).toBe(
      "Message is required.",
    );
  });
});

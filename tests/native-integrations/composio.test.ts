import { describe, expect, it } from "bun:test";

import {
  buildComposioSessionBody,
  composioLinkFromPayload,
  composioSessionIdFromPayload,
} from "../../convex/http_routes/native_oauth";

describe("Composio native integrations", () => {
  it("builds the current tool router session toolkit allowlist payload", () => {
    expect(
      buildComposioSessionBody({
        userId: "stella_user",
        toolkit: "spotify",
      }),
    ).toEqual({
      user_id: "stella_user",
      toolkits: { enable: ["spotify"] },
    });
  });

  it("reads current and legacy session id response fields", () => {
    expect(composioSessionIdFromPayload({ session_id: "trs_current" })).toBe(
      "trs_current",
    );
    expect(composioSessionIdFromPayload({ sessionId: "trs_legacy" })).toBe(
      "trs_legacy",
    );
    expect(
      composioSessionIdFromPayload({ session: { session_id: "trs_nested" } }),
    ).toBe("trs_nested");
  });

  it("reads current and legacy link response fields", () => {
    expect(
      composioLinkFromPayload({
        redirect_url: "https://app.composio.dev/link/current",
      }),
    ).toBe("https://app.composio.dev/link/current");
    expect(
      composioLinkFromPayload({
        data: { redirect_url: "https://app.composio.dev/link/nested" },
      }),
    ).toBe("https://app.composio.dev/link/nested");
    expect(
      composioLinkFromPayload({
        redirectUrl: "https://app.composio.dev/link/legacy",
      }),
    ).toBe("https://app.composio.dev/link/legacy");
  });
});

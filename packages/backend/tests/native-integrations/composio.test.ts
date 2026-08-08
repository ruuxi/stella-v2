import { describe, expect, it } from "bun:test";

import {
  buildComposioSessionBody,
  composioLinkFromPayload,
  composioSessionIdFromPayload,
  composioToolkitConnectedFromPayload,
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

  it("reads toolkit connection status across payload shapes", () => {
    // Connected account, current shape.
    expect(
      composioToolkitConnectedFromPayload(
        {
          items: [
            {
              toolkit: { slug: "gmail" },
              connection: {
                isActive: true,
                connectedAccount: { id: "ca_1", status: "ACTIVE" },
              },
            },
          ],
        },
        "gmail",
      ),
    ).toBe(true);
    // Pending OAuth: account exists but is not active yet.
    expect(
      composioToolkitConnectedFromPayload(
        {
          items: [
            {
              toolkit: { slug: "gmail" },
              connection: {
                isActive: false,
                connectedAccount: { id: "ca_1", status: "INITIATED" },
              },
            },
          ],
        },
        "gmail",
      ),
    ).toBe(false);
    // No connection object at all.
    expect(
      composioToolkitConnectedFromPayload(
        { items: [{ toolkit: { slug: "gmail" } }] },
        "gmail",
      ),
    ).toBe(false);
    // Flat/legacy shapes and alternate arrays.
    expect(
      composioToolkitConnectedFromPayload(
        { data: [{ slug: "GMAIL", is_connected: true }] },
        "gmail",
      ),
    ).toBe(true);
    // Other toolkits don't count.
    expect(
      composioToolkitConnectedFromPayload(
        { items: [{ toolkit: { slug: "notion" }, is_connected: true }] },
        "gmail",
      ),
    ).toBe(false);
    // Empty payloads.
    expect(composioToolkitConnectedFromPayload({}, "gmail")).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";

import {
  buildComposioSessionBody,
  composioLinkFromPayload,
  composioSessionIdFromPayload,
  composioToolkitConnectedFromPayload,
  normalizePublishedIntegrationActions,
} from "../../convex/http_routes/native_oauth";
import {
  codeModePolicyForAction,
  reviewedCodeModeActionKeys,
} from "../../scripts/composio-code-mode-policy.mjs";
import {
  assertCatalogPageWithinLimit,
  readCatalogResponseTextBounded,
  setCatalogEntryBounded,
} from "../../scripts/composio-catalog-io.mjs";

describe("Composio native integrations", () => {
  it("accepts only structured catalog safety annotations", () => {
    const schema = { type: "object", properties: {} };
    expect(
      normalizePublishedIntegrationActions([
        {
          name: "GMAIL_GET_PROFILE",
          description: "Looks read-only, but prose is not policy.",
          inputSchema: schema,
        },
      ]),
    ).toEqual({
      ok: true,
      actions: [
        {
          name: "GMAIL_GET_PROFILE",
          description: "Looks read-only, but prose is not policy.",
          inputSchemaJson: JSON.stringify(schema),
        },
      ],
    });
    expect(
      normalizePublishedIntegrationActions([
        {
          name: "GMAIL_GET_PROFILE",
          inputSchema: schema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            source: "composio_tool_tags",
          },
          codeModePolicy: {
            effect: "read",
            requiresApproval: false,
            policyVersion: "2026-08-26.gmail-get-profile.v1",
            toolkitVersion: "20260817_00",
            reviewedInputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            source: "stella_admin",
          },
        },
      ]),
    ).toMatchObject({
      ok: true,
      actions: [
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            source: "composio_tool_tags",
          },
          codeModePolicy: {
            effect: "read",
            requiresApproval: false,
            policyVersion: "2026-08-26.gmail-get-profile.v1",
            toolkitVersion: "20260817_00",
            reviewedInputSchemaJson: JSON.stringify({
              type: "object",
              properties: {},
              additionalProperties: false,
            }),
            source: "stella_admin",
          },
        },
      ],
    });
    expect(
      normalizePublishedIntegrationActions([
        {
          name: "GMAIL_GET_PROFILE",
          inputSchema: schema,
          annotations: {
            readOnlyHint: true,
            source: "description_guess",
          },
        },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      normalizePublishedIntegrationActions([
        {
          name: "GMAIL_GET_PROFILE",
          inputSchema: schema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            source: "composio_tool_tags",
          },
          codeModePolicy: {
            effect: "read",
            requiresApproval: false,
            policyVersion: "unreviewed",
            source: "provider_guess",
          },
        },
      ]),
    ).toMatchObject({ ok: false });
  });

  it("admits Code policy only from the explicit Stella-reviewed manifest", () => {
    expect(reviewedCodeModeActionKeys()).toEqual([
      "gmail:GMAIL_GET_PROFILE",
    ]);
    expect(codeModePolicyForAction("gmail", "GMAIL_GET_PROFILE")).toEqual({
      effect: "read",
      requiresApproval: false,
      policyVersion: "2026-08-26.gmail-get-profile.v1",
      toolkitVersion: "20260817_00",
      reviewedInputSchema: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            minLength: 1,
            maxLength: 320,
          },
        },
        additionalProperties: false,
      },
      source: "stella_admin",
    });
    expect(codeModePolicyForAction("gmail", "GMAIL_SEND_EMAIL")).toBeUndefined();
    expect(
      codeModePolicyForAction("gmail", "GMAIL_LOOKS_READ_ONLY"),
    ).toBeUndefined();
  });

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

  it("bounds streamed catalog pages before aggregate allocation", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    await expect(
      readCatalogResponseTextBounded(response, 10, "tool catalog"),
    ).rejects.toThrow("tool catalog: Composio response is too large.");
    expect(canceled).toBe(true);

    const advertised = new Response("{}", {
      headers: { "content-length": "11" },
    });
    await expect(
      readCatalogResponseTextBounded(advertised, 10, "tool catalog"),
    ).rejects.toThrow("tool catalog: Composio response is too large.");

    expect(() => assertCatalogPageWithinLimit(3, 3, "tool catalog")).toThrow(
      "tool catalog: pagination exceeded 3 pages.",
    );
    const entries = new Map<string, unknown>();
    setCatalogEntryBounded(entries, "a", {}, 2, "tool catalog");
    setCatalogEntryBounded(entries, "b", {}, 2, "tool catalog");
    // Replacing an already-budgeted exact contract is allowed.
    setCatalogEntryBounded(entries, "b", { reviewed: true }, 2, "tool catalog");
    expect(() =>
      setCatalogEntryBounded(entries, "c", {}, 2, "tool catalog"),
    ).toThrow("tool catalog: entry count exceeds 2.");
    expect(entries.has("c")).toBe(false);
  });
});

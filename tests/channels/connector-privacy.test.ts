import { describe, expect, it } from "bun:test";

import {
  buildConnectorTurnEventPayload,
  buildConnectorTurnPrivatePayload,
  CONNECTOR_TURN_PAYLOAD_REF,
} from "../../convex/channels/connector_privacy";

describe("connector turn privacy payloads", () => {
  it("keeps connector prompt and media refs out of durable event payloads", () => {
    const privateText = "private connector prompt 750b8b7f";
    const privateMediaUrl = "https://example.invalid/private-media";

    const eventPayload = buildConnectorTurnEventPayload({
      conversationId: "conversation-1",
      provider: "slack",
      deliveryMeta: { channelId: "C123", threadTs: "1710000000.000000" },
      userMessageId: "event-1",
    });
    const serialized = JSON.stringify(eventPayload);

    expect(eventPayload).toEqual({
      conversationId: "conversation-1",
      provider: "slack",
      deliveryMeta: { channelId: "C123", threadTs: "1710000000.000000" },
      payloadRef: CONNECTOR_TURN_PAYLOAD_REF,
      userMessageId: "event-1",
    });
    expect(serialized).not.toContain(privateText);
    expect(serialized).not.toContain(privateMediaUrl);
    expect("text" in eventPayload).toBe(false);
    expect("mediaRefs" in eventPayload).toBe(false);
  });

  it("puts prompt and media refs only in the private transient payload", () => {
    const payload = buildConnectorTurnPrivatePayload({
      conversationId: "conversation-1",
      text: "private connector prompt 06362f3a",
      mediaRefs: [
        {
          id: "media-1",
          kind: "image",
          url: "https://example.invalid/private-media",
          expiresAt: Date.now() + 60_000,
        },
      ],
    });

    expect(payload.text).toBe("private connector prompt 06362f3a");
    expect(payload.mediaRefs?.[0]?.url).toBe(
      "https://example.invalid/private-media",
    );
  });
});

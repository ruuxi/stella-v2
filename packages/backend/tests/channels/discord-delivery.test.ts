import { describe, expect, it } from "bun:test";

import {
  buildDiscordChannelMessagePayloads,
  DISCORD_SAFE_ALLOWED_MENTIONS,
  splitDiscordMessage,
} from "../../convex/channels/discord";
import type { ConnectorMediaRef } from "../../convex/channels/connector_media_types";

describe("Discord delivery payloads", () => {
  it("splits long Discord responses instead of truncating them", () => {
    const text = "a".repeat(4200);
    const chunks = splitDiscordMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  });

  it("adds safe mention defaults and replies only on the first chunk", () => {
    const payloads = buildDiscordChannelMessagePayloads(
      `hello @everyone\n${"b".repeat(2200)}`,
      [],
      "original-message",
    );

    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads[0].allowed_mentions).toEqual(DISCORD_SAFE_ALLOWED_MENTIONS);
    expect(payloads[0].message_reference).toEqual({
      message_id: "original-message",
      fail_if_not_exists: false,
    });
    expect(payloads[1].allowed_mentions).toEqual(DISCORD_SAFE_ALLOWED_MENTIONS);
    expect(payloads[1].message_reference).toBeUndefined();
  });

  it("puts image embeds on the first chunk and links non-image media in text", () => {
    const media: ConnectorMediaRef[] = [
      {
        kind: "image",
        url: "https://cdn.example.com/image.png",
        name: "render.png",
      },
      {
        kind: "document",
        url: "https://cdn.example.com/doc.pdf",
        name: "notes.pdf",
      },
    ];

    const [payload] = buildDiscordChannelMessagePayloads("done", media);

    expect(payload.content).toContain("done");
    expect(payload.content).toContain("notes.pdf: https://cdn.example.com/doc.pdf");
    expect(payload.embeds).toEqual([
      {
        title: "render.png",
        image: { url: "https://cdn.example.com/image.png" },
      },
    ]);
  });
});

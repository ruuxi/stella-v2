import { describe, expect, it } from "bun:test";

import {
  buildDiscordGatewayIngestUrl,
  DISCORD_GATEWAY_INTENTS,
  resolveDiscordGatewayIntents,
  toConvexDiscordGatewayMessage,
} from "../../scripts/discord-gateway-worker";

describe("Discord gateway worker", () => {
  it("forwards normal DM messages to Convex", () => {
    const message = toConvexDiscordGatewayMessage(
      {
        id: "124",
        channel_id: "dm-channel",
        content: "  hello from dm  ",
        timestamp: "2026-06-04T10:11:12.000Z",
        author: {
          id: "discord-user",
          username: "lolruuxi",
          global_name: "Rahul",
        },
        attachments: [
          {
            id: "att-1",
            filename: "photo.png",
            content_type: "image/png",
            size: 123,
            url: "https://cdn.discordapp.com/photo.png",
            proxy_url: "https://media.discordapp.net/photo.png",
          },
        ],
      },
      "stella-bot",
    );

    expect(message).toEqual({
      id: "124",
      channelId: "dm-channel",
      authorId: "discord-user",
      authorUsername: "lolruuxi",
      authorGlobalName: "Rahul",
      content: "hello from dm",
      timestamp: Date.parse("2026-06-04T10:11:12.000Z"),
      attachments: [
        {
          id: "att-1",
          name: "photo.png",
          mimeType: "image/png",
          size: 123,
          url: "https://cdn.discordapp.com/photo.png",
          proxyUrl: "https://media.discordapp.net/photo.png",
          kind: "image",
        },
      ],
    });
  });

  it("drops guild, bot, self, and empty messages", () => {
    expect(toConvexDiscordGatewayMessage({
      id: "1",
      channel_id: "guild-channel",
      guild_id: "guild",
      content: "guild message",
      author: { id: "user" },
    })).toBeNull();

    expect(toConvexDiscordGatewayMessage({
      id: "2",
      channel_id: "dm-channel",
      content: "bot message",
      author: { id: "bot", bot: true },
    })).toBeNull();

    expect(toConvexDiscordGatewayMessage({
      id: "3",
      channel_id: "dm-channel",
      content: "self message",
      author: { id: "stella-bot" },
    }, "stella-bot")).toBeNull();

    expect(toConvexDiscordGatewayMessage({
      id: "4",
      channel_id: "dm-channel",
      content: "  ",
      author: { id: "user" },
    })).toBeNull();
  });

  it("uses the Discord DM intent by default", () => {
    expect(DISCORD_GATEWAY_INTENTS).toBe(1 << 12);
    expect(resolveDiscordGatewayIntents(String(1 << 15))).toBe((1 << 12) | (1 << 15));
  });

  it("builds the Convex gateway ingest URL", () => {
    expect(buildDiscordGatewayIngestUrl("https://example.convex.site/")).toBe(
      "https://example.convex.site/api/discord/gateway_message",
    );
  });
});

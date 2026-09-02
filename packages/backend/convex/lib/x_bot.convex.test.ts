import { describe, expect, it } from "vitest";
import {
  normalizeXReply,
  parseXBotMentions,
  parseXBotPromoterUsernames,
  parseXBotReplyPlan,
  parseXPostContext,
  resolveXBotPageHandle,
  stripLinkableText,
} from "./x_bot";

describe("parseXBotMentions", () => {
  const event = {
    id_str: "200",
    full_text: "@stelladotsh can you set this up for them?",
    in_reply_to_status_id_str: "100",
    user: {
      id_str: "42",
      screen_name: "alex",
      name: "Alex",
    },
  };

  it("extracts an explicit reply summon", () => {
    expect(
      parseXBotMentions({ tweet_create_events: [event] }, "stelladotsh"),
    ).toEqual([
      {
        id: "200",
        text: "@stelladotsh can you set this up for them?",
        parentId: "100",
        authorId: "42",
        authorUsername: "alex",
        authorName: "Alex",
      },
    ]);
  });

  it("uses the complete longform post when X includes one", () => {
    const [mention] = parseXBotMentions(
      {
        tweet_create_events: [
          {
            ...event,
            text: "A truncated preview",
            extended_tweet: {
              full_text:
                "A long setup question followed by @stelladotsh can you handle this?",
            },
          },
        ],
      },
      "stelladotsh",
    );
    expect(mention?.text).toBe(
      "A long setup question followed by @stelladotsh can you handle this?",
    );
  });

  it("extracts a modern X Activity mention event", () => {
    expect(
      parseXBotMentions(
        {
          data: {
            event_uuid: "delivery-1",
            event_type: "post.mention.create",
            filter: { user_id: "99" },
            payload: {
              id: "300",
              text: "@stelladotsh can you install what they described?",
              author_id: "42",
              in_reply_to_tweet_id: "100",
            },
            includes: {
              users: [
                { id: "42", username: "alex", name: "Alex" },
                { id: "99", username: "stelladotsh", name: "Stella" },
              ],
            },
          },
        },
        "stelladotsh",
      ),
    ).toEqual([
      {
        id: "300",
        text: "@stelladotsh can you install what they described?",
        parentId: "100",
        authorId: "42",
        authorUsername: "alex",
        authorName: "Alex",
      },
    ]);
  });

  it("ignores modern mention events that are not replies", () => {
    expect(
      parseXBotMentions(
        {
          data: {
            event_type: "post.mention.create",
            filter: { user_id: "99" },
            payload: {
              id: "300",
              text: "@stelladotsh hello",
              author_id: "42",
            },
            includes: {
              users: [{ id: "42", username: "alex", name: "Alex" }],
            },
          },
        },
        "stelladotsh",
      ),
    ).toEqual([]);
  });

  it("ignores non-replies, retweets, unsummoned posts, and the bot itself", () => {
    expect(
      parseXBotMentions(
        {
          tweet_create_events: [
            { ...event, in_reply_to_status_id_str: null },
            { ...event, retweeted_status: {} },
            { ...event, full_text: "Stella can do this" },
            event,
          ],
        },
        "stelladotsh",
        "42",
      ),
    ).toEqual([]);
  });
});

describe("parseXPostContext", () => {
  it("joins the post to its expanded author", () => {
    expect(
      parseXPostContext({
        data: { id: "100", text: "How do I install this?", author_id: "9" },
        includes: {
          users: [
            {
              id: "9",
              username: "poster",
              name: "Poster",
              description: "PC games",
            },
          ],
        },
      }),
    ).toEqual({
      id: "100",
      text: "How do I install this?",
      authorId: "9",
      authorUsername: "poster",
      authorName: "Poster",
      authorDescription: "PC games",
    });
  });
});

describe("normalizeXReply", () => {
  it("removes formatting and anything X would auto-link", () => {
    expect(
      normalizeXReply(
        '```text\n"I can handle that. Get Stella at https://stella.sh/."\n```',
      ),
    ).toBe("I can handle that. Get Stella.");
    expect(normalizeXReply("Grab it from stella.sh today")).toBe(
      "Grab it today",
    );
    expect(normalizeXReply("Try www.stella.sh/download now")).toBe("Try now");
  });

  it("caps replies without splitting a Unicode character", () => {
    const reply = normalizeXReply(`I can help ${"🙂".repeat(300)}`, 40);
    expect(Array.from(reply).length).toBeLessThanOrEqual(40);
    expect(reply.endsWith("…")).toBe(true);
  });
});

describe("stripLinkableText", () => {
  it("keeps ordinary sentences with periods intact", () => {
    expect(stripLinkableText("Install it. Then run it. Done.")).toBe(
      "Install it. Then run it. Done.",
    );
  });
});

describe("parseXBotReplyPlan", () => {
  it("normalizes a structured plan and drops links everywhere", () => {
    expect(
      parseXBotReplyPlan({
        reply: "I can set that up. See stella.sh",
        headline: "I can set up that server for your friends.",
        exchanges: [
          {
            user: "Set up a modded Minecraft server for my friends",
            stella: "Installing Fabric, then I will ask before opening the port.",
          },
          { user: "", stella: "ignored" },
          {
            user: "Invite them",
            stella: "Drafting the Discord message for your approval.",
          },
          { user: "third", stella: "dropped" },
        ],
      }),
    ).toEqual({
      reply: "I can set that up. See",
      headline: "I can set up that server for your friends.",
      exchanges: [
        {
          user: "Set up a modded Minecraft server for my friends",
          stella: "Installing Fabric, then I will ask before opening the port.",
        },
        {
          user: "Invite them",
          stella: "Drafting the Discord message for your approval.",
        },
      ],
    });
  });

  it("rejects plans missing the reply, headline, or exchanges", () => {
    expect(parseXBotReplyPlan({ reply: "x", headline: "y" })).toBeNull();
    expect(parseXBotReplyPlan({ reply: "x", exchanges: [] })).toBeNull();
    expect(parseXBotReplyPlan(null)).toBeNull();
  });
});

describe("resolveXBotPageHandle", () => {
  const promoters = parseXBotPromoterUsernames("@1_missthesun, Stella_Team,bad handle");

  it("parses the promoter allowlist", () => {
    expect(promoters).toEqual(["1_missthesun", "stella_team"]);
  });

  it("addresses the page to the summoner by default", () => {
    expect(
      resolveXBotPageHandle(
        { authorUsername: "alex" },
        { authorUsername: "poster" },
        promoters,
      ),
    ).toEqual({ handle: "alex", isPromoterSummon: false });
  });

  it("addresses the page to the poster when a promoter summons", () => {
    expect(
      resolveXBotPageHandle(
        { authorUsername: "1_MissTheSun" },
        { authorUsername: "poster" },
        promoters,
      ),
    ).toEqual({ handle: "poster", isPromoterSummon: true });
  });
});

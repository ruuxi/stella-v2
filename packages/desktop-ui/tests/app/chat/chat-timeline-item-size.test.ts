import { describe, expect, it } from "vitest";
import {
  getChatTimelineItemSize,
  getChatTimelineItemType,
} from "@/app/chat/chat-timeline-item-size";
import type { ChatTimelineItem } from "@/features/chat/lib/chat-timeline-items";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";

const userItem = (id: string): ChatTimelineItem => ({
  id,
  type: "message",
  row: {
    kind: "user",
    id,
    text: id,
    attachments: [],
  },
});

const assistantItem = (
  id: string,
  extras: Partial<Extract<EventRowViewModel, { kind: "assistant" }>> = {},
): ChatTimelineItem => ({
  id,
  type: "message",
  row: {
    kind: "assistant",
    id,
    cacheKey: id,
    text: extras.text ?? "short reply",
    ...extras,
  },
});

describe("chat timeline item size estimates", () => {
  it("classifies user, plain assistant, and rich tool-card rows separately", () => {
    expect(getChatTimelineItemType(userItem("u1"))).toBe("user");
    expect(getChatTimelineItemType(assistantItem("a1"))).toBe("assistant-plain");
    expect(
      getChatTimelineItemType(
        assistantItem("a2", {
          toolActivity: {
            steps: [
              {
                id: "s1",
                toolName: "read",
                category: "read",
                title: "Read file",
                status: "completed",
              },
            ],
            summary: "Read 1 file",
            icon: "read",
          },
        }),
      ),
    ).toBe("assistant-rich");
    expect(
      getChatTimelineItemType({
        id: "chat-timeline:working-indicator",
        type: "working-indicator",
      }),
    ).toBe("working");
    expect(
      getChatTimelineItemType({
        id: "queued",
        type: "queued-users",
        messages: [],
      }),
    ).toBe("queued");
  });

  it("uses a much taller first-paint estimate for rich rows than the uniform 140px fallback", () => {
    const rich = assistantItem("rich", {
      mapArtifacts: [{ id: "map-1" } as never],
    });
    expect(getChatTimelineItemSize(rich, 140)).toBe(720);
    expect(getChatTimelineItemSize(userItem("u1"), 140)).toBe(88);
    expect(getChatTimelineItemSize(assistantItem("plain"), 140)).toBe(160);
  });
});

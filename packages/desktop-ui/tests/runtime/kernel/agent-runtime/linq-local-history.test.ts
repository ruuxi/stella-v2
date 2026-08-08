import { describe, expect, it } from "vitest";

import { buildLocalHistoryFromEvents } from "@stella/runtime/kernel/local-history";

describe("Linq local history metadata", () => {
  it("renders Linq message IDs without transcript database storage", () => {
    const messages = buildLocalHistoryFromEvents({
      events: [
        {
          _id: "event-1",
          timestamp: Date.UTC(2026, 0, 1, 12),
          type: "user_message",
          payload: {
            text: "Loved this",
            source: "connector",
            provider: "linq",
            linqMessageId: "msg_123",
          },
        },
      ],
    });

    expect(messages[0]?.content).toContain("Loved this");
    expect(messages[0]?.content).toContain("[linq_message_id: msg_123]");
  });
});

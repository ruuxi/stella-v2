// @vitest-environment jsdom
/**
 * Hover timestamps on chat messages.
 *
 * The per-message action strip (Copy / Read-aloud / Rewind / Fork) carries a
 * muted local-time "h:mm AM/PM" stamp derived from the message's persisted
 * created time (`row.timestampMs`). The strip itself only reveals on row
 * hover, so the stamp is hover-only for free — these tests pin that:
 *   1. Assistant + user rows thread `timestampMs` into the strip and render
 *      the locale-formatted time inside `.message-actions__timestamp`.
 *   2. A row without a created time renders no stamp element at all.
 * The message-row timestamp uses `toLocaleTimeString` (same
 * options), pinned by the CSS contract test alongside the glyph contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { AssistantMessageRow, UserMessageRow } from "@/app/chat/MessageRow";

// 2026-08-21 14:07 local time — formatted through the same API the component
// uses so the expectation tracks the host locale instead of hardcoding en-US.
const CREATED_AT = new Date(2026, 7, 21, 14, 7, 3).getTime();
const EXPECTED_LABEL = new Date(CREATED_AT).toLocaleTimeString([], {
  hour: "numeric",
  minute: "2-digit",
});

describe("message hover timestamps", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the created time inside the assistant action strip", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <AssistantMessageRow
            row={
              {
                kind: "assistant",
                id: "assistant-user-1-1",
                cacheKey: "assistant-user-1-1",
                text: "Done — here's the summary.",
                timestampMs: CREATED_AT,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any
            }
            conversationId="conv-1"
          />,
        ),
      );
    });
    const stamp = container.querySelector(
      ".message-actions .message-actions__timestamp",
    );
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(EXPECTED_LABEL);
  });

  it("renders the created time inside the user action strip", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <UserMessageRow
            row={
              {
                kind: "user",
                id: "user-1",
                text: "Do the thing",
                timestampMs: CREATED_AT,
                attachments: [],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any
            }
          />,
        ),
      );
    });
    const stamp = container.querySelector(
      ".message-actions--end .message-actions__timestamp",
    );
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(EXPECTED_LABEL);
  });

  it("renders no stamp when the row has no created time", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <AssistantMessageRow
            row={
              {
                kind: "assistant",
                id: "assistant-user-1-1",
                cacheKey: "assistant-user-1-1",
                text: "No timestamp on this one.",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any
            }
            conversationId="conv-1"
          />,
        ),
      );
    });
    expect(container.querySelector(".message-actions")).not.toBeNull();
    expect(container.querySelector(".message-actions__timestamp")).toBeNull();
  });
});

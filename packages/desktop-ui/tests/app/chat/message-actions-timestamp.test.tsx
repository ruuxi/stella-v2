// @vitest-environment jsdom
/**
 * Where a message's exact time lives.
 *
 * Messages no longer carry a stamp under the bubble — the transcript shows a
 * periodic centered divider instead (iMessage-style, see
 * `timestampHeaders`/`ChatTimeDivider`). The exact minute of ONE message stays
 * reachable as the header of its hover ellipsis menu. These tests pin that:
 *   1. Assistant + user rows render no per-message stamp element.
 *   2. The created time (`row.timestampMs`) shows up in the menu, formatted
 *      with `toLocaleTimeString` (same options as before).
 *   3. A row without a created time gets a menu with no time header.
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

describe("message time in the actions menu", () => {
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

  /** Radix opens the menu on `pointerdown`, not `click`. */
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLElement>(".message-actions");
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    const menu = document.querySelector(".message-actions-menu");
    expect(menu).not.toBeNull();
    return menu!;
  };

  it("keeps the assistant row free of a stamp and shows the time in its menu", async () => {
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
    expect(container.querySelector(".message-actions__timestamp")).toBeNull();
    const menu = await openMenu();
    const stamp = menu.querySelector(".message-actions-menu__time");
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(EXPECTED_LABEL);
  });

  it("keeps the user row free of a stamp and shows the time in its menu", async () => {
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
    expect(container.querySelector(".message-actions__timestamp")).toBeNull();
    // The control sits beside the right-aligned bubble, inside its line.
    expect(
      container.querySelector(
        ".message-line--user > .message-actions-rail--end .message-actions",
      ),
    ).not.toBeNull();
    const menu = await openMenu();
    const stamp = menu.querySelector(".message-actions-menu__time");
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(EXPECTED_LABEL);
  });

  it("renders no time header when the row has no created time", async () => {
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
    const menu = await openMenu();
    expect(menu.querySelector(".message-actions-menu__time")).toBeNull();
  });
});

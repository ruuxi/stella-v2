import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { AssistantMessageRow, UserMessageRow } from "@/app/chat/MessageRow";

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

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageRow } from "@/app/chat/MessageRow";
import type { AssistantRowViewModel } from "@/features/chat/conversation-row-types";
import { withI18n } from "../../helpers/i18n";

describe("AssistantMessageRow tool-detail control", () => {
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

  const cases: Array<[string, AssistantRowViewModel["toolEventSummary"]]> = [
    [
      "projected payload with complete event counts",
      { totalCount: 5, loadedCount: 5, truncated: true },
    ],
    [
      "event-count truncation",
      {
        totalCount: 33,
        loadedCount: 32,
        truncated: true,
        totalCountIsLowerBound: true,
      },
    ],
  ];

  it.each(cases)(
    "does not expose inline full-detail hydration for %s",
    async (_caseName, toolEventSummary) => {
      const row: AssistantRowViewModel = {
        kind: "assistant",
        id: "assistant-1",
        cacheKey: "assistant-1",
        text: "The normal assistant answer remains visible.",
        sourceMessageId: "message-1",
        toolEventSummary,
      };

      await act(async () => {
        root.render(
          withI18n(
            <AssistantMessageRow row={row} conversationId="conversation-1" />,
          ),
        );
      });

      expect(container.textContent).toContain(
        "The normal assistant answer remains visible.",
      );
      expect(container.querySelector(".turn-detail-load")).toBeNull();
      expect(container.textContent).not.toContain("Show more (");
      expect(container.querySelector(".message-actions")).not.toBeNull();
    },
  );

  it("does not repeat the control across assistant turn segments", async () => {
    const rows: AssistantRowViewModel[] = [
      {
        kind: "assistant",
        id: "assistant-preamble",
        cacheKey: "assistant-preamble",
        text: "Interim assistant prose.",
        sourceMessageId: "message-preamble",
        isIntraTurn: true,
        toolEventSummary: cases[0][1],
      },
      {
        kind: "assistant",
        id: "assistant-final",
        cacheKey: "assistant-final",
        text: "Final assistant prose.",
        sourceMessageId: "message-final",
        toolEventSummary: cases[1][1],
      },
    ];

    await act(async () => {
      root.render(
        withI18n(
          <>
            {rows.map((row) => (
              <AssistantMessageRow
                key={row.id}
                row={row}
                conversationId="conversation-1"
              />
            ))}
          </>,
        ),
      );
    });

    expect(container.textContent).toContain("Interim assistant prose.");
    expect(container.textContent).toContain("Final assistant prose.");
    expect(container.querySelectorAll(".turn-detail-load")).toHaveLength(0);
    expect(container.textContent).not.toContain("Show more (");
  });
});

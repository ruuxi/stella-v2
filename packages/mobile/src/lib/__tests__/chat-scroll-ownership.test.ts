import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveChatDataChangeScrollOwner } from "../chat-scroll-ownership";

const chatPane = readFileSync(
  resolve(__dirname, "../../components/ChatPane.tsx"),
  "utf8",
);

describe("chat data-change scroll ownership", () => {
  test("a local send from history keeps the visible-history anchor through settling", () => {
    // Optimistic append, keyboard/composer/footer settling, and the response
    // spacer clearing all happen while follow remains deliberately released.
    for (const state of [
      { isStreaming: false, postSendPlacementPending: false },
      { isStreaming: false, postSendPlacementPending: true },
      { isStreaming: true, postSendPlacementPending: false },
    ]) {
      expect(
        resolveChatDataChangeScrollOwner({
          isFollowingLatest: false,
          ...state,
        }),
      ).toBe("history-anchor");
    }
  });

  test("an incoming append cannot claim the tail while history is visible", () => {
    expect(
      resolveChatDataChangeScrollOwner({
        isFollowingLatest: false,
        isStreaming: false,
        postSendPlacementPending: false,
      }),
    ).toBe("history-anchor");
    expect(
      resolveChatDataChangeScrollOwner({
        isFollowingLatest: false,
        isStreaming: true,
        postSendPlacementPending: false,
      }),
    ).toBe("history-anchor");
  });

  test("near-tail sends and normal live-tail appends retain their owners", () => {
    expect(
      resolveChatDataChangeScrollOwner({
        isFollowingLatest: true,
        isStreaming: false,
        postSendPlacementPending: true,
      }),
    ).toBe("custom-follow");
    expect(
      resolveChatDataChangeScrollOwner({
        isFollowingLatest: true,
        isStreaming: true,
        postSendPlacementPending: false,
      }),
    ).toBe("custom-follow");
    expect(
      resolveChatDataChangeScrollOwner({
        isFollowingLatest: true,
        isStreaming: false,
        postSendPlacementPending: false,
      }),
    ).toBe("legend-tail");
  });

  test("wires each owner to one list position writer", () => {
    expect(chatPane).toContain(
      'data: dataChangeScrollOwner === "history-anchor"',
    );
    expect(chatPane).toContain(
      'size: dataChangeScrollOwner === "history-anchor"',
    );
    expect(
      /maintainScrollAtEnd=\{\s*dataChangeScrollOwner === "legend-tail"\s*\? \{/.test(
        chatPane,
      ),
    ).toBe(true);

    const resetBody = chatPane.match(
      /const resetAssistantAutoScroll = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[stopFollowLoop\]\);/,
    )?.[1];
    expect(resetBody !== undefined).toBe(true);
    expect(resetBody?.includes("followArmedRef.current") ?? true).toBe(false);
    expect(resetBody?.includes("followRearmBlockedRef.current") ?? true).toBe(
      false,
    );
  });

  test("keeps bounded-history paging under visible-position anchoring", () => {
    expect(chatPane).toContain("hasOlderHistory?: boolean");
    expect(chatPane).toContain("hasNewerHistory?: boolean");
    expect(chatPane).toContain("onStartReached={() => {");
    expect(chatPane).toContain("void onLoadOlderHistory?.()");
    expect(chatPane).toContain("onEndReached={() => {");
    expect(chatPane).toContain("void onLoadNewerHistory?.()");
    expect(chatPane).toContain(
      "maintainVisibleContentPosition={maintainVisibleContentPosition}",
    );
  });
});

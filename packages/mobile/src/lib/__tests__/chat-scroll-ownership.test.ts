import { describe, expect, test } from "bun:test";
import { resolveChatDataChangeScrollOwner } from "../chat-scroll-ownership";

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

});

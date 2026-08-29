import { afterEach, describe, expect, it } from "vitest";
import {
  assistantScrollFollowKey,
  beginAssistantScrollFollow,
  clearAssistantScrollFollow,
  getAssistantScrollFollowKey,
} from "@/shell/chat-scroll-follow";

describe("assistant scroll follow lifecycle", () => {
  afterEach(() => {
    clearAssistantScrollFollow();
  });

  it("preserves a first-stream key established before accepted-send placement", () => {
    const keyBeforeSend = getAssistantScrollFollowKey();
    const firstStreamKey = assistantScrollFollowKey("run-fast", 1);

    beginAssistantScrollFollow(firstStreamKey);
    clearAssistantScrollFollow(keyBeforeSend);

    expect(getAssistantScrollFollowKey()).toBe(firstStreamKey);
  });

  it("does not clear a replacement key when the pre-send turn had a key", () => {
    const previousKey = assistantScrollFollowKey("run-previous", 1);
    const firstStreamKey = assistantScrollFollowKey("run-fast", 1);
    beginAssistantScrollFollow(previousKey);
    const keyBeforeSend = getAssistantScrollFollowKey();

    beginAssistantScrollFollow(firstStreamKey);
    clearAssistantScrollFollow(keyBeforeSend);

    expect(getAssistantScrollFollowKey()).toBe(firstStreamKey);
  });

  it("clears the captured key before a delayed first stream begins", () => {
    const previousKey = assistantScrollFollowKey("run-previous", 1);
    const firstStreamKey = assistantScrollFollowKey("run-delayed", 1);
    beginAssistantScrollFollow(previousKey);
    const keyBeforeSend = getAssistantScrollFollowKey();

    clearAssistantScrollFollow(keyBeforeSend);
    expect(getAssistantScrollFollowKey()).toBeNull();

    beginAssistantScrollFollow(firstStreamKey);
    expect(getAssistantScrollFollowKey()).toBe(firstStreamKey);
  });
});

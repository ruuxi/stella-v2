// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activitySubscribe: vi.fn(),
  filesSubscribe: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("@/context/chat-store-context", () => ({
  useChatStore: () => ({ isLocalStorage: true }),
}));

vi.mock("@/features/chat/services/local-activity-store", () => ({
  subscribeToLocalActivityWindow: mocks.activitySubscribe,
}));

vi.mock("@/features/chat/services/local-files-store", () => ({
  subscribeToLocalFilesWindow: mocks.filesSubscribe,
}));

vi.mock("@/ui/toast", () => ({ showToast: mocks.showToast }));

import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";

function RetryHarness() {
  useConversationActivity("conversation-1");
  useConversationFiles("conversation-1");
  return null;
}

describe("local cache hook retry policy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    mocks.activitySubscribe.mockReset();
    mocks.filesSubscribe.mockReset();
    mocks.showToast.mockReset();
    mocks.activitySubscribe.mockImplementation(
      (
        _options: unknown,
        listener: (snapshot: {
          window: { activities: [] };
          hasLoaded: false;
          error: Error;
        }) => void,
      ) => {
        listener({
          window: { activities: [] },
          hasLoaded: false,
          error: new Error("activity IPC unavailable"),
        });
        return vi.fn();
      },
    );
    mocks.filesSubscribe.mockImplementation(
      (
        _options: unknown,
        listener: (snapshot: {
          window: { files: [] };
          hasLoaded: false;
          error: Error;
        }) => void,
      ) => {
        listener({
          window: { files: [] },
          hasLoaded: false,
          error: new Error("files IPC unavailable"),
        });
        return vi.fn();
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  test("stops both failing subscriptions after five exponential retries", async () => {
    await act(async () => root.render(<RetryHarness />));

    expect(mocks.activitySubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.filesSubscribe).toHaveBeenCalledTimes(1);

    for (const delay of [300, 600, 1_200, 2_400, 4_800]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }

    expect(mocks.activitySubscribe).toHaveBeenCalledTimes(6);
    expect(mocks.filesSubscribe).toHaveBeenCalledTimes(6);
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "Automatic retries stopped. Reopen this conversation to try again.",
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.activitySubscribe).toHaveBeenCalledTimes(6);
    expect(mocks.filesSubscribe).toHaveBeenCalledTimes(6);
  });
});

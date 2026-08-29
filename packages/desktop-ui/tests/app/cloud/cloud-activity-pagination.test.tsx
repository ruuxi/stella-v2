// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  page: {
    data: [] as unknown[] | undefined,
    status: "success" as "success" | "pending" | "error",
    canLoadMore: false,
    isLoading: false,
    error: undefined as Error | undefined,
    loadMore: vi.fn(),
  },
  mode: {
    cloudMode: true,
    accountScope: "account:owner-a",
    identityRevision: 1,
  },
  running: [] as unknown[],
  lastOptions: null as Record<string, unknown> | null,
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery_experimental: (options: Record<string, unknown>) => {
    mocks.lastOptions = options;
    return mocks.page;
  },
  useQueries: () => ({ running: mocks.running }),
}));

vi.mock("@/global/auth/hooks/use-cloud-mode", () => ({
  useCloudMode: () => mocks.mode,
}));

import type { CloudAgentThread } from "@/features/cloud/cloud-api";
import {
  CLOUD_ACTIVITY_PAGE_SIZE,
  type CloudConversationActivity,
  useCloudConversationActivity,
} from "@/features/cloud/use-cloud-activity";

let latest: CloudConversationActivity | null = null;

const thread = (threadId: string, ownerId: string): CloudAgentThread => ({
  threadId,
  ownerId,
  conversationId: "conversation-1",
  description: threadId,
  placement: "cloud",
  agentType: "general",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
});

function Harness() {
  latest = useCloudConversationActivity("conversation-1");
  return null;
}

describe("cloud Activity pagination hook", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.page.data = [];
    mocks.page.status = "success";
    mocks.page.canLoadMore = false;
    mocks.page.isLoading = false;
    mocks.page.error = undefined;
    mocks.page.loadMore.mockReset();
    mocks.mode.cloudMode = true;
    mocks.mode.accountScope = "account:owner-a";
    mocks.mode.identityRevision = 1;
    mocks.running = [];
    mocks.lastOptions = null;
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async () => {
    await act(async () => root.render(<Harness />));
    expect(latest).not.toBeNull();
    return latest!;
  };

  it("loads one older page and keys the cursor set to the identity revision", async () => {
    mocks.page.data = [thread("thread-1", "owner-a")];
    mocks.page.canLoadMore = true;

    const activity = await render();
    expect(activity.hasLoaded).toBe(true);
    expect(activity.hasOlder).toBe(true);
    expect(activity.isLoadingOlder).toBe(false);

    act(() => activity.loadOlder());
    expect(mocks.page.loadMore).toHaveBeenCalledWith(CLOUD_ACTIVITY_PAGE_SIZE);
    expect(mocks.lastOptions).toMatchObject({
      args: { conversationId: "conversation-1", identityRevision: 1 },
      initialNumItems: CLOUD_ACTIVITY_PAGE_SIZE,
    });
  });

  it("does not request another cursor while a page is loading or exhausted", async () => {
    mocks.page.data = [thread("thread-1", "owner-a")];
    mocks.page.status = "pending";
    mocks.page.isLoading = true;

    let activity = await render();
    expect(activity.hasOlder).toBe(true);
    expect(activity.isLoadingOlder).toBe(true);
    act(() => activity.loadOlder());
    expect(mocks.page.loadMore).not.toHaveBeenCalled();

    mocks.page.status = "success";
    mocks.page.isLoading = false;
    mocks.page.canLoadMore = false;
    activity = await render();
    expect(activity.hasOlder).toBe(false);
    expect(activity.isLoadingOlder).toBe(false);
    act(() => activity.loadOlder());
    expect(mocks.page.loadMore).not.toHaveBeenCalled();
  });

  it("fails closed for a cached page from another account", async () => {
    mocks.page.data = [thread("stale-a", "owner-a")];
    mocks.page.canLoadMore = true;
    mocks.mode.accountScope = "account:owner-b";
    mocks.mode.identityRevision = 2;

    const activity = await render();
    expect(activity.tasks).toEqual([]);
    expect(activity.hasLoaded).toBe(false);
    expect(activity.hasOlder).toBe(false);
    expect(activity.isLoadingOlder).toBe(false);
    act(() => activity.loadOlder());
    expect(mocks.page.loadMore).not.toHaveBeenCalled();
  });

  it("merges an old running row that is outside the newest history page", async () => {
    mocks.page.data = [thread("newer-terminal", "owner-a")];
    mocks.running = [
      {
        ...thread("long-running", "owner-a"),
        status: "running",
        updatedAt: 1,
      },
    ];

    const activity = await render();
    expect(activity.tasks.map((task) => task.id)).toEqual([
      "newer-terminal",
      "long-running",
    ]);
    expect(activity.hasRunning).toBe(true);
  });
});

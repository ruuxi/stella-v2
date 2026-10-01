// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mode: {
    isCloudConversationReady: true,
    accountScope: "account:owner-a",
    ownerSubject: "owner-a",
    identityRevision: 1,
  },
}));

vi.mock("@/platform/backend/backend-client", async () =>
  (await import("../../helpers/fake-backend")).fakeBackendModule(),
);
vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => mocks.mode,
}));

import { fakeBackend } from "../../helpers/fake-backend";
import type { CloudAgentThread } from "@/features/cloud/cloud-api";
import {
  CLOUD_ACTIVITY_PAGE_SIZE,
  type CloudConversationActivity,
  useCloudConversationActivity,
} from "@/features/cloud/use-cloud-activity";

const CONVERSATION = "conversation-1";
let latest: CloudConversationActivity | null = null;

const thread = (threadId: string, ownerId: string): CloudAgentThread => ({
  threadId,
  ownerId,
  conversationId: CONVERSATION,
  description: threadId,
  placement: "cloud",
  agentType: "general",
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
});

const page = (limit: number, threads: CloudAgentThread[], hasMore: boolean) =>
  fakeBackend.emit("agentThreads.forConversation", { conversationId: CONVERSATION, limit }, { threads, hasMore });

const running = (threads: CloudAgentThread[]) =>
  fakeBackend.emit("agentThreads.running", { conversationId: CONVERSATION }, threads);

function Harness() {
  latest = useCloudConversationActivity(CONVERSATION);
  return null;
}

describe("cloud Activity history hook", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    fakeBackend.reset();
    mocks.mode.isCloudConversationReady = true;
    mocks.mode.accountScope = "account:owner-a";
    mocks.mode.ownerSubject = "owner-a";
    mocks.mode.identityRevision = 1;
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
    return latest!;
  };

  it("raises the history window for older threads and keeps showing the current rows meanwhile", async () => {
    await render();
    await act(async () => {
      page(CLOUD_ACTIVITY_PAGE_SIZE, [thread("thread-1", "owner-a")], true);
      running([]);
    });
    let activity = latest!;
    expect(activity.hasLoaded).toBe(true);
    expect(activity.hasOlder).toBe(true);
    expect(activity.isLoadingOlder).toBe(false);

    await act(async () => activity.loadOlder());
    activity = latest!;
    const raised = CLOUD_ACTIVITY_PAGE_SIZE * 2;
    expect(fakeBackend.isSubscribed("agentThreads.forConversation", { conversationId: CONVERSATION, limit: raised })).toBe(true);
    expect(activity.isLoadingOlder).toBe(true);
    expect(activity.tasks.map((task) => task.id)).toEqual(["thread-1"]);

    await act(async () =>
      page(raised, [thread("thread-1", "owner-a"), { ...thread("thread-0", "owner-a"), updatedAt: 1 }], false),
    );
    activity = latest!;
    expect(activity.tasks.map((task) => task.id)).toEqual(["thread-1", "thread-0"]);
    expect(activity.hasOlder).toBe(false);
  });

  it("does not raise the window when there is nothing older", async () => {
    await render();
    await act(async () => {
      page(CLOUD_ACTIVITY_PAGE_SIZE, [thread("thread-1", "owner-a")], false);
      running([]);
    });
    await act(async () => latest!.loadOlder());
    expect(fakeBackend.subscribed()).toEqual([
      `agentThreads.forConversation{"conversationId":"${CONVERSATION}","limit":${CLOUD_ACTIVITY_PAGE_SIZE}}`,
      `agentThreads.running{"conversationId":"${CONVERSATION}"}`,
    ]);
  });

  it("fails closed for rows from another account", async () => {
    mocks.mode.accountScope = "account:owner-b";
    mocks.mode.ownerSubject = "owner-b";
    await render();
    await act(async () => {
      page(CLOUD_ACTIVITY_PAGE_SIZE, [thread("stale-a", "owner-a")], true);
      running([]);
    });
    const activity = latest!;
    expect(activity.tasks).toEqual([]);
    expect(activity.hasLoaded).toBe(false);
    expect(activity.hasOlder).toBe(false);
  });

  it("merges an old running row that is outside the newest history window", async () => {
    await render();
    await act(async () => {
      page(CLOUD_ACTIVITY_PAGE_SIZE, [thread("newer-terminal", "owner-a")], false);
      running([{ ...thread("long-running", "owner-a"), status: "running", updatedAt: 1 }]);
    });
    const activity = latest!;
    expect(activity.tasks.map((task) => task.id)).toEqual(["newer-terminal", "long-running"]);
    expect(activity.hasRunning).toBe(true);
  });
});

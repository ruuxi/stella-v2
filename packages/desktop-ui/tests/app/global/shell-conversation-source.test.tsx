// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@stella/contracts/backend/conversations";

const OWNER = "https://issuer.test|owner-a";
const OTHER_OWNER = "https://issuer.test|owner-b";
const LISTED = "11111111-1111-4111-8111-111111111111";
const ROUTED = "22222222-2222-4222-8222-222222222222";
const CACHED = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({ cachedConversationId: null as string | null }));

vi.mock("@/platform/backend/backend-client", async () =>
  (await import("../../helpers/fake-backend")).fakeBackendModule(),
);
vi.mock("@/features/cloud/cloud-conversation-cache", () => ({
  readActiveCloudConversationIdCache: () => mocks.cachedConversationId,
}));

import { fakeBackend } from "../../helpers/fake-backend";
import { useShellConversationSource } from "@/global/auth/hooks/use-shell-conversation-source";

type Source = ReturnType<typeof useShellConversationSource>;
type Session = Parameters<typeof useShellConversationSource>[0]["session"];

const conversation = (conversationId: string, ownerId = OWNER): ConversationSummary => ({
  ownerId,
  conversationId,
  title: conversationId.slice(0, 4),
  createdAt: 1,
  updatedAt: 2,
});

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({
    isCloudConversationReady: true,
    isLoading: false,
    accountScope: "account:owner-a",
    expectedSubject: "owner-a",
    ownerSubject: OWNER,
    ownerGeneration: "generation-1",
    identityRevision: 3,
    ...overrides,
  }) as Session;

let latest: Source | null = null;
let props: { session: Session; isPrivate: boolean; routeConversationId: string | null };

function Probe() {
  latest = useShellConversationSource(props);
  return null;
}

describe("useShellConversationSource", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => {
    await act(async () => root.render(<Probe />));
  };

  beforeEach(() => {
    fakeBackend.reset();
    mocks.cachedConversationId = null;
    latest = null;
    props = { session: makeSession(), isPrivate: false, routeConversationId: null };
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("subscribes to nothing until the session is ready", async () => {
    props.session = makeSession({ isCloudConversationReady: false, ownerGeneration: null });
    await render();
    expect(fakeBackend.subscribed()).toEqual([]);
    expect(latest?.isCloudConversationReady).toBe(false);
    expect(latest?.cloudConversations).toBeUndefined();
  });

  it("lists the owner's recent conversations with the verified generation", async () => {
    await render();
    expect(fakeBackend.isSubscribed("conversations.recent", {})).toBe(true);
    expect(latest?.cloudConversations).toBeUndefined();
    await act(async () => fakeBackend.emit("conversations.recent", {}, [conversation(LISTED)]));
    expect(latest?.scopedCloudConversations.map((row) => row.conversationId)).toEqual([LISTED]);
    expect(latest?.ownerGeneration).toBe("generation-1");
  });

  it("never exposes rows that belong to another owner", async () => {
    await render();
    await act(async () =>
      fakeBackend.emit("conversations.recent", {}, [conversation(LISTED), conversation(ROUTED, OTHER_OWNER)]),
    );
    expect(latest?.scopedCloudConversations.map((row) => row.conversationId)).toEqual([LISTED]);
  });

  it("looks up a routed conversation that isn't in the recent list", async () => {
    props.routeConversationId = ROUTED;
    await render();
    await act(async () => fakeBackend.emit("conversations.recent", {}, [conversation(LISTED)]));
    expect(fakeBackend.isSubscribed("conversations.get", { conversationId: ROUTED })).toBe(true);
    expect(latest?.exactCloudConversation).toBeUndefined();
    await act(async () =>
      fakeBackend.emit("conversations.get", { conversationId: ROUTED }, conversation(ROUTED)),
    );
    expect(latest?.exactCloudConversation?.conversationId).toBe(ROUTED);
  });

  it("reports a routed conversation the owner doesn't have as null", async () => {
    props.routeConversationId = ROUTED;
    await render();
    await act(async () => fakeBackend.emit("conversations.recent", {}, []));
    await act(async () => fakeBackend.emit("conversations.get", { conversationId: ROUTED }, null));
    expect(latest?.exactCloudConversation).toBeNull();
  });

  it("does not look up a routed conversation that is already listed", async () => {
    props.routeConversationId = LISTED;
    await render();
    await act(async () => fakeBackend.emit("conversations.recent", {}, [conversation(LISTED)]));
    expect(fakeBackend.isSubscribed("conversations.get", { conversationId: LISTED })).toBe(false);
    expect(latest?.routeIsListedOrPendingCloudConversation).toBe(true);
  });

  it("looks up the last-open conversation when it fell out of the list", async () => {
    mocks.cachedConversationId = CACHED;
    await render();
    await act(async () => fakeBackend.emit("conversations.recent", {}, [conversation(LISTED)]));
    expect(latest?.cachedCloudConversationId).toBe(CACHED);
    await act(async () =>
      fakeBackend.emit("conversations.get", { conversationId: CACHED }, conversation(CACHED)),
    );
    expect(latest?.exactCachedCloudConversation?.conversationId).toBe(CACHED);
  });

  it("subscribes to nothing for a private chat", async () => {
    props.isPrivate = true;
    await render();
    expect(fakeBackend.subscribed()).toEqual([]);
    expect(latest?.isCloudConversationReady).toBe(false);
  });
});

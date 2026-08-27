import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  CloudConversationCacheSnapshot,
  CloudConversationCacheVersion,
} from "@stella/contracts/cloud-conversation-cache";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import type { ConversationSocketEvent } from "../../../src/features/cloud/conversation-socket";
import {
  activateCloudConversationClientAuthority,
  conversationStore,
  retireCloudConversationClientAuthority,
  type CloudConversationOutboxAuthority,
  type ConversationStore,
} from "../../../src/features/cloud/conversation-store";
import {
  setCloudConversationCacheApiForTests,
  type CloudConversationCacheRendererApi,
} from "../../../src/features/cloud/cloud-conversation-cache-client";

const stores = new Set<ConversationStore>();

afterEach(() => {
  for (const store of stores) store.retireAuthority();
  stores.clear();
  setCloudConversationCacheApiForTests(undefined);
});

const authority = (suffix: string): CloudConversationOutboxAuthority => ({
  accountScope: `account:cache:${suffix}`,
  ownerGeneration: `generation:cache:${suffix}`,
});

const message = (seq: number, content = `cached-${seq}`): JournalRecord => ({
  kind: "message",
  seq,
  turnId: "turn-cache",
  createdAtMs: seq + 1,
  role: seq % 2 === 0 ? "user" : "assistant",
  hidden: false,
  payload: { content },
});

const ready = (
  conversationId: string,
  epoch: number,
  headSeq: number,
): ConversationSocketEvent => ({
  type: "ready",
  ready: {
    type: "ready",
    protocol: 1,
    conversationId,
    epoch,
    headSeq,
    windowStartSeq: Math.max(0, headSeq - 1),
    floorSeq: 0,
    title: "Canonical title",
    activity: "idle",
    authExpiresAtMs: 3_600_000,
    serverTimeMs: 0,
    live: null,
  },
});

const dispatch = (
  store: ConversationStore,
  event: ConversationSocketEvent,
): void => {
  (
    store as unknown as {
      onEvent: (next: ConversationSocketEvent) => void;
    }
  ).onEvent(event);
};

const fakeApi = (
  snapshot: CloudConversationCacheSnapshot | null,
  replace = vi.fn<CloudConversationCacheRendererApi["replace"]>(
    async (input) => ({
      status: "applied",
      version: {
        epoch: input.epoch,
        headSeq: input.headSeq,
        floorSeq: input.floorSeq,
        revision: (input.expected?.revision ?? 0) + 1,
      },
    }),
  ),
) => {
  const api: CloudConversationCacheRendererApi = {
    retainAccount: vi.fn(async () => ({ purgedConversations: 0 })),
    activateAuthority: vi.fn(async () => ({ purgedConversations: 0 })),
    read: vi.fn(async () => snapshot),
    replace,
    purgeConversation: vi.fn(async () => ({ purgedConversations: 1 })),
  };
  return api;
};

describe("cloud conversation renderer derived cache", () => {
  test("keeps cache stale-labelled until canonical rows replace equal-seq bytes", async () => {
    const exact = authority(crypto.randomUUID());
    const conversationId = `conversation-${crypto.randomUUID()}`;
    const api = fakeApi({
      ...exact,
      conversationId,
      epoch: 4,
      headSeq: 1,
      floorSeq: 0,
      revision: 2,
      title: "Saved title",
      cachedAtMs: 1_000,
      records: [message(0), message(1)],
    });
    setCloudConversationCacheApiForTests(api);
    retireCloudConversationClientAuthority(exact.accountScope);
    activateCloudConversationClientAuthority(exact);
    const store = conversationStore(
      conversationId,
      exact.accountScope,
      exact.ownerGeneration,
    );
    stores.add(store);

    await vi.waitFor(() => {
      expect(store.getSnapshot()).toMatchObject({
        epoch: 4,
        headSeq: 1,
        recordsSource: "cached-stale",
      });
    });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      0, 1,
    ]);
    // Cache cannot deliver privileged behavior when no canonical socket exists.
    expect(store.cancelTurn("turn-cache")).toBe(false);

    dispatch(store, ready(conversationId, 4, 1));
    expect(store.getSnapshot().recordsSource).toBe("cached-stale");
    dispatch(store, {
      type: "records",
      records: [message(0, "canonical-0"), message(1, "canonical-1")],
    });
    expect(store.getSnapshot()).toMatchObject({
      recordsSource: "canonical",
      records: [
        { seq: 0, payload: { content: "canonical-0" } },
        { seq: 1, payload: { content: "canonical-1" } },
      ],
    });
    dispatch(store, {
      type: "status",
      status: "offline",
      message: "Reconnecting…",
      retryable: true,
    });
    expect(store.getSnapshot().recordsSource).toBe("cached-stale");
  });

  test("drops and purges a cached epoch before a replacement canonical window paints", async () => {
    const exact = authority(crypto.randomUUID());
    const conversationId = `conversation-${crypto.randomUUID()}`;
    const api = fakeApi({
      ...exact,
      conversationId,
      epoch: 1,
      headSeq: 1,
      floorSeq: 0,
      revision: 1,
      title: "Old epoch",
      cachedAtMs: 1_000,
      records: [message(0), message(1)],
    });
    setCloudConversationCacheApiForTests(api);
    retireCloudConversationClientAuthority(exact.accountScope);
    activateCloudConversationClientAuthority(exact);
    const store = conversationStore(
      conversationId,
      exact.accountScope,
      exact.ownerGeneration,
    );
    stores.add(store);
    await vi.waitFor(() =>
      expect(store.getSnapshot().recordsSource).toBe("cached-stale"),
    );

    dispatch(store, ready(conversationId, 2, 0));
    expect(store.getSnapshot()).toMatchObject({
      epoch: 2,
      headSeq: 0,
      records: [],
      recordsSource: "none",
    });
    await vi.waitFor(() => expect(api.purgeConversation).toHaveBeenCalled());

    dispatch(store, { type: "records", records: [message(0)] });
    expect(store.getSnapshot()).toMatchObject({
      recordsSource: "canonical",
      records: [message(0)],
    });
  });

  test("a canonical ready that beats disk hydration cannot be rewound by a late old epoch", async () => {
    const exact = authority(crypto.randomUUID());
    const conversationId = `conversation-${crypto.randomUUID()}`;
    let resolveRead!: (value: CloudConversationCacheSnapshot | null) => void;
    const delayedRead = new Promise<CloudConversationCacheSnapshot | null>(
      (resolve) => {
        resolveRead = resolve;
      },
    );
    const api = fakeApi(null);
    vi.mocked(api.read).mockImplementation(async () => await delayedRead);
    setCloudConversationCacheApiForTests(api);
    retireCloudConversationClientAuthority(exact.accountScope);
    activateCloudConversationClientAuthority(exact);
    const store = conversationStore(
      conversationId,
      exact.accountScope,
      exact.ownerGeneration,
    );
    stores.add(store);
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());

    dispatch(store, ready(conversationId, 2, 0));
    resolveRead({
      ...exact,
      conversationId,
      epoch: 1,
      headSeq: 0,
      floorSeq: 0,
      revision: 1,
      title: "Old disk title",
      cachedAtMs: 1,
      records: [message(0)],
    });

    await vi.waitFor(() => expect(api.purgeConversation).toHaveBeenCalled());
    expect(store.getSnapshot()).toMatchObject({
      epoch: 2,
      title: "Canonical title",
      records: [],
      recordsSource: "none",
    });
  });

  test("recovers a deleted cache through canonical records and one null-CAS retry", async () => {
    const exact = authority(crypto.randomUUID());
    const conversationId = `conversation-${crypto.randomUUID()}`;
    const currentVersion: CloudConversationCacheVersion = {
      epoch: 8,
      headSeq: 0,
      floorSeq: 0,
      revision: 3,
    };
    const replace = vi
      .fn<CloudConversationCacheRendererApi["replace"]>()
      .mockResolvedValueOnce({ status: "conflict", current: null })
      .mockImplementation(async (input) => ({
        status: "applied",
        version: {
          epoch: input.epoch,
          headSeq: input.headSeq,
          floorSeq: input.floorSeq,
          revision: 1,
        },
      }));
    const api = fakeApi(null, replace);
    setCloudConversationCacheApiForTests(api);
    retireCloudConversationClientAuthority(exact.accountScope);
    activateCloudConversationClientAuthority(exact);
    const store = conversationStore(
      conversationId,
      exact.accountScope,
      exact.ownerGeneration,
    );
    stores.add(store);
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());

    // Simulate an older in-process CAS token whose SQLite file disappeared.
    (
      store as unknown as { cacheVersion: CloudConversationCacheVersion }
    ).cacheVersion = currentVersion;
    dispatch(store, ready(conversationId, 8, 0));
    dispatch(store, { type: "records", records: [message(0)] });

    await vi.waitFor(
      () => {
        expect(replace).toHaveBeenCalledTimes(2);
        expect(replace.mock.calls[0]![0].expected).toEqual(currentVersion);
        expect(replace.mock.calls[1]![0].expected).toBeNull();
      },
      { timeout: 1_000 },
    );
  });

  test("does not adopt another writer's non-null epoch/revision conflict", async () => {
    const exact = authority(crypto.randomUUID());
    const conversationId = `conversation-${crypto.randomUUID()}`;
    const staleVersion: CloudConversationCacheVersion = {
      epoch: 8,
      headSeq: 0,
      floorSeq: 0,
      revision: 3,
    };
    const successorVersion: CloudConversationCacheVersion = {
      epoch: 9,
      headSeq: 0,
      floorSeq: 0,
      revision: 4,
    };
    const replace = vi.fn<CloudConversationCacheRendererApi["replace"]>(
      async () => ({ status: "conflict", current: successorVersion }),
    );
    const api = fakeApi(null, replace);
    setCloudConversationCacheApiForTests(api);
    retireCloudConversationClientAuthority(exact.accountScope);
    activateCloudConversationClientAuthority(exact);
    const store = conversationStore(
      conversationId,
      exact.accountScope,
      exact.ownerGeneration,
    );
    stores.add(store);
    await vi.waitFor(() => expect(api.read).toHaveBeenCalled());

    (
      store as unknown as { cacheVersion: CloudConversationCacheVersion }
    ).cacheVersion = staleVersion;
    dispatch(store, ready(conversationId, 8, 0));
    dispatch(store, {
      type: "records",
      records: [message(0, "stale-epoch-record")],
    });

    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]![0].expected).toEqual(staleVersion);
  });

  test("a delayed old-generation hydration cannot repaint its successor", async () => {
    const accountScope = `account:cache:${crypto.randomUUID()}`;
    const oldAuthority = {
      accountScope,
      ownerGeneration: "generation:old",
    };
    const nextAuthority = {
      accountScope,
      ownerGeneration: "generation:new",
    };
    const conversationId = `conversation-${crypto.randomUUID()}`;
    let resolveOld!: (value: CloudConversationCacheSnapshot | null) => void;
    const oldRead = new Promise<CloudConversationCacheSnapshot | null>(
      (resolve) => {
        resolveOld = resolve;
      },
    );
    const api = fakeApi(null);
    vi.mocked(api.read).mockImplementation(async (request) =>
      request.ownerGeneration === oldAuthority.ownerGeneration
        ? await oldRead
        : null,
    );
    setCloudConversationCacheApiForTests(api);

    retireCloudConversationClientAuthority(accountScope);
    activateCloudConversationClientAuthority(oldAuthority);
    const oldStore = conversationStore(
      conversationId,
      accountScope,
      oldAuthority.ownerGeneration,
    );
    stores.add(oldStore);
    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));

    activateCloudConversationClientAuthority(nextAuthority);
    const nextStore = conversationStore(
      conversationId,
      accountScope,
      nextAuthority.ownerGeneration,
    );
    stores.add(nextStore);
    resolveOld({
      ...oldAuthority,
      conversationId,
      epoch: 1,
      headSeq: 0,
      floorSeq: 0,
      revision: 1,
      title: "Old",
      cachedAtMs: 1,
      records: [message(0)],
    });

    await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(oldStore.getSnapshot().records).toEqual([]);
    expect(nextStore.getSnapshot().records).toEqual([]);
  });
});

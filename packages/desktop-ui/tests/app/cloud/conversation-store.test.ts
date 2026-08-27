import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import type { ConversationSocketEvent } from "../../../src/features/cloud/conversation-socket";
import {
  activateCloudConversationClientAuthority,
  conversationStore,
  pendingPrompts,
  retireCloudConversationClientAuthority,
} from "../../../src/features/cloud/conversation-store";
import {
  cloudConversationOutbox,
  setCloudConversationOutboxStorageForTests,
  type CloudConversationOutboxAuthority,
  type CloudConversationOutboxStorage,
} from "../../../src/features/cloud/conversation-outbox";

class MemoryStorage implements CloudConversationOutboxStorage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const TEST_AUTHORITY: CloudConversationOutboxAuthority = {
  accountScope: "account:store-outbox",
  ownerGeneration: "generation-store-outbox",
};

const submission = (requestedConversationId: string | null) => ({
  requestedConversationId,
  prompt: "reliable prompt",
  imagePaths: [] as string[],
  attachments: [],
  locale: null,
  execution: null,
});

let outboxStorage: MemoryStorage;

beforeEach(() => {
  outboxStorage = new MemoryStorage();
  setCloudConversationOutboxStorageForTests(outboxStorage);
  retireCloudConversationClientAuthority(TEST_AUTHORITY.accountScope);
  activateCloudConversationClientAuthority(TEST_AUTHORITY);
});

afterEach(() => {
  for (const entry of pendingPrompts.getSnapshot()) {
    pendingPrompts.drop(
      {
        accountScope: entry.accountScope,
        ownerGeneration: entry.ownerGeneration,
      },
      entry.clientMsgId,
    );
  }
  setCloudConversationOutboxStorageForTests(undefined);
});

const message = (seq: number, role: "user" | "assistant"): JournalRecord => ({
  kind: "message",
  seq,
  turnId: "turn-store",
  createdAtMs: seq,
  role,
  hidden: false,
  payload: { role, content: String(seq) },
});

const skipped = (seq: number): JournalRecord => ({
  kind: "skipped",
  seq,
  turnId: "turn-store",
  createdAtMs: seq,
  originalKind: "future-record-kind",
});

const ready = (epoch: number, headSeq: number): ConversationSocketEvent => ({
  type: "ready",
  ready: {
    type: "ready",
    protocol: 1,
    conversationId: "store-test",
    epoch,
    headSeq,
    windowStartSeq: Math.max(0, headSeq),
    floorSeq: 0,
    title: "Store test",
    activity: "idle",
    authExpiresAtMs: 3_600_000,
    serverTimeMs: 0,
    live: null,
  },
});

const dispatch = (
  store: ReturnType<typeof conversationStore>,
  event: ConversationSocketEvent,
): void => {
  // Exercise the reducer boundary directly; socket lifecycle/auth are covered
  // separately and the store intentionally keeps this method private.
  (
    store as unknown as {
      onEvent: (next: ConversationSocketEvent) => void;
    }
  ).onEvent(event);
};

describe("cloud conversation store opaque records", () => {
  test("retains visible rows across a skipped sequence", () => {
    const store = conversationStore(
      `opaque-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, { type: "records", records: [message(1, "user")] });
    dispatch(store, {
      type: "records",
      records: [skipped(2), message(3, "assistant")],
    });

    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(store.getSnapshot().headSeq).toBe(3);
  });

  test("an opaque-only older page remains a paging anchor", () => {
    const store = conversationStore(
      `opaque-older-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, { type: "records", records: [message(100, "user")] });
    dispatch(store, { type: "older", records: [skipped(50)] });

    expect(store.getSnapshot()).toMatchObject({
      hasOlder: true,
      loadingOlder: false,
    });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      50, 100,
    ]);
  });

  test("never reuses a same-id store across auth subjects", () => {
    const conversationId = `same-id-${crypto.randomUUID()}`;
    const prior = conversationStore(conversationId, "anonymous:prior");
    const current = conversationStore(conversationId, "account:current");
    dispatch(prior, { type: "records", records: [message(1, "user")] });

    expect(current).not.toBe(prior);
    expect(current.getSnapshot().records).toEqual([]);

    retireCloudConversationClientAuthority("account:current");
    expect(prior.getSnapshot().records).toEqual([]);
    expect(conversationStore(conversationId, "account:current")).toBe(current);
  });

  test("replaces retained renderer rows when a replacement socket reports a new epoch", () => {
    const store = conversationStore(
      `epoch-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, ready(1, 2));
    dispatch(store, {
      type: "records",
      records: [message(1, "user"), message(2, "assistant")],
    });

    dispatch(store, ready(2, 0));
    expect(store.getSnapshot()).toMatchObject({
      epoch: 2,
      headSeq: 0,
      records: [],
      live: null,
    });

    dispatch(store, { type: "records", records: [message(0, "user")] });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      0,
    ]);
  });

  test("names an incomplete older archive page without splicing a hole", () => {
    const store = conversationStore(
      `older-incomplete-${crypto.randomUUID()}`,
      "account:test-owner",
    );
    dispatch(store, ready(1, 100));
    dispatch(store, { type: "records", records: [message(100, "user")] });
    dispatch(store, {
      type: "older",
      records: [],
      complete: false,
      fromSeq: 50,
      toSeq: 99,
    });

    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual([
      100,
    ]);
    expect(store.getSnapshot()).toMatchObject({
      hasOlder: true,
      loadingOlder: false,
      olderNotice: "Couldn't load that part of this conversation. Try again.",
    });

    dispatch(store, {
      type: "older",
      records: Array.from({ length: 50 }, (_, index) =>
        message(50 + index, index % 2 === 0 ? "user" : "assistant"),
      ),
      complete: true,
      fromSeq: 50,
      toSeq: 99,
    });
    expect(store.getSnapshot()).toMatchObject({
      loadingOlder: false,
      olderNotice: null,
    });
    expect(store.getSnapshot().records.map((record) => record.seq)).toEqual(
      Array.from({ length: 51 }, (_, index) => 50 + index),
    );
  });
});

describe("cloud conversation outbox authority", () => {
  test("acks durable delivery on exact admission but keeps UI until journal", () => {
    const clientMsgId = "client:admission-ack";
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "reliable prompt",
      null,
      submission(null),
    );
    expect(cloudConversationOutbox.list()).toHaveLength(1);

    pendingPrompts.bind(
      TEST_AUTHORITY,
      clientMsgId,
      "conversation-created",
      "turn-created",
    );
    expect(
      pendingPrompts.acknowledgeAdmission(
        TEST_AUTHORITY,
        clientMsgId,
        "conversation-created",
        "turn-created",
      ),
    ).toBe(true);
    expect(cloudConversationOutbox.list()).toEqual([]);
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toMatchObject({
      durable: false,
      deliveryAcknowledged: true,
      conversationId: "conversation-created",
      turnId: "turn-created",
      submission: { requestedConversationId: null },
    });

    pendingPrompts.resolve(TEST_AUTHORITY, {
      kind: "turn",
      seq: 1,
      turnId: "turn-created",
      createdAtMs: 1,
      phase: "completed",
    });
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toBeNull();
  });

  test("keeps cancel_pending durable and a terminal dispatch can acknowledge it", () => {
    const clientMsgId = "client:cancel-terminal";
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "reliable prompt",
      "conversation-cancel",
      submission("conversation-cancel"),
    );
    pendingPrompts.bindDispatch(
      TEST_AUTHORITY,
      clientMsgId,
      "exec:cancel-terminal",
    );
    pendingPrompts.requestCancel(TEST_AUTHORITY, clientMsgId);

    // A cancel_pending response performs no acknowledgement call.
    expect(cloudConversationOutbox.list()).toHaveLength(1);
    expect(
      pendingPrompts.acknowledgeTerminal(
        TEST_AUTHORITY,
        clientMsgId,
        "exec:cancel-terminal",
      ),
    ).toBe(true);
    expect(cloudConversationOutbox.list()).toEqual([]);
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toMatchObject({
      cancelRequested: true,
      deliveryAcknowledged: true,
    });
  });

  test("same-authority activation preserves the one in-flight replay claim", () => {
    const clientMsgId = "client:strict-mode";
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "reliable prompt",
      "conversation-strict",
      submission("conversation-strict"),
    );
    expect(pendingPrompts.claimDispatch(TEST_AUTHORITY, clientMsgId)).toBe(
      true,
    );
    expect(activateCloudConversationClientAuthority(TEST_AUTHORITY)).toBe(true);
    expect(pendingPrompts.claimDispatch(TEST_AUTHORITY, clientMsgId)).toBe(
      false,
    );
    pendingPrompts.releaseDispatch(TEST_AUTHORITY, clientMsgId);
  });

  test("an old-generation callback cannot ack or repopulate its successor", () => {
    const clientMsgId = "client:generation-fence";
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "old generation",
      "conversation-generation",
      submission("conversation-generation"),
    );
    const successor = {
      accountScope: TEST_AUTHORITY.accountScope,
      ownerGeneration: "generation-successor",
    };
    expect(activateCloudConversationClientAuthority(successor)).toBe(true);
    pendingPrompts.add(
      successor,
      clientMsgId,
      "successor generation",
      "conversation-generation",
      {
        ...submission("conversation-generation"),
        prompt: "successor generation",
      },
    );

    pendingPrompts.bind(
      TEST_AUTHORITY,
      clientMsgId,
      "conversation-generation",
      "turn-old",
    );
    pendingPrompts.resolve(TEST_AUTHORITY, {
      kind: "message",
      seq: 1,
      turnId: "turn-old",
      createdAtMs: 1,
      role: "user",
      hidden: false,
      clientMsgId,
      payload: { content: "old generation" },
    });

    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toBeNull();
    expect(pendingPrompts.find(successor, clientMsgId)).toMatchObject({
      ownerGeneration: successor.ownerGeneration,
      text: "successor generation",
      durable: true,
    });
    expect(cloudConversationOutbox.list()).toHaveLength(1);
  });

  test("ambiguous transport failure replays once only after fresh activation", () => {
    const clientMsgId = "client:ambiguous-reload";
    pendingPrompts.add(
      TEST_AUTHORITY,
      clientMsgId,
      "ambiguous prompt",
      "conversation-ambiguous",
      submission("conversation-ambiguous"),
    );
    pendingPrompts.fail(TEST_AUTHORITY, clientMsgId, "Failed to fetch", true);
    expect(activateCloudConversationClientAuthority(TEST_AUTHORITY)).toBe(true);
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)?.error).toBe(
      "Failed to fetch",
    );

    retireCloudConversationClientAuthority(TEST_AUTHORITY.accountScope);
    expect(activateCloudConversationClientAuthority(TEST_AUTHORITY)).toBe(true);
    expect(pendingPrompts.find(TEST_AUTHORITY, clientMsgId)).toMatchObject({
      error: null,
      retryOnNextActivation: false,
      durable: true,
    });
    expect(pendingPrompts.claimDispatch(TEST_AUTHORITY, clientMsgId)).toBe(
      true,
    );
    expect(pendingPrompts.claimDispatch(TEST_AUTHORITY, clientMsgId)).toBe(
      false,
    );
    pendingPrompts.releaseDispatch(TEST_AUTHORITY, clientMsgId);
  });
});

import { describe, expect, test } from "vitest";
import {
  cloudConversationOutboxStorageKey,
  createCloudConversationOutbox,
  type CloudConversationOutboxAuthority,
  type CloudConversationOutboxStorage,
  type PendingPrompt,
} from "../../../src/features/cloud/conversation-outbox";

class MemoryStorage implements CloudConversationOutboxStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

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
    if (this.failWrites) throw new Error("disk unavailable");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("disk unavailable");
    this.values.delete(key);
  }
}

const authority = (
  accountScope: string,
  ownerGeneration: string,
): CloudConversationOutboxAuthority => ({ accountScope, ownerGeneration });

const entry = (
  args: {
    accountScope?: string;
    ownerGeneration?: string;
    clientMsgId?: string;
    requestedConversationId?: string | null;
    prompt?: string;
  } = {},
): PendingPrompt => ({
  accountScope: args.accountScope ?? "account:alpha",
  ownerGeneration: args.ownerGeneration ?? "generation-alpha",
  clientMsgId: args.clientMsgId ?? "client:alpha-1",
  text: args.prompt ?? "send exactly once",
  createdAtMs: 100,
  conversationId:
    args.requestedConversationId === undefined
      ? "conversation-alpha"
      : args.requestedConversationId,
  turnId: null,
  dispatchId: null,
  cancelRequested: false,
  error: null,
  retryOnNextActivation: false,
  durable: false,
  deliveryAcknowledged: false,
  submission: {
    requestedConversationId:
      args.requestedConversationId === undefined
        ? "conversation-alpha"
        : args.requestedConversationId,
    prompt: args.prompt ?? "send exactly once",
    imagePaths: [],
    attachments: [],
    locale: null,
    execution: null,
  },
});

describe("cloud conversation durable outbox", () => {
  test("commits the frozen account+generation+conversation payload before network", () => {
    const storage = new MemoryStorage();
    const outbox = createCloudConversationOutbox(() => storage);
    const pending = entry();
    let networkCalls = 0;

    const dispatch = () => {
      outbox.enqueue(pending);
      networkCalls += 1;
    };
    storage.failWrites = true;
    expect(dispatch).toThrow("disk unavailable");
    expect(networkCalls).toBe(0);

    storage.failWrites = false;
    dispatch();
    expect(networkCalls).toBe(1);
    expect([...storage.values.keys()]).toEqual([
      cloudConversationOutboxStorageKey(pending),
    ]);
    expect([...storage.values.keys()][0]).toContain(
      "account%3Aalpha/generation-alpha/id-conversation-alpha/client:alpha-1",
    );
  });

  test("survives a process reload and collapses an exact frozen replay", () => {
    const storage = new MemoryStorage();
    const firstProcess = createCloudConversationOutbox(() => storage);
    const pending = entry({ requestedConversationId: null });
    const committed = firstProcess.enqueue(pending);

    const secondProcess = createCloudConversationOutbox(() => storage);
    const hydrated = secondProcess.activate(
      authority(pending.accountScope, pending.ownerGeneration),
    );
    expect(hydrated).toEqual([committed]);
    expect(hydrated[0]?.submission.requestedConversationId).toBeNull();
    expect(secondProcess.enqueue({ ...pending, createdAtMs: 999 })).toEqual(
      committed,
    );
    expect(secondProcess.list()).toHaveLength(1);
  });

  test("rejects changed payload or conversation reuse of one scoped client id", () => {
    const storage = new MemoryStorage();
    const outbox = createCloudConversationOutbox(() => storage);
    const original = entry();
    outbox.enqueue(original);

    expect(() => outbox.enqueue(entry({ prompt: "changed payload" }))).toThrow(
      "already bound to a different request",
    );
    expect(() =>
      outbox.enqueue(entry({ requestedConversationId: "conversation-other" })),
    ).toThrow("already bound to a different request");
    expect(outbox.list()).toHaveLength(1);
  });

  test("fails closed when two tabs leave same-authority collision keys", () => {
    const storage = new MemoryStorage();
    const outbox = createCloudConversationOutbox(() => storage);
    const original = entry();
    outbox.enqueue(original);
    const originalRaw = storage.getItem(
      cloudConversationOutboxStorageKey(original),
    );
    expect(originalRaw).not.toBeNull();
    const conflicting = entry({
      requestedConversationId: "conversation-other",
    });
    const conflictingEnvelope = JSON.parse(originalRaw!) as {
      entry: PendingPrompt;
    };
    conflictingEnvelope.entry.conversationId = "conversation-other";
    conflictingEnvelope.entry.submission.requestedConversationId =
      "conversation-other";
    storage.setItem(
      cloudConversationOutboxStorageKey(conflicting),
      JSON.stringify(conflictingEnvelope),
    );

    expect(() =>
      outbox.activate(
        authority(original.accountScope, original.ownerGeneration),
      ),
    ).toThrow("conflicting prior deliveries");
  });

  test("purges A to B to A and same-account generation rotations", () => {
    const storage = new MemoryStorage();
    const outbox = createCloudConversationOutbox(() => storage);
    const alpha = entry();
    outbox.enqueue(alpha);

    const betaAuthority = authority("account:beta", "generation-beta");
    expect(outbox.activate(betaAuthority)).toEqual([]);
    expect(outbox.list()).toEqual([]);
    outbox.enqueue(
      entry({
        accountScope: betaAuthority.accountScope,
        ownerGeneration: betaAuthority.ownerGeneration,
        clientMsgId: "client:beta-1",
      }),
    );
    expect(
      outbox.activate(authority(alpha.accountScope, alpha.ownerGeneration)),
    ).toEqual([]);
    expect(outbox.list()).toEqual([]);

    const oldGeneration = entry({ clientMsgId: "client:old-gen" });
    outbox.enqueue(oldGeneration);
    expect(
      outbox.activate(authority(oldGeneration.accountScope, "generation-next")),
    ).toEqual([]);
    expect(outbox.list()).toEqual([]);
  });
});

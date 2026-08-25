import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../types";
import {
  createSerializedChatPersistenceQueue,
  enqueueSerializedChatPersistence,
  persistBoundedTranscriptMerge,
} from "../chat-persistence-policy";

describe("authoritative desktop transcript persistence", () => {
  test("serializes sync, debounce, and reconcile without regressing rows", async () => {
    const mergeQueue = createSerializedChatPersistenceQueue();
    const durableQueue = createSerializedChatPersistenceQueue();
    let current: ChatMessage[] = [
      { id: "local-u", role: "user", text: "question", createdAt: 1 },
      { id: "local-a", role: "assistant", text: "partial", createdAt: 2 },
    ];
    let pending: ChatMessage[] | null = current;
    const durable = new Map(current.map((message) => [message.id, message]));
    let releaseFirstSave!: () => void;
    const firstSaveBlocked = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const saveChanged = (messages: ChatMessage[]) =>
      enqueueSerializedChatPersistence(durableQueue, async () => {
        saveCalls += 1;
        if (saveCalls === 1) await firstSaveBlocked;
        for (const message of messages) durable.set(message.id, message);
      });
    const persist = (merge: (messages: ChatMessage[]) => ChatMessage[]) =>
      enqueueSerializedChatPersistence(mergeQueue, () =>
        persistBoundedTranscriptMerge({
          getCurrent: () => current,
          setCurrent: (messages) => {
            current = messages;
          },
          getPending: () => pending,
          setPending: (messages) => {
            pending = messages;
          },
          merge,
          maxLoaded: 480,
          saveChanged,
        }),
      );

    const sync = persist((messages) =>
      messages.map((message) =>
        message.id === "local-u"
          ? { ...message, canonicalId: "desktop-u" }
          : message,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(current[0]?.canonicalId).toBe("desktop-u");

    // The delayed snapshot observes the synchronously published canonical
    // merge, then queues behind its in-flight incremental write.
    const debouncedSnapshot = pending!;
    const debounce = saveChanged(debouncedSnapshot);
    const reconcile = persist((messages) =>
      messages.map((message) =>
        message.id === "local-a"
          ? {
              ...message,
              canonicalId: "desktop-a",
              requestId: "desktop-u",
              text: "final answer",
            }
          : message,
      ),
    );

    releaseFirstSave();
    await Promise.all([sync, debounce, reconcile]);

    expect(current.map((message) => message.id)).toEqual([
      "local-u",
      "local-a",
    ]);
    expect(current[0]?.canonicalId).toBe("desktop-u");
    expect(current[1]).toMatchObject({
      canonicalId: "desktop-a",
      requestId: "desktop-u",
      text: "final answer",
    });
    expect(pending).toBe(current);
    expect(durable.get("local-u")?.canonicalId).toBe("desktop-u");
    expect(durable.get("local-a")).toMatchObject({
      canonicalId: "desktop-a",
      text: "final answer",
    });
  });

  test("re-merges a local update accepted while authoritative durability is blocked", async () => {
    const original: ChatMessage = {
      id: "existing",
      role: "assistant",
      text: "existing",
      createdAt: 1,
    };
    const remote: ChatMessage = {
      id: "remote",
      role: "assistant",
      text: "remote",
      createdAt: 2,
    };
    const optimistic: ChatMessage = {
      id: "optimistic",
      role: "user",
      text: "new send",
      createdAt: 3,
    };
    let current = [original];
    let pending: ChatMessage[] | null = current;
    let releaseSave!: () => void;
    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const run = persistBoundedTranscriptMerge({
      getCurrent: () => current,
      setCurrent: (messages) => {
        current = messages;
      },
      getPending: () => pending,
      setPending: (messages) => {
        pending = messages;
      },
      merge: (messages) =>
        messages.some((message) => message.id === remote.id)
          ? messages
          : [...messages, remote],
      maxLoaded: 480,
      saveChanged: () => saveBlocked,
    });

    await Promise.resolve();
    expect(current.map((message) => message.id)).toEqual([
      "existing",
      "remote",
    ]);
    current = [...current, optimistic];
    pending = current;
    releaseSave();

    const persisted = await run;
    expect(persisted.messages.map((message) => message.id)).toEqual([
      "existing",
      "remote",
      "optimistic",
    ]);
    expect(current).toBe(persisted.messages);
    expect(pending).toBe(persisted.messages);
  });

  test("does not republish a merge invalidated while durability is blocked", async () => {
    const local: ChatMessage = {
      id: "local",
      role: "assistant",
      text: "local",
      createdAt: 1,
    };
    const remote: ChatMessage = {
      id: "remote",
      role: "assistant",
      text: "remote",
      createdAt: 2,
    };
    let current = [local];
    let pending: ChatMessage[] | null = null;
    let generation = 0;
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    const persisted = persistBoundedTranscriptMerge({
      getCurrent: () => current,
      setCurrent: (messages) => {
        current = messages;
      },
      getPending: () => pending,
      setPending: (messages) => {
        pending = messages;
      },
      merge: (messages) => [...messages, remote],
      maxLoaded: 10,
      saveChanged: () => saveGate,
      isCurrent: () => generation === 0,
    });
    await Promise.resolve();
    generation += 1;
    current = [];
    pending = null;
    releaseSave();

    expect(await persisted).toEqual({ messages: [], droppedOlder: false });
    expect(current).toEqual([]);
    expect(pending).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDesktopDatabase } from "../storage/database-init.js";
import { RuntimeStore } from "../storage/runtime-store.js";
import type { SqliteDatabase } from "../storage/shared.js";
import { createLegacyChatCloudImporter } from "./legacy-chat-cloud-import.js";
import {
  CloudTranscriptAlreadyAdmittedError,
  type CloudTranscriptBeginRequest,
  type CloudTranscriptFinishRequest,
} from "./cloud-transcript-write.js";

const openedStores: Array<{
  database: Database;
  store: RuntimeStore;
}> = [];

const openStore = () => {
  const database = new Database(":memory:");
  initializeDesktopDatabase(database as unknown as SqliteDatabase);
  const opened = {
    database,
    store: new RuntimeStore(database as unknown as SqliteDatabase),
  };
  openedStores.push(opened);
  return opened;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for import.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

afterEach(() => {
  while (openedStores.length) openedStores.pop()?.database.close();
});

describe("legacy chat cloud import", () => {
  test("imports local turns once and leaves the SQLite transcript intact", async () => {
    const { store } = openStore();
    const localConversationId = "01JLEGACYLOCALCONVERSATION1";
    store.appendEvent({
      conversationId: localConversationId,
      eventId: "user-1",
      type: "user_message",
      timestamp: 1,
      payload: { text: "First question" },
    });
    store.appendEvent({
      conversationId: localConversationId,
      eventId: "assistant-1",
      type: "assistant_message",
      timestamp: 2,
      payload: { text: "First answer" },
    });
    store.appendEvent({
      conversationId: localConversationId,
      eventId: "user-2",
      type: "user_message",
      timestamp: 3,
      payload: { text: "Second question" },
    });

    const begins: CloudTranscriptBeginRequest[] = [];
    const finishes: CloudTranscriptFinishRequest[] = [];
    let creates = 0;
    const importer = createLegacyChatCloudImporter({
      deviceId: "device-1",
      store,
      hasAuthToken: () => true,
      cloud: {
        getOwnershipMigrationStatus: async () => null,
        getConversation: async () => null,
        createConversation: async () => {
          creates += 1;
          return { conversationId: "cloud-conversation-1" };
        },
      },
      cloudTranscript: {
        begin: async (request) => {
          begins.push(request);
          return {
            turnId: `turn-${begins.length}`,
            leaseToken: `lease-${begins.length}`,
            history: [],
          };
        },
        finish: async (request) => {
          finishes.push(request);
          return { queued: true };
        },
      },
    });
    importer.resume();
    await waitFor(
      () =>
        store.getLegacyChatCloudImport(localConversationId)?.status ===
        "complete",
    );

    expect(creates).toBe(1);
    expect(begins).toHaveLength(2);
    expect(
      begins.map((begin) => JSON.parse(begin.userMessageJson).content[0].text),
    ).toEqual(["First question", "Second question"]);
    expect(begins[0]?.recovery).toMatchObject({
      kind: "precomputed-finish",
      phase: "completed",
    });
    expect(
      finishes[0]?.records.map((record) => ({
        role: record.role,
        text: JSON.parse(record.payloadJson).content[0].text,
      })),
    ).toEqual([{ role: "assistant", text: "First answer" }]);
    expect(finishes[1]?.records).toEqual([]);
    expect(
      store.listLegacyChatVisibleMessages(localConversationId),
    ).toHaveLength(3);

    importer.resume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(creates).toBe(1);
    expect(begins).toHaveLength(2);
    importer.stop();
  });

  test("does not resurrect a cloud-shaped SQLite cache", async () => {
    const { store } = openStore();
    const cachedCloudConversationId = "b5835d4b-6f1c-4ab2-97e6-5c9daf4c1820";
    store.appendEvent({
      conversationId: cachedCloudConversationId,
      eventId: "cached-user",
      type: "user_message",
      payload: { text: "Cached cloud prompt" },
    });
    let creates = 0;
    let begins = 0;
    const importer = createLegacyChatCloudImporter({
      deviceId: "device-1",
      store,
      hasAuthToken: () => true,
      cloud: {
        getOwnershipMigrationStatus: async () => null,
        getConversation: async () => null,
        createConversation: async () => {
          creates += 1;
          return { conversationId: "should-not-exist" };
        },
      },
      cloudTranscript: {
        begin: async () => {
          begins += 1;
          throw new Error("should not begin");
        },
        finish: async () => ({ queued: true }),
      },
    });
    importer.resume();
    await waitFor(
      () =>
        store.getLegacyChatCloudImport(cachedCloudConversationId)?.status ===
        "skipped",
    );
    expect(creates).toBe(0);
    expect(begins).toBe(0);
    expect(
      store.getLegacyChatCloudImport(cachedCloudConversationId)?.detail,
    ).toBe("cloud-shaped-local-cache");
    expect(
      store.listLegacyChatVisibleMessages(cachedCloudConversationId),
    ).toHaveLength(1);
    importer.stop();
  });

  test("restart reconciles an admitted turn without duplicating cloud or local history", async () => {
    const { store } = openStore();
    const localConversationId = "01JLEGACYCRASHRECOVERY001";
    store.appendEvent({
      conversationId: localConversationId,
      eventId: "crash-user",
      type: "user_message",
      timestamp: 10,
      payload: { text: "Question before crash" },
    });
    store.appendEvent({
      conversationId: localConversationId,
      eventId: "crash-assistant",
      type: "assistant_message",
      timestamp: 11,
      payload: { text: "Answer before crash" },
    });

    const beginIdentities: Array<{
      localTurnId: string;
      clientMsgId: string;
    }> = [];
    const createIds: string[] = [];
    let finishAttempts = 0;
    const cloud = {
      getOwnershipMigrationStatus: async () => null,
      getConversation: async () => null,
      createConversation: async (args: { clientCreateId: string }) => {
        createIds.push(args.clientCreateId);
        return { conversationId: "cloud-crash-recovery" };
      },
    };
    const firstImporter = createLegacyChatCloudImporter({
      deviceId: "device-1",
      store,
      hasAuthToken: () => true,
      cloud,
      cloudTranscript: {
        begin: async (request) => {
          beginIdentities.push({
            localTurnId: request.localTurnId,
            clientMsgId: request.clientMsgId,
          });
          return {
            turnId: "admitted-turn",
            leaseToken: "admitted-lease",
            history: [],
          };
        },
        finish: async () => {
          finishAttempts += 1;
          throw new Error("simulated process crash before local checkpoint");
        },
      },
    });
    firstImporter.resume();
    await waitFor(() => finishAttempts === 1);
    firstImporter.stop();
    expect(store.getLegacyChatCloudImport(localConversationId)).toMatchObject({
      cloudConversationId: "cloud-crash-recovery",
      nextTurnIndex: 0,
      status: "pending",
    });

    const secondImporter = createLegacyChatCloudImporter({
      deviceId: "device-1",
      store,
      hasAuthToken: () => true,
      cloud,
      cloudTranscript: {
        begin: async (request) => {
          beginIdentities.push({
            localTurnId: request.localTurnId,
            clientMsgId: request.clientMsgId,
          });
          throw new CloudTranscriptAlreadyAdmittedError();
        },
        finish: async () => {
          throw new Error("already-admitted replay must not finish again");
        },
      },
    });
    secondImporter.resume();
    await waitFor(
      () =>
        store.getLegacyChatCloudImport(localConversationId)?.status ===
        "complete",
    );

    expect(createIds).toHaveLength(1);
    expect(beginIdentities).toHaveLength(2);
    expect(beginIdentities[1]).toEqual(beginIdentities[0]);
    expect(finishAttempts).toBe(1);
    expect(
      store
        .listLegacyChatVisibleMessages(localConversationId)
        .map((message) => ({
          id: message.id,
          text: message.payload.text,
        })),
    ).toEqual([
      { id: "crash-user", text: "Question before crash" },
      { id: "crash-assistant", text: "Answer before crash" },
    ]);
    secondImporter.stop();
  });
});

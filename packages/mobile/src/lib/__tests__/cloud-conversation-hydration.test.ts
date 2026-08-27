import { describe, expect, test } from "bun:test";
import {
  CloudAuthorityError,
  loadCloudConversationAuthority,
} from "../cloud-conversation-authority";
import {
  rebuildCloudConversationCache,
  type CloudConversationCacheMetadata,
} from "../cloud-conversation-cache";
import type { ChatMessage } from "../../types";

const identity = {
  accountScope: "account:user-1",
  expectedSubject: "user-1",
  identityKey: "account:user-1:session:session-1",
  revision: 4,
};

const metadata: CloudConversationCacheMetadata = {
  version: 1,
  accountScope: identity.accountScope,
  ownerGeneration: "owner-generation-1",
  socketOrigin: "wss://builder.example",
  conversationId: "conversation-stable",
  epoch: 7,
  headSeq: 2,
  floorSeq: 0,
};

const remoteMessages: ChatMessage[] = [
  {
    id: "exec:one",
    role: "user",
    text: "hello",
    sequence: 1,
  },
  {
    id: "cloud:turn:message:2",
    requestId: "exec:one",
    role: "assistant",
    text: "hi",
    sequence: 2,
  },
];

describe("mobile cloud canonical hydration", () => {
  test("a clean client discovers the deterministic placement conversation", async () => {
    const calls: string[] = [];
    const authority = await loadCloudConversationAuthority(identity, {
      confirmIdentity: async (args) => {
        calls.push(`confirm:${args.expectedSubject}:${args.identityRevision}`);
        return true;
      },
      getOwnerGeneration: async () => {
        calls.push("generation");
        return "owner-generation-1";
      },
      ensureConversation: async () => {
        calls.push("ensure");
        return "conversation-stable";
      },
      getRealtimeConfig: async () => {
        calls.push("config");
        return {
          httpOrigin: "https://builder.example",
          socketOrigin: "wss://builder.example/",
          protocol: 1,
        };
      },
    });

    expect(authority).toEqual({
      identityKey: identity.identityKey,
      accountScope: identity.accountScope,
      ownerGeneration: "owner-generation-1",
      conversationId: "conversation-stable",
      socketOrigin: "wss://builder.example",
    });
    expect(calls).toEqual([
      "confirm:user-1:4",
      "ensure",
      "config",
      "generation",
    ]);
  });

  test("cache deletion rebuilds the same projection without a new identity", async () => {
    let localMessages: ChatMessage[] = [];
    let localMetadata: CloudConversationCacheMetadata | null = null;
    let ensureCalls = 0;
    const ensureConversation = async () => {
      ensureCalls += 1;
      // createMyConversation is idempotent on mobile-placement:cloud.
      return "conversation-stable";
    };
    const load = () =>
      loadCloudConversationAuthority(identity, {
        confirmIdentity: async () => true,
        getOwnerGeneration: async () => "owner-generation-1",
        ensureConversation,
        getRealtimeConfig: async () => ({
          httpOrigin: "https://builder.example",
          socketOrigin: "wss://builder.example",
          protocol: 1,
        }),
      });
    const rebuild = async () =>
      rebuildCloudConversationCache({
        metadata,
        messages: remoteMessages,
        port: {
          clearMetadata: async () => {
            localMetadata = null;
          },
          clearMessages: async () => {
            localMessages = [];
          },
          saveMessages: async (messages) => {
            localMessages = messages.map((message) => ({ ...message }));
          },
          saveMetadata: async (next) => {
            localMetadata = { ...next };
          },
        },
      });

    expect((await load()).conversationId).toBe("conversation-stable");
    await rebuild();
    expect(localMessages).toEqual(remoteMessages);
    expect(localMetadata).toEqual(metadata);

    // Simulate an uninstall/cache loss while server conversation identity
    // survives, then cold-hydrate and rebuild from the DO again.
    localMessages = [];
    localMetadata = null;
    expect((await load()).conversationId).toBe("conversation-stable");
    await rebuild();

    expect(ensureCalls).toBe(2);
    expect(localMessages).toEqual(remoteMessages);
    expect(localMetadata).toEqual(metadata);
  });

  test("metadata commits last and stale rebuilds cannot publish authority", async () => {
    const calls: string[] = [];
    let current = true;
    await rebuildCloudConversationCache({
      metadata,
      messages: remoteMessages,
      isCurrent: () => current,
      port: {
        clearMetadata: async () => {
          calls.push("clear-metadata");
        },
        clearMessages: async () => {
          calls.push("clear-messages");
          current = false;
        },
        saveMessages: async () => {
          calls.push("save-messages");
        },
        saveMetadata: async () => {
          calls.push("save-metadata");
        },
      },
    });

    expect(calls).toEqual(["clear-metadata", "clear-messages"]);
  });

  test("canonical rebuild removes optimistic cache rows after local cache loss", async () => {
    let localMessages: ChatMessage[] = [
      {
        id: "local-optimistic",
        role: "user",
        text: "must not become history",
        queued: true,
      },
      {
        id: "local-placeholder",
        role: "assistant",
        requestId: "local-optimistic",
        text: "",
      },
    ];
    let localMetadata: CloudConversationCacheMetadata | null = {
      ...metadata,
      ownerGeneration: "stale-generation",
    };

    await rebuildCloudConversationCache({
      metadata,
      messages: remoteMessages,
      port: {
        clearMetadata: async () => {
          localMetadata = null;
        },
        clearMessages: async () => {
          localMessages = [];
        },
        saveMessages: async (messages) => {
          localMessages = messages.map((message) => ({ ...message }));
        },
        saveMetadata: async (next) => {
          localMetadata = { ...next };
        },
      },
    });

    expect(localMessages).toEqual(remoteMessages);
    expect(
      localMessages.some((message) => message.id === "local-optimistic"),
    ).toBe(false);
    expect(localMetadata).toEqual(metadata);
  });

  test("identity and deployment failures are explicit", async () => {
    let unconfirmed: unknown = null;
    try {
      await loadCloudConversationAuthority(identity, {
        confirmIdentity: async () => false,
        getOwnerGeneration: async () => "never",
        ensureConversation: async () => "never",
        getRealtimeConfig: async () => ({
          httpOrigin: null,
          socketOrigin: null,
          protocol: 1,
        }),
      });
    } catch (error) {
      unconfirmed = error;
    }
    expect(unconfirmed).toBeInstanceOf(CloudAuthorityError);
    expect(unconfirmed).toMatchObject({ retryable: true });

    let missingConfig: unknown = null;
    try {
      await loadCloudConversationAuthority(identity, {
        confirmIdentity: async () => true,
        getOwnerGeneration: async () => "owner-generation-1",
        ensureConversation: async () => "conversation-stable",
        getRealtimeConfig: async () => ({
          httpOrigin: null,
          socketOrigin: null,
          protocol: 1,
        }),
      });
    } catch (error) {
      missingConfig = error;
    }
    expect(missingConfig).toMatchObject({
      retryable: false,
      message:
        "Cloud conversation history is not available on this deployment.",
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  CloudAuthorityError,
  loadCloudConversationAuthority,
  type CloudChatBootstrap,
} from "../cloud-conversation-authority";
import {
  encodeCloudConversationCacheMetadata,
  readCloudConversationCache,
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

const OWNER_ID = "https://issuer|user-1";

const readyBootstrap = (
  overrides: Partial<Extract<CloudChatBootstrap, { status: "ready" }>> = {},
): CloudChatBootstrap => ({
  status: "ready",
  ownerId: OWNER_ID,
  ownerGeneration: "owner-generation-1",
  conversationId: "conversation-stable",
  realtime: {
    httpOrigin: "https://builder.example",
    socketOrigin: "wss://builder.example/",
    protocol: 1,
  },
  ...overrides,
});

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
  test("a clean client creates the one chat once, from the bootstrap generation", async () => {
    const calls: string[] = [];
    const authority = await loadCloudConversationAuthority(
      identity,
      OWNER_ID,
      {
        getBootstrap: async () => {
          calls.push("bootstrap");
          return readyBootstrap({ conversationId: null });
        },
        createConversation: async (generation) => {
          calls.push(`create:${generation}`);
          return "conversation-stable";
        },
      },
    );

    expect(authority).toEqual({
      identityKey: identity.identityKey,
      accountScope: identity.accountScope,
      ownerGeneration: "owner-generation-1",
      conversationId: "conversation-stable",
      socketOrigin: "wss://builder.example",
    });
    expect(calls).toEqual(["bootstrap", "create:owner-generation-1"]);
  });

  // Ratchet: the handshake holds the native splash, so every serial round
  // trip is launch latency. It was four (confirm → ensure → config →
  // generation, with ensure itself a read plus a write); an account whose
  // chat exists now pays one read, and only its first launch adds the create.
  test("the handshake costs one round trip once the chat exists", async () => {
    let creates = 0;
    const authority = await loadCloudConversationAuthority(
      identity,
      OWNER_ID,
      {
        getBootstrap: async () => readyBootstrap(),
        createConversation: async () => {
          creates += 1;
          return "never";
        },
      },
    );
    expect(authority.conversationId).toBe("conversation-stable");
    expect(creates).toBe(0);
  });

  test("an unconfirmed or different owner never creates a chat", async () => {
    for (const bootstrap of [
      { status: "identity_pending" } as const,
      readyBootstrap({ ownerId: "https://issuer|someone-else", conversationId: null }),
    ]) {
      let creates = 0;
      await expect(
        loadCloudConversationAuthority(identity, OWNER_ID, {
          getBootstrap: async () => bootstrap,
          createConversation: async () => {
            creates += 1;
            return "conversation-stable";
          },
        }),
      ).rejects.toThrow(
        "Stella is still securing this account. Try again in a moment.",
      );
      expect(creates).toBe(0);
    }
  });

  test("cache deletion rebuilds the same projection without a new identity", async () => {
    let localMessages: ChatMessage[] = [];
    let localMetadata: CloudConversationCacheMetadata | null = null;
    let serverConversationId: string | null = null;
    let createCalls = 0;
    const load = () =>
      loadCloudConversationAuthority(identity, OWNER_ID, {
        getBootstrap: async () =>
          readyBootstrap({ conversationId: serverConversationId }),
        createConversation: async () => {
          createCalls += 1;
          // conversations.create is idempotent on mobile-placement:cloud.
          serverConversationId = "conversation-stable";
          return serverConversationId;
        },
      });
    const rebuild = async () =>
      rebuildCloudConversationCache({
        metadata,
        messages: remoteMessages,
        port: {
          clearMetadata: async () => {
            localMetadata = null;
          },
          synchronizeMessages: async (messages) => {
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

    // The reinstall discovers the surviving chat instead of creating it.
    expect(createCalls).toBe(1);
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
        synchronizeMessages: async () => {
          calls.push("synchronize-messages");
          current = false;
        },
        saveMetadata: async () => {
          calls.push("save-metadata");
        },
      },
    });

    expect(calls).toEqual(["clear-metadata", "synchronize-messages"]);
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
        synchronizeMessages: async (messages) => {
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
      await loadCloudConversationAuthority(identity, OWNER_ID, {
        getBootstrap: async () => ({ status: "identity_pending" }),
        createConversation: async () => "never",
      });
    } catch (error) {
      unconfirmed = error;
    }
    expect(unconfirmed).toBeInstanceOf(CloudAuthorityError);
    expect(unconfirmed).toMatchObject({ retryable: true });

    let missingConfig: unknown = null;
    let creates = 0;
    try {
      await loadCloudConversationAuthority(identity, OWNER_ID, {
        getBootstrap: async () =>
          readyBootstrap({
            conversationId: null,
            realtime: { httpOrigin: null, socketOrigin: null, protocol: 1 },
          }),
        createConversation: async () => {
          creates += 1;
          return "conversation-stable";
        },
      });
    } catch (error) {
      missingConfig = error;
    }
    expect(missingConfig).toMatchObject({
      retryable: false,
      message:
        "Cloud conversation history is not available on this deployment.",
    });
    expect(creates).toBe(0);
  });
});

describe("mobile cloud cache cold-start read", () => {
  const authority = {
    accountScope: metadata.accountScope,
    ownerGeneration: metadata.ownerGeneration,
    conversationId: metadata.conversationId,
    socketOrigin: metadata.socketOrigin,
  };

  test("returns the committed projection when the fence matches", async () => {
    let messagesRead = 0;
    const cached = await readCloudConversationCache({
      authority,
      port: {
        loadMetadata: async () =>
          encodeCloudConversationCacheMetadata(metadata),
        loadMessages: async () => {
          messagesRead += 1;
          return remoteMessages.map((message) => ({ ...message }));
        },
      },
    });
    expect(cached).toEqual(remoteMessages);
    expect(messagesRead).toBe(1);
  });

  test("refuses another account, owner generation, or deployment without reading rows", async () => {
    for (const stale of [
      { ...metadata, accountScope: "account:user-2" },
      { ...metadata, ownerGeneration: "owner-generation-0" },
      { ...metadata, conversationId: "conversation-other" },
      { ...metadata, socketOrigin: "wss://elsewhere.example" },
    ]) {
      let messagesRead = 0;
      const cached = await readCloudConversationCache({
        authority,
        port: {
          loadMetadata: async () => encodeCloudConversationCacheMetadata(stale),
          loadMessages: async () => {
            messagesRead += 1;
            return remoteMessages;
          },
        },
      });
      expect(cached).toBeNull();
      expect(messagesRead).toBe(0);
    }
  });

  test("a missing or half-written cache and an empty snapshot yield nothing", async () => {
    expect(
      await readCloudConversationCache({
        authority,
        port: {
          loadMetadata: async () => null,
          loadMessages: async () => remoteMessages,
        },
      }),
    ).toBeNull();
    expect(
      await readCloudConversationCache({
        authority,
        port: {
          loadMetadata: async () =>
            encodeCloudConversationCacheMetadata(metadata),
          loadMessages: async () => [],
        },
      }),
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  advanceAuthIdentityRevision,
  allowsAutomaticAnonymousBootstrap,
  isAnonymousAuthUser,
  isConnectedAccountUser,
  requireResolvedAuthIdentity,
  resolveAccountBoundBridgeScope,
  resolveAuthSessionCacheScope,
  resolveCloudConversationIdentityGate,
} from "../auth-identity";
import {
  getOrCreateCloudConversationCreateId,
  readActiveCloudConversationId,
  resolveOwnedCloudConversation,
  resolveOwnershipMigrationGate,
  rotateCloudConversationCreateId,
  writeActiveCloudConversationId,
  type AsyncKeyValueStorage,
  type CloudConversation,
} from "../cloud-conversation-state";

class MemoryStorage implements AsyncKeyValueStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function conversation(
  conversationId: string,
  ownerId: string,
): CloudConversation {
  return {
    conversationId,
    ownerId,
    title: conversationId,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("mobile cloud conversation ownership", () => {
  test("scopes caches to immutable anonymous and connected user ids", () => {
    expect(
      resolveAuthSessionCacheScope({
        user: { id: "anon-1", isAnonymous: true },
        session: { id: "rotating-session" },
      }),
    ).toBe("anonymous:anon-1");
    expect(
      resolveAuthSessionCacheScope({
        user: { id: "account-1", isAnonymous: false },
        session: { id: "other-session" },
      }),
    ).toBe("account:account-1");
    expect(isAnonymousAuthUser({ id: "anon", isAnonymous: true })).toBe(true);
    expect(isConnectedAccountUser({ id: "anon", isAnonymous: true })).toBe(
      false,
    );
    expect(isConnectedAccountUser({ id: "account", isAnonymous: false })).toBe(
      true,
    );
    expect(allowsAutomaticAnonymousBootstrap("/chat")).toBe(true);
    expect(allowsAutomaticAnonymousBootstrap("/login")).toBe(false);
    expect(allowsAutomaticAnonymousBootstrap("/auth/callback")).toBe(false);
    expect(() => requireResolvedAuthIdentity(true)).toThrow("Still checking");
    requireResolvedAuthIdentity(false);
  });

  test("uses a fresh monotonic identity revision across A to B to A", () => {
    const initial = { identityKey: null, revision: 0 };
    const accountA = {
      user: { id: "account-a", isAnonymous: false },
      session: { id: "session-a1" },
    };
    const accountB = {
      user: { id: "account-b", isAnonymous: false },
      session: { id: "session-b" },
    };
    const firstA = advanceAuthIdentityRevision(initial, accountA);
    const nextB = advanceAuthIdentityRevision(firstA, accountB);
    const returningA = advanceAuthIdentityRevision(nextB, accountA);
    const rotatedA = advanceAuthIdentityRevision(returningA, {
      ...accountA,
      session: { id: "session-a2" },
    });

    expect(firstA.revision).toBe(1);
    expect(nextB.revision).toBe(2);
    expect(returningA.revision).toBe(3);
    expect(rotatedA.revision).toBe(4);
    expect(
      advanceAuthIdentityRevision(rotatedA, {
        ...accountA,
        session: { id: "session-a2" },
      }),
    ).toBe(rotatedA);
  });

  test("blocks a new account scope until Convex confirms its exact subject", () => {
    expect(
      resolveCloudConversationIdentityGate({
        expectedSubject: "account-b",
        sessionIsPending: false,
        convexIsLoading: false,
        convexIsAuthenticated: true,
        // The socket may still be authenticated with account A's cached JWT.
        identityConfirmed: false,
      }),
    ).toEqual({ canUseOwnerData: false, isLoading: true });
    expect(
      resolveCloudConversationIdentityGate({
        expectedSubject: "account-b",
        sessionIsPending: false,
        convexIsLoading: false,
        convexIsAuthenticated: true,
        identityConfirmed: true,
      }),
    ).toEqual({ canUseOwnerData: true, isLoading: false });
  });

  test("drops CarPlay bridge authority while identity resolves or changes", () => {
    expect(
      resolveAccountBoundBridgeScope(
        {
          user: { id: "account-a", isAnonymous: false },
          session: { id: "session-a" },
        },
        false,
      ),
    ).toBe("account:account-a");
    expect(
      resolveAccountBoundBridgeScope(
        {
          user: { id: "account-a", isAnonymous: false },
          session: { id: "session-a" },
        },
        true,
      ),
    ).toBe(null);
    expect(
      resolveAccountBoundBridgeScope(
        {
          user: { id: "anonymous", isAnonymous: true },
          session: { id: "anonymous-session" },
        },
        false,
      ),
    ).toBe(null);
    expect(
      resolveAccountBoundBridgeScope(
        {
          user: { id: "account-b", isAnonymous: false },
          session: { id: "session-b" },
        },
        false,
      ),
    ).toBe("account:account-b");
  });

  test("uses an exact owner-scoped lookup for a cached id outside the recent list", () => {
    const cached = conversation("cached", "convex-owner-token");
    expect(
      resolveOwnedCloudConversation({
        conversations: [conversation("newest", "convex-owner-token")],
        exactCachedConversation: cached,
        cachedConversationId: "cached",
        justCreatedConversation: null,
      }),
    ).toEqual(cached);
  });

  test("selects the owner-validated cache before the newest conversation", () => {
    const cached = conversation("cached", "owner");
    expect(
      resolveOwnedCloudConversation({
        conversations: [conversation("newest", "owner"), cached],
        exactCachedConversation: null,
        cachedConversationId: "cached",
        justCreatedConversation: null,
      }),
    ).toEqual(cached);
  });

  test("blocks selection while ownership migration loads, runs, or fails", () => {
    expect(
      resolveOwnershipMigrationGate(undefined, true).canSelectConversation,
    ).toBe(false);
    expect(
      resolveOwnershipMigrationGate("running", true).canSelectConversation,
    ).toBe(false);
    expect(
      resolveOwnershipMigrationGate("failed", true).canSelectConversation,
    ).toBe(false);
    expect(
      resolveOwnershipMigrationGate(null, true).canSelectConversation,
    ).toBe(true);
  });
});

describe("mobile cloud conversation persistence", () => {
  test("keeps active conversation pointers separate for every identity", async () => {
    const storage = new MemoryStorage();
    await writeActiveCloudConversationId(storage, "anonymous:a", "chat-a");
    await writeActiveCloudConversationId(storage, "account:b", "chat-b");

    expect(await readActiveCloudConversationId(storage, "anonymous:a")).toBe(
      "chat-a",
    );
    expect(await readActiveCloudConversationId(storage, "account:b")).toBe(
      "chat-b",
    );
  });

  test("reuses a create id after an ambiguous failure and rotates after success", async () => {
    const storage = new MemoryStorage();
    let next = 0;
    const uuid = () => `00000000-0000-4000-8000-${++next}`;
    const first = await getOrCreateCloudConversationCreateId(
      storage,
      "anonymous:a",
      uuid,
    );

    expect(
      await getOrCreateCloudConversationCreateId(storage, "anonymous:a", uuid),
    ).toBe(first);
    await rotateCloudConversationCreateId(storage, "anonymous:a", uuid);
    const rotated = await getOrCreateCloudConversationCreateId(
      storage,
      "anonymous:a",
      uuid,
    );
    expect(rotated === first).toBe(false);
  });
});

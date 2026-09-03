import { describe, expect, test } from "bun:test";
import { CloudConversationAuthorityStore } from "../cloud-conversation-authority-store";
import type { CloudConversationAuthority } from "../cloud-conversation-authority";

const identityA = {
  accountScope: "account:user-a",
  expectedSubject: "user-a",
  identityKey: "account:user-a:session:1",
  revision: 1,
};
const identityARotated = {
  ...identityA,
  identityKey: "account:user-a:session:2",
};
const identityB = {
  accountScope: "account:user-b",
  expectedSubject: "user-b",
  identityKey: "account:user-b:session:1",
  revision: 2,
};

const authorityFor = (
  identity: typeof identityA,
): CloudConversationAuthority => ({
  identityKey: identity.identityKey,
  accountScope: identity.accountScope,
  ownerGeneration: "gen-1",
  conversationId: `conversation:${identity.expectedSubject}`,
  socketOrigin: "wss://builder.example",
});

type Deferred = {
  promise: Promise<CloudConversationAuthority>;
  resolve: (value: CloudConversationAuthority) => void;
  reject: (error: unknown) => void;
};
const deferred = (): Deferred => {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<CloudConversationAuthority>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const harness = () => {
  const resolves: string[] = [];
  const identityChanges: string[] = [];
  const pending: Deferred[] = [];
  const store = new CloudConversationAuthorityStore({
    resolve: (identity) => {
      resolves.push(identity.identityKey);
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
    describeFailure: (error, anonymous) => ({
      message: `${anonymous ? "anon" : "account"}:${String(
        error instanceof Error ? error.message : error,
      )}`,
      retryable: true,
    }),
    onIdentityChange: (identity) => identityChanges.push(identity.identityKey),
  });
  return { store, resolves, identityChanges, pending };
};

describe("CloudConversationAuthorityStore", () => {
  test("a second mount for the same identity joins the cached result instead of re-running", async () => {
    const { store, resolves, identityChanges, pending } = harness();
    const first = store.ensure(identityA, false);
    expect(store.getSnapshot()).toEqual({
      status: "loading",
      identityKey: identityA.identityKey,
    });
    // A remount while the handshake is in flight shares the same promise.
    const second = store.ensure(identityA, false);
    expect(second).toBe(first);
    expect(resolves).toEqual([identityA.identityKey]);
    expect(identityChanges).toEqual([identityA.identityKey]);

    pending[0]!.resolve(authorityFor(identityA));
    await first;
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      authority: { conversationId: "conversation:user-a" },
    });

    // A later remount reads the cached value with no network and no token clear.
    await store.ensure(identityA, false);
    expect(resolves).toHaveLength(1);
    expect(identityChanges).toHaveLength(1);
  });

  test("only an identity-key change re-runs the boundary hook and the handshake", async () => {
    const { store, resolves, identityChanges, pending } = harness();
    void store.ensure(identityA, false);
    pending[0]!.resolve(authorityFor(identityA));
    await store.ensure(identityA, false);

    void store.ensure(identityARotated, false);
    expect(identityChanges).toEqual([
      identityA.identityKey,
      identityARotated.identityKey,
    ]);
    expect(resolves).toEqual([
      identityA.identityKey,
      identityARotated.identityKey,
    ]);
    // The stale entry is replaced synchronously so no reader can render A's
    // authority under the rotated session.
    expect(store.getSnapshot()).toEqual({
      status: "loading",
      identityKey: identityARotated.identityKey,
    });
  });

  test("a handshake that lands after the identity moved on is discarded", async () => {
    const { store, pending } = harness();
    const first = store.ensure(identityA, false);
    void store.ensure(identityB, false);
    pending[0]!.resolve(authorityFor(identityA));
    await first;
    expect(store.getSnapshot()).toEqual({
      status: "loading",
      identityKey: identityB.identityKey,
    });
    pending[1]!.resolve(authorityFor(identityB));
    await store.ensure(identityB, false);
    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      authority: { conversationId: "conversation:user-b" },
    });
  });

  test("retry re-runs the handshake for the same identity without the boundary hook", async () => {
    const { store, resolves, identityChanges, pending } = harness();
    const first = store.ensure(identityA, true);
    pending[0]!.reject(new Error("offline"));
    await first;
    expect(store.getSnapshot()).toEqual({
      status: "failed",
      identityKey: identityA.identityKey,
      issue: { message: "anon:offline", retryable: true },
    });

    const retried = store.retry();
    expect(store.getSnapshot()).toEqual({
      status: "loading",
      identityKey: identityA.identityKey,
    });
    expect(resolves).toEqual([identityA.identityKey, identityA.identityKey]);
    expect(identityChanges).toEqual([identityA.identityKey]);
    pending[1]!.resolve(authorityFor(identityA));
    await retried;
    expect(store.getSnapshot()).toMatchObject({ status: "ready" });
  });

  test("reset forgets the cache and notifies subscribers", async () => {
    const { store, identityChanges, pending } = harness();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const first = store.ensure(identityA, false);
    pending[0]!.resolve(authorityFor(identityA));
    await first;
    expect(notifications).toBe(2);

    store.reset();
    expect(store.getSnapshot()).toBeNull();
    expect(notifications).toBe(3);
    unsubscribe();

    // Signing back in, even as the same account, is an identity change again.
    void store.ensure(identityA, false);
    expect(identityChanges).toEqual([
      identityA.identityKey,
      identityA.identityKey,
    ]);
  });
});

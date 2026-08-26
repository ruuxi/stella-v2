import { describe, expect, test } from "bun:test";
import {
  advanceAuthIdentityRevision,
  resolveAuthSessionCacheScope,
} from "../src/global/auth/lib/auth-session-scope";

describe("auth session conversation cache scope", () => {
  test("uses the immutable user id instead of mutable profile fields", () => {
    expect(
      resolveAuthSessionCacheScope({
        user: {
          id: "user-1",
          isAnonymous: false,
        },
        session: { id: "session-1" },
      }),
    ).toBe("account:user-1");
  });

  test("keeps anonymous and connected owners in separate namespaces", () => {
    expect(
      resolveAuthSessionCacheScope({
        user: { id: "owner-1", isAnonymous: true },
        session: { id: "shared-session" },
      }),
    ).toBe("anonymous:owner-1");
    expect(
      resolveAuthSessionCacheScope({
        user: { id: "owner-1", isAnonymous: false },
        session: { id: "shared-session" },
      }),
    ).toBe("account:owner-1");
  });

  test("does not rotate the identity nonce when only the session id changes", () => {
    expect(
      advanceAuthIdentityRevision({
        currentScope: "account:owner-1",
        currentRevision: 7,
        nextSessionData: {
          user: { id: "owner-1", isAnonymous: false },
          session: { id: "replacement-session" },
        },
      }),
    ).toEqual({ scope: "account:owner-1", revision: 7 });
  });

  test("assigns a fresh query nonce even when an owner returns later", () => {
    const accountA = {
      user: { id: "owner-a", isAnonymous: false },
      session: { id: "session-a" },
    };
    const accountB = {
      user: { id: "owner-b", isAnonymous: false },
      session: { id: "session-b" },
    };
    const firstA = advanceAuthIdentityRevision({
      currentScope: "signed-out",
      currentRevision: 0,
      nextSessionData: accountA,
    });
    const nextB = advanceAuthIdentityRevision({
      currentScope: firstA.scope,
      currentRevision: firstA.revision,
      nextSessionData: accountB,
    });
    const secondA = advanceAuthIdentityRevision({
      currentScope: nextB.scope,
      currentRevision: nextB.revision,
      nextSessionData: accountA,
    });

    expect(firstA).toEqual({ scope: "account:owner-a", revision: 1 });
    expect(nextB).toEqual({ scope: "account:owner-b", revision: 2 });
    expect(secondA).toEqual({ scope: "account:owner-a", revision: 3 });
  });
});

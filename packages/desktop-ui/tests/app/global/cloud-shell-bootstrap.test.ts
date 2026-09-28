import { describe, expect, test } from "vitest";
import {
  captureShellBootstrapLookups,
  isMissingPublicFunctionError,
  readShellBootstrap,
  readShellBootstrapLookup,
} from "../../../src/global/auth/lib/cloud-shell-bootstrap";

const OWNER = "https://issuer.test|owner-a";
const ready = {
  status: "ready" as const,
  ownerId: OWNER,
  migration: null,
  selection: {
    ownerGeneration: "generation-1",
    conversations: [],
    routeConversation: null,
    cachedConversation: {
      conversationId: "cached",
      ownerId: OWNER,
      title: "",
      createdAt: 1,
      updatedAt: 1,
    },
  },
};

describe("shell bootstrap reads", () => {
  test("only a ready result for the expected owner proves the identity", () => {
    expect(readShellBootstrap(undefined, OWNER)).toEqual({
      settled: false,
      ready: null,
    });
    expect(
      readShellBootstrap({ status: "identity_pending" }, OWNER),
    ).toEqual({ settled: true, ready: null });
    expect(
      readShellBootstrap({ ...ready, ownerId: "https://issuer.test|b" }, OWNER),
    ).toEqual({ settled: true, ready: null });
    expect(readShellBootstrap(ready, null)).toEqual({
      settled: true,
      ready: null,
    });
    expect(readShellBootstrap(ready, OWNER)).toEqual({ settled: true, ready });
  });

  test("a missing function reads as loading; any other failure throws", () => {
    const missing = new Error(
      "[CONVEX Q(cloud_apps:getMyShellBootstrap)] Server Error Could not find public function for 'cloud_apps:getMyShellBootstrap'.",
    );
    expect(isMissingPublicFunctionError(missing)).toBe(true);
    expect(isMissingPublicFunctionError(new Error("revoked"))).toBe(false);
    expect(isMissingPublicFunctionError(undefined)).toBe(false);
    expect(readShellBootstrap(missing, OWNER)).toEqual({
      settled: false,
      ready: null,
    });
    const failure = new Error("revoked");
    expect(() => readShellBootstrap(failure, OWNER)).toThrow(failure);
  });

  test("captures the cached lookup only when it differs from the route", () => {
    expect(captureShellBootstrapLookups("k", "a", "a")).toEqual({
      key: "k",
      routeConversationId: "a",
    });
    expect(captureShellBootstrapLookups("k", null, "b")).toEqual({
      key: "k",
      cachedConversationId: "b",
    });
    expect(captureShellBootstrapLookups("k", null, null)).toEqual({ key: "k" });
  });

  test("answers only for the ids the launch read looked up", () => {
    const lookups = captureShellBootstrapLookups("k", "route", "cached");
    expect(readShellBootstrapLookup(ready.selection, lookups, "route")).toBe(
      null,
    );
    expect(
      readShellBootstrapLookup(ready.selection, lookups, "cached"),
    ).toMatchObject({ conversationId: "cached" });
    expect(
      readShellBootstrapLookup(ready.selection, lookups, "other"),
    ).toBeUndefined();
    expect(readShellBootstrapLookup(undefined, lookups, "route")).toBeUndefined();
    expect(
      readShellBootstrapLookup(ready.selection, null, "route"),
    ).toBeUndefined();
  });
});

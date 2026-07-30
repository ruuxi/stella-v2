import { describe, expect, test } from "bun:test";
import { appSdkSessionOwnsCurrentApp } from "../../../convex/lib/app_sdk_session";

describe("hosted app session ownership", () => {
  test("accepts only the current unfenced app owner", () => {
    expect(
      appSdkSessionOwnsCurrentApp({
        tokenOwnerId: "owner-a",
        currentAppOwnerId: "owner-a",
        sourceOwnerFenced: false,
      }),
    ).toBe(true);
    expect(
      appSdkSessionOwnsCurrentApp({
        tokenOwnerId: "owner-a",
        currentAppOwnerId: "owner-b",
        sourceOwnerFenced: false,
      }),
    ).toBe(false);
  });

  test("permanently rejects a linked anonymous source token", () => {
    expect(
      appSdkSessionOwnsCurrentApp({
        tokenOwnerId: "anonymous-owner",
        currentAppOwnerId: "anonymous-owner",
        sourceOwnerFenced: true,
      }),
    ).toBe(false);
  });

  test("rejects the source token while an app transfer is still staged", () => {
    expect(
      appSdkSessionOwnsCurrentApp({
        tokenOwnerId: "anonymous-owner",
        // The app row has not transferred yet, but the migration tombstone is
        // already the permanent source-write fence.
        currentAppOwnerId: "anonymous-owner",
        sourceOwnerFenced: true,
      }),
    ).toBe(false);
    expect(
      appSdkSessionOwnsCurrentApp({
        tokenOwnerId: "anonymous-owner",
        currentAppOwnerId: "connected-owner",
        sourceOwnerFenced: true,
      }),
    ).toBe(false);
  });
});

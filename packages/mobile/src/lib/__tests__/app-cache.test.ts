import { describe, expect, test } from "bun:test";
import {
  appListCacheKey,
  retainAppFrame,
  reusableAppFrame,
  type AppFrame,
} from "../app-cache";
import type { WorkspaceApp } from "@stella/contracts/workspace-apps";

const app: WorkspaceApp = {
  appId: "notes",
  slug: "notes",
  title: "Notes",
  revision: "v1",
  status: "ready",
  createdAt: 0,
  updatedAt: 0,
};
const frame: AppFrame = {
  ...app,
  url: "https://apps.example/session/",
  expiresAt: 120_000,
};

describe("mobile app cache", () => {
  test("isolates persisted metadata across accounts and servers", () => {
    const key = appListCacheKey("a", "https://dev.example");
    expect(key).not.toBe(appListCacheKey("b", "https://dev.example"));
    expect(key).not.toBe(appListCacheKey("a", "https://prod.example"));
    expect(appListCacheKey("a:b", "c")).not.toBe(appListCacheKey("b", "c:a"));
  });
  test("reuses the same page while its revision and session remain current", () => {
    expect(reusableAppFrame([frame], app, 0)).toBe(frame);
    expect(
      reusableAppFrame([frame], { ...app, revision: "v2" }, 0),
    ).toBeUndefined();
    expect(reusableAppFrame([frame], app, 60_000)).toBeUndefined();
    expect(
      reusableAppFrame([frame], { ...app, slug: "other" }, 0),
    ).toBeUndefined();
  });
  test("evicts the least recently used WebView and preserves recently used page identity", () => {
    const second = { ...frame, slug: "second" };
    const third = { ...frame, slug: "third" };
    const visited = retainAppFrame([frame, second], frame);
    expect(visited[1]).toBe(frame);
    expect(retainAppFrame(visited, third)).toEqual([frame, third]);
    const replacement = { ...frame, url: "https://apps.example/new-session/" };
    expect(retainAppFrame([frame, third], replacement)).toEqual([
      third,
      replacement,
    ]);
  });
});

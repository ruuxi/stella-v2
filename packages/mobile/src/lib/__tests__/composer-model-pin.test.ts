import { describe, expect, test } from "bun:test";
import {
  loadComposerModelPinned,
  setComposerModelPinned,
} from "../composer-model-pin";

const memoryStore = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  },
};

describe("composer model pin preference", () => {
  test("persists pinning and unpinning", async () => {
    expect(await loadComposerModelPinned()).toBe(false);

    setComposerModelPinned(true);
    await Promise.resolve();
    expect(memoryStore.get("stella-mobile.composer-model-picker-pinned")).toBe(
      "1",
    );
    expect(await loadComposerModelPinned()).toBe(true);

    setComposerModelPinned(false);
    await Promise.resolve();
    expect(memoryStore.has("stella-mobile.composer-model-picker-pinned")).toBe(
      false,
    );
  });
});

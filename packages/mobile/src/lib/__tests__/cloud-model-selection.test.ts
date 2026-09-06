import { describe, expect, test } from "bun:test";
import { managedCloudModelSelection, parseCloudModelSelection, runOwnerBoundModelRequest, usesCloudModelSettings } from "../cloud-model-selection";

describe("mobile cloud model settings", () => {
  test("cloud and unpaired chats use account models; paired computer keeps local models", () => {
    expect(usesCloudModelSettings({ mode: "cloud" }, true)).toBe(true);
    expect(usesCloudModelSettings({ mode: "automatic" }, false)).toBe(true);
    expect(usesCloudModelSettings({ mode: "device", deviceId: "desktop" }, true)).toBe(false);
    expect(usesCloudModelSettings({ mode: "automatic" }, true)).toBe(false);
  });

  test("choosing a Stella model changes the provider and preserves saved effort", () => {
    expect(managedCloudModelSelection("stella/sonnet", {
      engine: "openai-codex", provider: "openai-codex", model: "gpt-5.5", reasoningEffort: "high",
    })).toEqual({ engine: "stella", provider: "stella", model: "stella/sonnet", reasoningEffort: "high" });
  });

  test("rejects mismatched providers and corrupt persisted reasoning settings", () => {
    expect(parseCloudModelSelection({ engine: "stella", provider: "anthropic", model: "stella/sonnet", reasoningEffort: "default" })).toBeUndefined();
    expect(parseCloudModelSelection({ engine: "stella", provider: "stella", model: "stella/sonnet", reasoningEffort: "unsupported" })).toBeUndefined();
  });

  test("account change during token resolution cannot issue a stale write", async () => {
    let current = true;
    let writes = 0;
    const result = await runOwnerBoundModelRequest({
      getToken: async () => { current = false; return "owner-a-token"; },
      isCurrent: () => current,
      request: async () => { writes += 1; return "saved"; },
    });
    expect(writes).toBe(0);
    expect(result).toBeUndefined();
  });

  test("account change during a request cannot publish the old account selection", async () => {
    let current = true;
    const result = await runOwnerBoundModelRequest({
      getToken: async () => "owner-a-token",
      isCurrent: () => current,
      request: async (token) => {
        expect(token).toBe("owner-a-token");
        current = false;
        return "owner-a-model";
      },
    });
    expect(result).toBeUndefined();
  });
});

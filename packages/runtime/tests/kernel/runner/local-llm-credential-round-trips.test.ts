import { afterEach, describe, expect, it } from "vitest";
import {
  getAccessibleLocalLlmApiKey,
  getAccessibleLocalLlmOAuthApiKey,
  setLocalLlmCredentialAccessBroker,
} from "@stella/runtime/kernel/storage/local-llm-credential-access";

/**
 * Every model call resolves its key through these accessors; with the worker's
 * broker installed each `get` is a host round trip. Providers the host's list
 * does not name must not cost one.
 */
const installBroker = (lists: { apiKey: string[]; oauth: string[] }) => {
  const calls: string[] = [];
  setLocalLlmCredentialAccessBroker({
    hasApiKey: (provider) => lists.apiKey.includes(provider),
    hasOAuth: (provider) => lists.oauth.includes(provider),
    getApiKey: async (provider) => {
      calls.push(`api-key:${provider}`);
      return `key-${provider}`;
    },
    getOAuthApiKey: async (provider, options) => {
      calls.push(
        `oauth:${provider}${options?.forceRefresh ? ":force" : ""}`,
      );
      return `oauth-${provider}`;
    },
  });
  return calls;
};

afterEach(() => setLocalLlmCredentialAccessBroker(null));

describe("local LLM credential host round trips", () => {
  it("answers unlisted providers locally without asking the host", async () => {
    const calls = installBroker({ apiKey: [], oauth: [] });
    await expect(getAccessibleLocalLlmApiKey("/unused", "perf")).resolves.toBe(
      null,
    );
    await expect(
      getAccessibleLocalLlmOAuthApiKey("/unused", "perf", { forceRefresh: true }),
    ).resolves.toBe(null);
    expect(calls).toEqual([]);
  });

  it("still fetches listed providers through the host, normalized", async () => {
    const calls = installBroker({ apiKey: ["anthropic"], oauth: ["chatgpt"] });
    await expect(
      getAccessibleLocalLlmApiKey("/unused", " Anthropic "),
    ).resolves.toBe("key-anthropic");
    await expect(
      getAccessibleLocalLlmOAuthApiKey("/unused", "chatgpt", {
        forceRefresh: true,
      }),
    ).resolves.toBe("oauth-chatgpt");
    // Only the kind the list names is fetched.
    await expect(
      getAccessibleLocalLlmOAuthApiKey("/unused", "anthropic"),
    ).resolves.toBe(null);
    expect(calls).toEqual(["api-key:anthropic", "oauth:chatgpt:force"]);
  });

  it("follows a refreshed provider list on the next call", async () => {
    const lists = { apiKey: [] as string[], oauth: [] as string[] };
    const calls = installBroker(lists);
    await expect(getAccessibleLocalLlmApiKey("/unused", "xai")).resolves.toBe(
      null,
    );
    lists.apiKey.push("xai");
    await expect(getAccessibleLocalLlmApiKey("/unused", "xai")).resolves.toBe(
      "key-xai",
    );
    expect(calls).toEqual(["api-key:xai"]);
  });
});

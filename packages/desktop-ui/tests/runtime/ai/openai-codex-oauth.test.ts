import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAICodex } from "@stella/runtime/ai/utils/oauth/openai-codex";

describe("OpenAI Codex OAuth callback lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports callback success only after credentials are persisted", async () => {
    const nativeFetch = globalThis.fetch;
    const jwtPayload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-test",
        },
      }),
    ).toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/oauth/token")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: `header.${jwtPayload}.signature`,
                refresh_token: "refresh-test",
                expires_in: 3_600,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return nativeFetch(input, init);
      }),
    );

    let finishPersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    let callbackResponse: Promise<Response> | undefined;
    let callbackSettled = false;
    const login = loginOpenAICodex({
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        callbackResponse = nativeFetch(
          `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&code=test-code`,
        );
        void callbackResponse.then(() => {
          callbackSettled = true;
        });
      },
      onPrompt: async () => "",
      onCredentialsReady: async () => persistenceGate,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(callbackSettled).toBe(false);

    finishPersistence();
    await login;
    const response = await callbackResponse;
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("authentication completed");
  });

  it("settles a provider denial and releases the callback server", async () => {
    const login = loginOpenAICodex({
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        void fetch(
          `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&error=access_denied&error_description=User%20declined`,
        );
      },
      onPrompt: async () => "",
    });

    await expect(login).rejects.toThrow("User declined");
  });

  it("cancels an in-flight callback wait and releases the port", async () => {
    const controller = new AbortController();
    const login = loginOpenAICodex({
      signal: controller.signal,
      onAuth: () => controller.abort(),
      onPrompt: async () => "",
    });

    await expect(login).rejects.toThrow("canceled");
  });

  it("aborts an in-flight token exchange before credentials can resolve", async () => {
    const nativeFetch = globalThis.fetch;
    let markTokenStarted!: () => void;
    const tokenStarted = new Promise<void>((resolve) => {
      markTokenStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/oauth/token")) {
          markTokenStarted();
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectAbort = () =>
              reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        return nativeFetch(input, init);
      }),
    );

    const controller = new AbortController();
    const login = loginOpenAICodex({
      signal: controller.signal,
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        void nativeFetch(
          `http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&code=test-code`,
        );
      },
      onPrompt: async () => "",
    });

    await tokenStarted;
    controller.abort();
    await expect(login).rejects.toThrow("canceled");
  });
});

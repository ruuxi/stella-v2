import { describe, expect, test } from "bun:test";
import {
  browserAuthHandoffHtml,
  browserAuthHandoffScript,
} from "../src/auth-handoff";
import { readAppsHostConfig } from "../src/config";
import worker from "../src/index";
import { createEnv, routeId } from "./fixtures";

describe("browser auth handoff landing", () => {
  test("exchanges the OTT server-side and exposes only an HttpOnly cookie", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamAuthorization = "unset";
    try {
      globalThis.fetch = (async (_input, init) => {
        upstreamAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return Response.json(
          { ok: true },
          { headers: { "set-auth-token": "signed-session.signature" } },
        );
      }) as typeof fetch;
      const response = await worker.fetch(
        new Request(
          "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev/_stella/auth/exchange",
          {
            method: "POST",
            headers: {
              origin:
                "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
              "sec-fetch-site": "same-origin",
              "sec-fetch-mode": "cors",
              "content-type": "application/json",
            },
            body: JSON.stringify({ token: "valid_token-123" }),
          },
        ),
        createEnv(),
      );
      expect(response.status).toBe(200);
      expect(upstreamAuthorization).toBe("");
      expect(response.headers.get("set-auth-token")).toBeNull();
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=None");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects sibling-origin and missing Fetch Metadata before exchange", async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        called = true;
        return new Response("unexpected");
      }) as typeof fetch;
      for (const headers of [
        { origin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev" },
        {
          origin: "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
        },
      ]) {
        const response = await worker.fetch(
          new Request(
            "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev/_stella/auth/exchange",
            { method: "POST", headers, body: "{}" },
          ),
          createEnv(),
        );
        expect(response.status).toBe(403);
      }
      expect(called).toBeFalse();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serves a no-store page with an external same-origin script", async () => {
    const response = await worker.fetch(
      new Request(`https://apps.example.com/stella/${routeId}/auth`),
      createEnv(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "flexible-panther-999",
    );
    expect(html).toContain('src="/_stella/browser-auth-handoff.js"');
    expect(html).not.toContain("one-time-token/verify");
  });

  test("supports HEAD without resolving the active artifact", async () => {
    const response = await worker.fetch(
      new Request(`https://apps.example.com/stella/${routeId}/auth`, {
        method: "HEAD",
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("script clears the fragment and never exposes the account bearer", () => {
    const script = browserAuthHandoffScript(readAppsHostConfig(createEnv()));
    const clearIndex = script.indexOf("history.replaceState");
    const verifyIndex = script.lastIndexOf("void verify()");

    expect(clearIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(clearIndex);
    expect(script).toContain(
      "/_stella/auth/exchange",
    );
    expect(script).not.toContain("Better-Auth-Cookie");
    expect(script).not.toContain("/cross-domain/");
    expect(script).toContain("AbortSignal.timeout(15000)");
    expect(script).not.toContain('"set-auth-token"');
    expect(script).not.toContain("localStorage.setItem");
    expect(script).toContain("location.replace(destination)");
    expect(script).not.toContain("flexible-panther-999");
    expect(() => new Function(script)).not.toThrow();
  });

  test("HTML never embeds the configured auth origin or a credential", () => {
    const html = browserAuthHandoffHtml();
    expect(html).not.toContain("outgoing-bulldog-865");
    expect(html).not.toContain("ott=");
  });

  test("clears retired bearer storage before POST and redirects without exposing a replacement", async () => {
    const values = new Map<string, string>();
    const elements = new Map([
      ["handoff", { dataset: {} as Record<string, string> }],
      ["title", { textContent: "" }],
      ["message", { textContent: "" }],
      [
        "retry",
        {
          hidden: false,
          addEventListener: () => {},
        },
      ],
    ]);
    const document = {
      getElementById: (id: string) => elements.get(id),
    };
    let cleanedUrl: string | null = null;
    let destination: string | null = null;
    const location = {
      pathname: `/stella/${routeId}/auth`,
      search: "",
      hash: "#ott=valid_token-123",
      replace: (value: string) => {
        destination = value;
      },
    };
    const history = {
      state: null,
      replaceState: (_state: unknown, _unused: string, url: string) => {
        cleanedUrl = url;
        location.hash = "";
      },
    };
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    values.set("better-auth_cookie", '{"better-auth.session_token":{"value":"stale"}}');
    values.set("better-auth_session_data", "{}");
    let posted = false;
    const fetch = async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "/_stella/auth/exchange",
      );
      expect(cleanedUrl).toBe(`/stella/${routeId}/auth`);
      expect(init.method).toBe("POST");
      expect(init.headers as Record<string, string>).not.toHaveProperty(
        "Better-Auth-Cookie",
      );
      posted = true;
      return new Response("{}");
    };

    const run = new Function(
      "document",
      "location",
      "history",
      "localStorage",
      "fetch",
      browserAuthHandoffScript(readAppsHostConfig(createEnv())),
    );
    run(document, location, history, localStorage, fetch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toBeTrue();
    expect(destination).toBe(
      `https://stella-v2-apps-host-dev.lolruuxi.workers.dev/stella/${routeId}/`,
    );
    expect(values.has("better-auth_session_token")).toBeFalse();
    expect(values.has("better-auth_session_data")).toBeFalse();
    expect(values.has("better-auth_cookie")).toBeFalse();
  });

  test("rejects a failed server-side handoff and removes any retired bearer", async () => {
    const values = new Map<string, string>([
      ["better-auth_session_token", "old-session.signature"],
    ]);
    const elements = new Map([
      ["handoff", { dataset: {} as Record<string, string> }],
      ["title", { textContent: "" }],
      ["message", { textContent: "" }],
      ["retry", { hidden: false, addEventListener: () => {} }],
    ]);
    const document = { getElementById: (id: string) => elements.get(id) };
    let destination: string | null = null;
    const location = {
      pathname: `/stella/${routeId}/auth`,
      search: "",
      hash: "#ott=valid_token-123",
      replace: (value: string) => {
        destination = value;
      },
    };
    const history = {
      state: null,
      replaceState: () => {
        location.hash = "";
      },
    };
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const fetch = async () => new Response("{}", { status: 401 });
    const run = new Function(
      "document",
      "location",
      "history",
      "localStorage",
      "fetch",
      browserAuthHandoffScript(readAppsHostConfig(createEnv())),
    );
    run(document, location, history, localStorage, fetch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(destination).toBeNull();
    expect(values.has("better-auth_session_token")).toBeFalse();
    expect(
      (elements.get("handoff") as { dataset: Record<string, string> }).dataset
        .state,
    ).toBe("error");
  });
});

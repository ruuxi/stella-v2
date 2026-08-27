import { describe, expect, test } from "bun:test";
import {
  browserAuthHandoffHtml,
  browserAuthHandoffScript,
} from "../src/auth-handoff";
import { readAppsHostConfig } from "../src/config";
import worker from "../src/index";
import { createEnv, routeId } from "./fixtures";

describe("browser auth handoff landing", () => {
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
      "connect-src https://impartial-crab-34.convex.site",
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

  test("script clears the fragment before verification and mirrors auth storage", () => {
    const script = browserAuthHandoffScript(readAppsHostConfig(createEnv()));
    const clearIndex = script.indexOf("history.replaceState");
    const verifyIndex = script.lastIndexOf("void verify()");

    expect(clearIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(clearIndex);
    expect(script).toContain(
      "https://impartial-crab-34.convex.site/api/auth/cross-domain/one-time-token/verify",
    );
    expect(script).toContain('"Better-Auth-Cookie"');
    expect(script).toContain("COOKIE_VALUE_PATTERN");
    expect(script).toContain("AbortSignal.timeout(15000)");
    expect(script).toContain("localStorage.setItem(COOKIE_KEY");
    expect(script).toContain("localStorage.removeItem(SESSION_DATA_KEY)");
    expect(script).toContain("location.replace(destination)");
    expect(script).not.toContain("flexible-panther-999");
    expect(() => new Function(script)).not.toThrow();
  });

  test("HTML never embeds the configured auth origin or a credential", () => {
    const html = browserAuthHandoffHtml();
    expect(html).not.toContain("impartial-crab-34");
    expect(html).not.toContain("ott=");
  });

  test("clears the fragment before POST and redirects only after mirroring", async () => {
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
    let posted = false;
    const fetch = async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://impartial-crab-34.convex.site/api/auth/cross-domain/one-time-token/verify",
      );
      expect(cleanedUrl).toBe(`/stella/${routeId}/auth`);
      expect(init.method).toBe("POST");
      expect(
        (init.headers as Record<string, string>)["Better-Auth-Cookie"],
      ).toContain("stella_auth_bootstrap=1");
      posted = true;
      return new Response("{}", {
        headers: {
          "Set-Better-Auth-Cookie":
            "better-auth.session_token=signed-session; Max-Age=3600; Path=/; HttpOnly",
        },
      });
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
    expect(destination).toBe(`/stella/${routeId}/`);
    expect(values.has("better-auth_session_data")).toBeFalse();
    expect(values.get("better-auth_cookie")).toContain("signed-session");
  });

  test("rejects cookie-value injection from tampered local storage", async () => {
    const values = new Map<string, string>([
      [
        "better-auth_cookie",
        JSON.stringify({
          "better-auth.session_token": {
            value: "valid; injected=value",
            expires: null,
          },
        }),
      ],
    ]);
    const elements = new Map([
      ["handoff", { dataset: {} as Record<string, string> }],
      ["title", { textContent: "" }],
      ["message", { textContent: "" }],
      ["retry", { hidden: false, addEventListener: () => {} }],
    ]);
    const document = { getElementById: (id: string) => elements.get(id) };
    const location = {
      pathname: `/stella/${routeId}/auth`,
      search: "",
      hash: "#ott=valid_token-123",
      replace: () => {},
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
    let mirroredHeader = "";
    const fetch = async (_url: string, init: RequestInit) => {
      mirroredHeader = (init.headers as Record<string, string>)[
        "Better-Auth-Cookie"
      ];
      return new Response("{}", {
        headers: {
          "Set-Better-Auth-Cookie":
            "better-auth.session_token=fresh-session; Max-Age=3600",
        },
      });
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

    expect(mirroredHeader).not.toContain("injected=value");
    expect(mirroredHeader).toContain("stella_auth_bootstrap=1");
  });

  test("requires the verification response itself to issue a session token", async () => {
    const values = new Map<string, string>([
      [
        "better-auth_cookie",
        JSON.stringify({
          "better-auth.session_token": {
            value: "old-session",
            expires: null,
          },
        }),
      ],
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
    const fetch = async () =>
      new Response("{}", {
        headers: { "Set-Better-Auth-Cookie": "unrelated=value; Max-Age=3600" },
      });
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
    expect(
      (elements.get("handoff") as { dataset: Record<string, string> }).dataset
        .state,
    ).toBe("error");
  });
});

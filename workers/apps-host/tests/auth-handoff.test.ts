import { describe, expect, test } from "bun:test";
import worker, {
  browserAuthHandoffHtml,
  browserAuthHandoffScript,
} from "../src/index";

const env = {
  CONVEX_SITE_URL: "https://auth.example.test",
  CONVEX_CLOUD_URL: "https://api.example.test",
  APPS_HOST_ORIGIN: "https://apps.example.test",
  INTERIOR_ORIGIN: "https://interior.example.test",
  SHARES_DISABLED: "false",
} as never;

const routeId = "sr_12345678-1234-4123-8123-123456789abc";

describe("browser auth handoff landing", () => {
  test("serves a no-store page with external same-origin script", async () => {
    const response = await worker.fetch(
      new Request(`https://apps.example.test/stella/${routeId}/auth`),
      env,
      {} as ExecutionContext,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(html).toContain('src="/_stella/browser-auth-handoff.js"');
    expect(html).not.toContain("one-time-token/verify");
  });

  test("supports HEAD without resolving the active artifact", async () => {
    const response = await worker.fetch(
      new Request(`https://apps.example.test/stella/${routeId}/auth`, {
        method: "HEAD",
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("script clears the fragment before verification and mirrors auth storage", () => {
    const script = browserAuthHandoffScript(env);
    const clearIndex = script.indexOf("history.replaceState");
    const verifyIndex = script.lastIndexOf("void verify()");

    expect(clearIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(clearIndex);
    expect(script).toContain(
      "https://auth.example.test/api/auth/cross-domain/one-time-token/verify",
    );
    expect(script).toContain('"Better-Auth-Cookie"');
    expect(script).toContain('localStorage.setItem(COOKIE_KEY');
    expect(script).toContain('localStorage.removeItem(SESSION_DATA_KEY)');
    expect(script).toContain("location.replace(destination)");
    expect(() => new Function(script)).not.toThrow();
  });

  test("HTML never embeds the configured auth origin or a credential", () => {
    const html = browserAuthHandoffHtml();
    expect(html).not.toContain("auth.example.test");
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
    const fetch = async (_url: string, init: RequestInit) => {
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
      browserAuthHandoffScript(env),
    );
    run(document, location, history, localStorage, fetch);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted).toBeTrue();
    expect(destination).toBe(`/stella/${routeId}/`);
    expect(values.has("better-auth_session_data")).toBeFalse();
    expect(values.get("better-auth_cookie")).toContain("signed-session");
  });
});

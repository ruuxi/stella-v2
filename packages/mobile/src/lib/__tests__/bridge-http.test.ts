import { describe, expect, test } from "bun:test";
import {
  BridgeEndpointUnavailableError,
  fetchBridgeChallengeBody,
  isBridgeEndpointMissingError,
  isRawJsonParseErrorMessage,
  readBridgeErrorMessage,
  readBridgeJsonBody,
} from "../bridge-http";

const INDEX_HTML =
  '<!DOCTYPE html><html><head><title>Stella</title></head><body><div id="root"></div></body></html>';
const CLOUDFLARE_530 =
  "<!DOCTYPE html><html><head><title>Argo Tunnel error | Cloudflare</title></head><body>error code: 1033</body></html>";

const htmlResponse = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("readBridgeJsonBody", () => {
  test("parses real JSON", async () => {
    expect(await readBridgeJsonBody(jsonResponse({ ok: true }))).toEqual({
      ok: true,
    });
  });

  test("parses JSON even when the content-type is mislabeled", async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    expect(await readBridgeJsonBody(response)).toEqual({ ok: true });
  });

  test("200 HTML (old desktop catch-all index.html) becomes a structured error, not a parse throw", async () => {
    let caught: unknown;
    try {
      await readBridgeJsonBody(htmlResponse(INDEX_HTML));
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof BridgeEndpointUnavailableError).toBe(true);
    const message = (caught as Error).message;
    expect(message.includes("<")).toBe(false);
    expect(message.toLowerCase().includes("json parse")).toBe(false);
    expect(isBridgeEndpointMissingError(caught)).toBe(true);
  });

  test("Cloudflare 530 HTML error page becomes a structured error", async () => {
    let caught: unknown;
    try {
      await readBridgeJsonBody(htmlResponse(CLOUDFLARE_530, 530));
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof BridgeEndpointUnavailableError).toBe(true);
    expect((caught as BridgeEndpointUnavailableError).status).toBe(530);
  });

  test("truncated/garbage JSON-looking bodies become a structured error", async () => {
    let caught: unknown;
    try {
      await readBridgeJsonBody(
        new Response('{"partial": ', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof BridgeEndpointUnavailableError).toBe(true);
  });
});

describe("readBridgeErrorMessage", () => {
  test("extracts a JSON error field", async () => {
    expect(
      await readBridgeErrorMessage(
        jsonResponse({ error: "Disallowed IPC channel: mobile:hello" }, 403),
      ),
    ).toBe("Disallowed IPC channel: mobile:hello");
  });

  test("HTML error pages yield the clean fallback, never markup", async () => {
    const message = await readBridgeErrorMessage(
      htmlResponse(CLOUDFLARE_530, 530),
    );
    expect(message).toBe("Desktop bridge request failed (HTTP 530).");
    const custom = await readBridgeErrorMessage(
      htmlResponse(CLOUDFLARE_530, 530),
      "Desktop bridge request failed.",
    );
    expect(custom).toBe("Desktop bridge request failed.");
  });
});

describe("fetchBridgeChallengeBody — version-skew scenarios", () => {
  const CHALLENGE = {
    challengeId: "challenge-1",
    challenge: "abc",
    desktopDeviceId: "desktop-1",
    desktopPublicKey: "pk",
    protocol: "x25519-hkdf-sha256-aes-256-gcm-v1",
  };

  test("new desktop: scoped form answers directly, bare never called", async () => {
    const calls: string[] = [];
    const body = await fetchBridgeChallengeBody(
      "https://t.example.com",
      "desktop-1",
      async (url) => {
        calls.push(url);
        return jsonResponse(CHALLENGE);
      },
    );
    expect(body).toEqual(CHALLENGE);
    expect(calls).toEqual([
      "https://t.example.com/bridge/challenge?d=desktop-1",
    ]);
  });

  test("pre-380 desktop: scoped form 401s (auth catch-all), bare fallback succeeds", async () => {
    const calls: string[] = [];
    const body = await fetchBridgeChallengeBody(
      "https://t.example.com",
      "desktop-1",
      async (url) => {
        calls.push(url);
        if (url.includes("?d=")) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return jsonResponse(CHALLENGE);
      },
    );
    expect(body).toEqual(CHALLENGE);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("https://t.example.com/bridge/challenge");
  });

  test("scoped form answered with a 200 HTML page: bare fallback succeeds", async () => {
    const body = await fetchBridgeChallengeBody(
      "https://t.example.com",
      "desktop-1",
      async (url) =>
        url.includes("?d=")
          ? htmlResponse(INDEX_HTML)
          : jsonResponse(CHALLENGE),
    );
    expect(body).toEqual(CHALLENGE);
  });

  test("tunnel down: both forms answer Cloudflare HTML — clean error, no markup", async () => {
    let caught: unknown;
    try {
      await fetchBridgeChallengeBody(
        "https://t.example.com",
        "desktop-1",
        async () => htmlResponse(CLOUDFLARE_530, 530),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof Error).toBe(true);
    const message = (caught as Error).message;
    expect(message).toBe("Desktop bridge request failed.");
    expect(message.includes("<")).toBe(false);
  });

  test("bare fallback answering HTML at 200 still yields a structured error", async () => {
    let caught: unknown;
    try {
      await fetchBridgeChallengeBody(
        "https://t.example.com",
        "desktop-1",
        async () => htmlResponse(INDEX_HTML),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof BridgeEndpointUnavailableError).toBe(true);
    expect((caught as Error).message.includes("<")).toBe(false);
  });
});

describe("capability-demote classification", () => {
  test("endpoint-unavailable and channel rejections demote; transient errors do not", () => {
    expect(
      isBridgeEndpointMissingError(new BridgeEndpointUnavailableError(200)),
    ).toBe(true);
    expect(
      isBridgeEndpointMissingError(
        new Error("Unknown IPC channel: mobile:hello"),
      ),
    ).toBe(true);
    expect(
      isBridgeEndpointMissingError(
        new Error("Disallowed IPC channel: mobile:hello"),
      ),
    ).toBe(true);
    expect(
      isBridgeEndpointMissingError(
        new Error("Desktop bridge request timed out."),
      ),
    ).toBe(false);
    expect(
      isBridgeEndpointMissingError(new Error("Network request failed")),
    ).toBe(false);
  });
});

describe("isRawJsonParseErrorMessage", () => {
  test("matches Hermes and V8 parse-error shapes", () => {
    expect(
      isRawJsonParseErrorMessage("JSON Parse error: Unexpected character: <"),
    ).toBe(true);
    expect(
      isRawJsonParseErrorMessage(
        "Unexpected token < in JSON at position 0",
      ),
    ).toBe(true);
    expect(isRawJsonParseErrorMessage("Unexpected end of JSON input")).toBe(
      true,
    );
  });

  test("does not swallow normal error copy", () => {
    expect(isRawJsonParseErrorMessage("Your desktop is offline right now.")).toBe(
      false,
    );
    expect(isRawJsonParseErrorMessage("Desktop bridge request failed.")).toBe(
      false,
    );
  });
});

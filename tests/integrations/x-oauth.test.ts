import { describe, expect, test } from "bun:test";
import {
  buildXAuthorizationUrl,
  buildXCodeChallenge,
  buildXOAuthResultPage,
  buildXTokenExchangeRequest,
  parseXScope,
  X_OAUTH_SCOPES,
} from "../../convex/lib/x_oauth";

describe("X OAuth helpers", () => {
  test("builds the RFC 7636 S256 code challenge", async () => {
    const challenge = await buildXCodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("builds an authorization URL with Stella's requested scopes", () => {
    const url = new URL(
      buildXAuthorizationUrl({
        clientId: "client_123",
        redirectUri: "https://cloud.stella.sh/api/x/oauth_callback",
        state: "state_123",
        codeChallenge: "challenge_123",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://cloud.stella.sh/api/x/oauth_callback",
    );
    expect(url.searchParams.get("state")).toBe("state_123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge_123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(X_OAUTH_SCOPES.join(" "));
  });

  test("uses HTTP Basic auth for confidential token exchange", () => {
    const request = buildXTokenExchangeRequest({
      clientId: "client_123",
      clientSecret: "secret_456",
      code: "code_789",
      redirectUri: "https://cloud.stella.sh/api/x/oauth_callback",
      codeVerifier: "verifier_abc",
    });
    const body = new URLSearchParams(request.init.body);

    expect(request.url).toBe("https://api.x.com/2/oauth2/token");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers.Authorization).toBe(
      `Basic ${btoa("client_123:secret_456")}`,
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code_789");
    expect(body.get("redirect_uri")).toBe(
      "https://cloud.stella.sh/api/x/oauth_callback",
    );
    expect(body.get("code_verifier")).toBe("verifier_abc");
    expect(body.has("client_secret")).toBe(false);
  });

  test("parses scope strings and arrays", () => {
    expect(parseXScope("tweet.read tweet.write  offline.access")).toEqual([
      "tweet.read",
      "tweet.write",
      "offline.access",
    ]);
    expect(parseXScope(["users.read", 42, "dm.read"])).toEqual([
      "users.read",
      "dm.read",
    ]);
    expect(parseXScope(undefined)).toEqual([]);
  });

  test("escapes the result page message", () => {
    const html = buildXOAuthResultPage(true, `Connected <script>"bad"</script>`);
    expect(html).toContain("&lt;script&gt;&quot;bad&quot;&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

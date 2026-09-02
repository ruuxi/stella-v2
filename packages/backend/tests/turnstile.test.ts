import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { verifyTurnstileToken } from "../convex/lib/turnstile";

const previousSecret = process.env.TURNSTILE_SECRET_KEY;

afterEach(() => {
  if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = previousSecret;
  spyOn(globalThis, "fetch").mockRestore();
});

describe("Turnstile verification", () => {
  it("accepts tokens without a network call when Turnstile is off", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchMock = spyOn(globalThis, "fetch");

    await expect(verifyTurnstileToken("development-token")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the token, secret, and remote IP to Cloudflare", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true }),
    );

    await expect(
      verifyTurnstileToken("widget-token", "203.0.113.7"),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      secret: "turnstile-secret",
      response: "widget-token",
      remoteip: "203.0.113.7",
    });
  });

  it("fails closed on rejection and network errors", async () => {
    process.env.TURNSTILE_SECRET_KEY = "turnstile-secret";
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
    );

    await expect(verifyTurnstileToken("expired-token")).resolves.toEqual({
      ok: false,
      reason: "timeout-or-duplicate",
    });

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(verifyTurnstileToken("some-token")).resolves.toEqual({
      ok: false,
      reason: "siteverify_unavailable",
    });
  });
});

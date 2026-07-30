import { describe, expect, test } from "bun:test";
import { buildMagicLinkRequest } from "../auth-link-request";

describe("buildMagicLinkRequest", () => {
  test("binds an anonymous owner's bearer token to the link request", async () => {
    const request = await buildMagicLinkRequest({
      email: "person@example.com",
      anonymous: true,
      authResolved: true,
      getToken: async () => "convex-jwt",
    });

    expect(request.headers.Authorization).toBe("Bearer convex-jwt");
    expect(JSON.parse(request.body)).toEqual({
      email: "person@example.com",
      requireAnonymousOwner: true,
    });
  });

  test("fails closed when the anonymous owner token is unavailable", async () => {
    expect(
      buildMagicLinkRequest({
        email: "person@example.com",
        anonymous: true,
        authResolved: true,
        getToken: async () => "",
      }),
    ).rejects.toThrow("sign in again");
  });

  test("keeps a genuinely signed-out request unbound", async () => {
    const request = await buildMagicLinkRequest({
      email: "person@example.com",
      anonymous: false,
      authResolved: true,
      getToken: async () => {
        throw new Error("must not load");
      },
    });

    expect(request.headers.Authorization).toBe(undefined);
    expect(JSON.parse(request.body)).toEqual({
      email: "person@example.com",
    });
  });

  test("refuses an unbound request while the existing identity is unresolved", async () => {
    expect(
      buildMagicLinkRequest({
        email: "person@example.com",
        anonymous: false,
        authResolved: false,
        getToken: async () => "must-not-be-used",
      }),
    ).rejects.toThrow("Still checking");
  });
});

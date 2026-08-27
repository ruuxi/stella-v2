import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  decodeConvexTokenOwner,
  isConvexTokenOwnerFenceCurrent,
  resolveConvexTokenOwner,
} from "../convex-token-owner";

const jwt = (claims: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "test-signature",
  ].join(".");

describe("mobile Convex token owner", () => {
  test("uses the JWT issuer instead of preview/production custom auth base", async () => {
    const eas = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../../eas.json"), "utf8"),
    ) as {
      build: Record<"preview" | "production", { env: Record<string, string> }>;
    };

    for (const profile of ["preview", "production"] as const) {
      const buildEnv = eas.build[profile].env;
      expect(buildEnv.EXPO_PUBLIC_CONVEX_SITE_URL).toBe(
        "https://cloud.stella.sh",
      );
      const deploymentUrl = new URL(buildEnv.EXPO_PUBLIC_CONVEX_URL);
      const issuer = `https://${deploymentUrl.hostname.replace(
        /\.convex\.cloud$/u,
        ".convex.site",
      )}`;
      const owner = decodeConvexTokenOwner(
        jwt({ exp: 2_000_000_000, iss: issuer, sub: "user-a" }),
      );

      expect(owner).toEqual({
        expiresAtSeconds: 2_000_000_000,
        issuer,
        subject: "user-a",
        tokenIdentifier: `${issuer}|user-a`,
      });
      expect(
        owner.tokenIdentifier ===
          `${buildEnv.EXPO_PUBLIC_CONVEX_SITE_URL}|user-a`,
      ).toBe(false);
      expect(Object.isFrozen(owner)).toBe(true);
    }
  });

  test("rejects malformed or transformed owner claims", () => {
    const valid = {
      exp: 2_000_000_000,
      iss: "https://issuer.example.test",
      sub: "user-a",
    };
    for (const token of [
      "not-a-jwt",
      jwt({ ...valid, exp: 1.5 }),
      jwt({ ...valid, iss: undefined }),
      jwt({ ...valid, iss: "https://issuer.example.test/" }),
      jwt({ ...valid, iss: "http://issuer.example.test" }),
      jwt({ ...valid, sub: " user-a" }),
      jwt({ ...valid, sub: "user-a\n" }),
    ]) {
      expect(() => decodeConvexTokenOwner(token)).toThrow();
    }
  });

  test("fences token-owner resolution by the full session revision", () => {
    const fence = {
      accountScope: "account:user-a",
      identityKey: "account:user-a:session:session-a",
      identityRevision: 7,
      userSubject: "user-a",
    };
    expect(isConvexTokenOwnerFenceCurrent(fence, { ...fence })).toBe(true);
    expect(
      isConvexTokenOwnerFenceCurrent(fence, {
        ...fence,
        identityRevision: 8,
      }),
    ).toBe(false);
    expect(
      isConvexTokenOwnerFenceCurrent(fence, {
        ...fence,
        identityKey: "account:user-a:session:session-b",
      }),
    ).toBe(false);
    expect(
      isConvexTokenOwnerFenceCurrent(fence, {
        ...fence,
        accountScope: "account:user-b",
        userSubject: "user-b",
      }),
    ).toBe(false);
    expect(isConvexTokenOwnerFenceCurrent(fence, null)).toBe(false);
  });

  test("refreshes a stale account or issuer once and then fails closed", async () => {
    const issuer = "https://deployment.example.convex.site";
    const expectedToken = jwt({
      exp: 2_000_000_000,
      iss: issuer,
      sub: "user-b",
    });
    const staleAccountToken = jwt({
      exp: 2_000_000_000,
      iss: issuer,
      sub: "user-a",
    });
    const staleIssuerToken = jwt({
      exp: 2_000_000_000,
      iss: "https://cloud.stella.sh",
      sub: "user-b",
    });
    const calls: boolean[] = [];
    const owner = await resolveConvexTokenOwner({
      expectedSubject: "user-b",
      expectedTokenIdentifier: `${issuer}|user-b`,
      getToken: async ({ forceRefresh }) => {
        calls.push(forceRefresh);
        return forceRefresh ? expectedToken : staleAccountToken;
      },
    });

    expect(calls).toEqual([false, true]);
    expect(owner.token).toBe(expectedToken);
    expect(owner.tokenIdentifier).toBe(`${issuer}|user-b`);

    let persistentCalls = 0;
    let thrown: unknown = null;
    try {
      await resolveConvexTokenOwner({
        expectedSubject: "user-b",
        expectedTokenIdentifier: `${issuer}|user-b`,
        getToken: async () => {
          persistentCalls += 1;
          return staleIssuerToken;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("sign in again");
    expect(persistentCalls).toBe(2);
  });
});

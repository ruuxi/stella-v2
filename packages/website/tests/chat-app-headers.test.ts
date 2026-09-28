import { describe, expect, test } from "bun:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config";

/**
 * Next applies every matching `headers()` rule in order and the last value for
 * a key wins. Resolve headers the same way so a rule reorder can't silently
 * put the hashed chat bundle back on per-visit revalidation.
 */
const resolveHeaders = async (pathname: string) => {
  const rules = (await nextConfig.headers?.()) ?? [];
  const resolved: Record<string, string> = {};
  for (const rule of rules) {
    if (!getPathMatch(rule.source)(pathname)) continue;
    for (const { key, value } of rule.headers) resolved[key] = value;
  }
  return resolved;
};

describe("chat-app caching headers", () => {
  test("hashed bundle assets are immutable", async () => {
    const headers = await resolveHeaders("/chat-app/assets/main-Bt4QXPqV.js");
    expect(headers["Cache-Control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("the entry document always revalidates", async () => {
    const headers = await resolveHeaders("/chat-app/index.html");
    expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
  });
});

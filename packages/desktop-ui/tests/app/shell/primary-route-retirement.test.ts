// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { router } from "@/router";

beforeAll(async () => {
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {},
  });
  await router.load();
});

describe("retired primary routes", () => {
  it.each([
    { to: "/social" as const },
    { to: "/store" as const },
    { to: "/apps" as const },
    { to: "/apps/$slug" as const, params: { slug: "old-app" } },
    { to: "/c/$handle" as const, params: { handle: "old-creator" } },
  ])("redirects $to to Chat", async (target) => {
    await router.navigate(target);
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("keeps Settings reachable and returns cleanly to Chat", async () => {
    await router.navigate({ to: "/settings" });
    expect(router.state.location.pathname).toBe("/settings");
    await router.navigate({ to: "/chat" });
    expect(router.state.location.pathname).toBe("/chat");
  });
});

// @vitest-environment jsdom

import { createMemoryHistory } from "@tanstack/react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { router } from "@/router";
import {
  readPersistedLastLocation,
  writePersistedLastLocation,
} from "@/shared/lib/last-location";
import { restorePersistedLastLocation } from "@/shell/root-chrome/use-last-location-restore";

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

  it.each([
    "/social",
    "/social/?from=legacy",
    "/store?package=old-addon",
    "/store/creator/old-addon/?source=invite",
    "/apps/",
    "/apps/old-app?tab=details",
    "/c/old-creator/?ref=profile",
  ])(
    "restores persisted retired location %s to one stable Chat history entry",
    (persistedLocation) => {
      const history = createMemoryHistory({ initialEntries: ["/chat"] });
      const navigate = vi.fn(
        async (options: { to: string; replace?: boolean }) => {
          if (options.replace) history.replace(options.to);
          else history.push(options.to);
        },
      );
      const startupRouter = {
        routesByPath: {},
        navigate,
      } as unknown as Parameters<typeof restorePersistedLastLocation>[0];
      writePersistedLastLocation(persistedLocation);

      restorePersistedLastLocation(startupRouter);
      // A second mount/retry sees the migrated value and is a no-op.
      restorePersistedLastLocation(startupRouter);

      expect(history.location.pathname).toBe("/chat");
      expect(history.canGoBack()).toBe(false);
      expect(history.location.state.__TSR_index).toBe(0);
      expect(navigate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({
        to: "/chat",
        replace: true,
      });
      expect(readPersistedLastLocation()).toBe("/chat");
    },
  );
});

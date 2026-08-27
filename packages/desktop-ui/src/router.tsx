import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { CrashSurface } from "./shell/CrashSurface";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/chat"] }),

  defaultPreload: "intent",
  defaultPreloadDelay: 0,
  defaultPreloadStaleTime: Number.POSITIVE_INFINITY,
  scrollRestoration: false,
  defaultErrorComponent: ({ error, info }) => (
    <CrashSurface
      error={error instanceof Error ? error : new Error(String(error))}
      componentStack={info?.componentStack ?? null}
    />
  ),
});

if (import.meta.hot) {
  import.meta.hot.accept("./routeTree.gen.ts", (newModule) => {
    const next = (newModule as { routeTree?: unknown } | undefined)?.routeTree;
    if (!next) return;

    router.update({ routeTree: next as typeof routeTree });
    void router.invalidate();
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

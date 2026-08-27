import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    convex: { query },
    storage: new Map<string, string>(),
  };
});

vi.mock("convex/react", () => ({
  useConvex: () => mocks.convex,
}));
vi.mock("convex/server", () => ({
  getFunctionName: () => "billing:getSubscriptionStatus",
}));
vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.storage.set(key, value),
    removeItem: (key: string) => mocks.storage.delete(key),
  },
}));

import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";

const QUERY = {} as never;
const CACHE_KEY =
  "stella:persistent-convex-one-shot:v1:account:test:billing:getSubscriptionStatus:{}";

function Harness({ refreshCached }: { refreshCached: boolean }) {
  const value = usePersistentConvexOneShot(
    QUERY,
    {},
    {
      scope: "account:test",
      ttlMs: 300_000,
      refreshCached,
    },
  ) as { plan?: string } | undefined;
  return <span>{value?.plan ?? "loading"}</span>;
}

describe("persistent Convex one-shot cache policy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
    mocks.query.mockReset();
    mocks.storage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const seed = (plan: string, expiresAt = Date.now() + 60_000) => {
    mocks.storage.set(
      CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), expiresAt, data: { plan } }),
    );
  };

  it("does not query when refreshCached is false and cache is valid", async () => {
    seed("pro");

    await act(async () => root.render(<Harness refreshCached={false} />));

    expect(container.textContent).toBe("pro");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("queries when the cache is missing or expired", async () => {
    seed("free", Date.now() - 1);
    mocks.query.mockResolvedValue({ plan: "pro" });

    await act(async () => {
      root.render(<Harness refreshCached={false} />);
      await Promise.resolve();
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("pro");
  });

  it("refreshes a valid cache when explicitly requested", async () => {
    seed("go");
    mocks.query.mockResolvedValue({ plan: "pro" });

    await act(async () => {
      root.render(<Harness refreshCached />);
      await Promise.resolve();
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("pro");
  });

  it("rechecks and refreshes when a mounted cache entry expires", async () => {
    seed("go", Date.now() + 1_000);
    mocks.query.mockResolvedValue({ plan: "pro" });

    await act(async () => root.render(<Harness refreshCached={false} />));
    expect(mocks.query).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("pro");
  });

  it("shares one missing-cache query across concurrent consumers", async () => {
    mocks.query.mockResolvedValue({ plan: "pro" });

    await act(async () => {
      root.render(
        <>
          <Harness refreshCached={false} />
          <Harness refreshCached={false} />
        </>,
      );
      await Promise.resolve();
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("propro");
  });
});

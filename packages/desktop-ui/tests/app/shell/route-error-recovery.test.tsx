// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountScope: "anonymous:owner-one",
  cloudMode: false,
}));

vi.mock("@/global/auth/hooks/use-cloud-mode", () => ({
  useCloudMode: () => ({
    accountScope: mocks.accountScope,
    cloudMode: mocks.cloudMode,
  }),
}));

import {
  isOwnershipMigratedError,
  OWNERSHIP_MIGRATION_RECOVERY_TIMEOUT_MS,
  RouteErrorRecovery,
} from "@/shell/RouteErrorRecovery";

const ownershipMigratedError = () =>
  Object.assign(new Error("ownership moved"), {
    data: { code: "OWNERSHIP_MIGRATED", message: "Ownership migrated" },
  });

describe("route ownership-migration recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.accountScope = "anonymous:owner-one";
    mocks.cloudMode = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("matches only a structured or serialized OWNERSHIP_MIGRATED code", () => {
    expect(isOwnershipMigratedError(ownershipMigratedError())).toBe(true);
    expect(
      isOwnershipMigratedError(
        new Error(
          '[CONVEX Q(cloud_apps:get)] ConvexError: {"code":"OWNERSHIP_MIGRATED"}',
        ),
      ),
    ).toBe(true);
    expect(
      isOwnershipMigratedError(
        Object.assign(new Error("different fence"), {
          data: { code: "OWNER_TRANSFER_PENDING" },
        }),
      ),
    ).toBe(false);
    expect(
      isOwnershipMigratedError(
        new Error(
          "The words OWNERSHIP_MIGRATED appeared in an unrelated error",
        ),
      ),
    ).toBe(false);
  });

  it("keeps unrelated route errors on the shared crash surface", async () => {
    const reset = vi.fn();
    mocks.accountScope = "account:owner-one";
    mocks.cloudMode = true;

    await act(async () => {
      root.render(
        <RouteErrorRecovery
          error={new Error("ordinary route failure")}
          info={{ componentStack: "at Route" }}
          reset={reset}
        />,
      );
    });

    expect(container.textContent).toContain("Something went wrong");
    expect(container.textContent).not.toContain("Finishing sign-in…");
    expect(reset).not.toHaveBeenCalled();
  });

  it("resets once only after the connected cloud identity is confirmed", async () => {
    const reset = vi.fn();
    const error = ownershipMigratedError();
    const render = async () => {
      await act(async () => {
        root.render(<RouteErrorRecovery error={error} reset={reset} />);
      });
    };

    await render();
    expect(container.textContent).toBe("Finishing sign-in…");
    expect(reset).not.toHaveBeenCalled();

    mocks.cloudMode = true;
    await render();
    expect(reset).not.toHaveBeenCalled();

    mocks.accountScope = "account:owner-one";
    await render();
    expect(reset).toHaveBeenCalledTimes(1);

    await render();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to the crash surface after a bounded wait", async () => {
    const reset = vi.fn();
    const error = ownershipMigratedError();

    await act(async () => {
      root.render(<RouteErrorRecovery error={error} reset={reset} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        OWNERSHIP_MIGRATION_RECOVERY_TIMEOUT_MS,
      );
    });

    expect(container.textContent).toContain("Something went wrong");
    expect(reset).not.toHaveBeenCalled();

    mocks.accountScope = "account:owner-one";
    mocks.cloudMode = true;
    await act(async () => {
      root.render(<RouteErrorRecovery error={error} reset={reset} />);
    });
    expect(reset).not.toHaveBeenCalled();
  });
});

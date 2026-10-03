// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorRecovery } from "@/shell/RouteErrorRecovery";

describe("route error recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps route errors on the shared crash surface", async () => {
    const reset = vi.fn();

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
    expect(reset).not.toHaveBeenCalled();
  });
});

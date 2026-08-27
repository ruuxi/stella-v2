// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudBoundary } from "@/features/cloud/CloudBoundary";

function BrokenSurface(): never {
  throw new Error("missing cloud module");
}

describe("CloudBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("contains a broken optional cloud surface and renders its fallback", async () => {
    await act(async () => {
      root.render(
        <CloudBoundary fallback={<div>Cloud surface unavailable</div>}>
          <BrokenSurface />
        </CloudBoundary>,
      );
    });

    expect(container.textContent).toBe("Cloud surface unavailable");
    expect(console.warn).toHaveBeenCalledWith(
      "[cloud] surface unavailable:",
      expect.any(Error),
      expect.any(String),
    );
  });
});

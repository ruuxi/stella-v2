// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateStatus } from "@stella/contracts/desktop/update";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";

const mocks = vi.hoisted(() => ({
  status: "idle" as DesktopUpdateStatus,
  apply: vi.fn(async () => ({ action: "restart" })),
}));
vi.mock("@/global/updates/use-desktop-update", () => ({
  useDesktopUpdate: () => ({ snapshot: { status: mocks.status } }),
}));
vi.mock("@/global/updates/apply-desktop-update", () => ({
  applyDesktopUpdate: mocks.apply,
}));
vi.mock("@/shared/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("@/ui/toast", () => ({ showToast: vi.fn() }));

describe("update pill", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mocks.apply.mockClear();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it.each<DesktopUpdateStatus>([
    "disabled",
    "idle",
    "checking",
    "available",
    "downloading",
  ])("stays hidden while %s", async (status) => {
    mocks.status = status;
    await act(async () => root.render(<ShellTopBarUpdatePill />));
    expect(container.childElementCount).toBe(0);
  });

  it.each([
    ["downloaded", "update", false],
    ["error", "retryUpdate", false],
    ["restarting", "restarting", true],
  ] as const)(
    "offers the appropriate action while %s",
    async (status, label, disabled) => {
      mocks.status = status;
      await act(async () => root.render(<ShellTopBarUpdatePill />));
      const button = container.querySelector("button");
      expect(button).not.toBeNull();
      expect(button!.getAttribute("aria-label")).toBe(
        `shell.updatePill.${label}`,
      );
      expect(button!.disabled).toBe(disabled);
      await act(async () => button!.click());
      if (disabled) expect(mocks.apply).not.toHaveBeenCalled();
      else expect(mocks.apply).toHaveBeenCalledWith({ status });
    },
  );
});

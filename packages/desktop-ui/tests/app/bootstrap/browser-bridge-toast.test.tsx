import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, showToast } from "@/ui/toast";
import { useStellaBrowserBridgeToast } from "@/bootstrap/use-stella-browser-bridge-toast";

const BRIDGE_MISSING_ERROR =
  "Browser bridge is not installed. Reinstall Stella or run the desktop build so the bridge binary is present.";

const BridgeToastProbe = () => {
  useStellaBrowserBridgeToast();
  return null;
};

const BRIDGE_STATUSES = [
  { state: "idle" as const, attempt: 0 },
  { state: "connecting" as const, attempt: 0 },
  { state: "connected" as const, attempt: 0 },
  {
    state: "reconnecting" as const,
    attempt: 1,
    nextRetryMs: 1000,
    reason: "transient_failure" as const,
    notifyUser: true,
  },
  {
    state: "reconnecting" as const,
    attempt: 4,
    nextRetryMs: 8000,
    reason: "bridge_missing" as const,
    error: BRIDGE_MISSING_ERROR,
    notifyUser: true,
  },
  {
    state: "reconnecting" as const,
    attempt: 8,
    nextRetryMs: 8000,
    reason: "connection_lost" as const,
    error: "The Stella browser bridge disconnected.",
    notifyUser: true,
  },
  {
    state: "reconnecting" as const,
    attempt: 5,
    nextRetryMs: 8000,
    reason: "authorization_failed" as const,
    error: "permission denied",
    notifyUser: true,
  },
  {
    state: "host_registration_failed" as const,
    attempt: 0,
    reason: "bridge_missing" as const,
    error: BRIDGE_MISSING_ERROR,
    notifyUser: true,
  },
  {
    state: "host_registration_failed" as const,
    attempt: 0,
    reason: "authorization_failed" as const,
    error: "Native messaging host registration failed",
    notifyUser: true,
  },
];

describe("useStellaBrowserBridgeToast", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusListener:
    | ((status: (typeof BRIDGE_STATUSES)[number]) => void)
    | null;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    statusListener = null;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        browser: {
          onBridgeStatus: vi.fn((listener) => {
            statusListener = listener;
            return vi.fn();
          }),
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it("never turns bridge missing, disconnect, or retry status into a global toast", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <BridgeToastProbe />
        </ToastProvider>,
      );
      await Promise.resolve();
    });

    expect(statusListener).toEqual(expect.any(Function));

    await act(async () => {
      for (const status of BRIDGE_STATUSES) {
        statusListener?.(status);
      }
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Browser connection lost");
    expect(container.textContent).not.toContain("Browser extension unavailable");
    expect(container.textContent).not.toContain(BRIDGE_MISSING_ERROR);
    expect(container.textContent).not.toContain("keep retrying");
    expect(container.querySelector('[data-component="toast"]')).toBeNull();
  });

  it("still shows unrelated notifications while the bridge listener is mounted", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <BridgeToastProbe />
        </ToastProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      statusListener?.({
        state: "host_registration_failed",
        attempt: 0,
        reason: "bridge_missing",
        error: BRIDGE_MISSING_ERROR,
        notifyUser: true,
      });
      showToast({
        title: "Update available",
        description: "Stella is ready to install.",
        variant: "error",
        duration: 0,
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Update available");
    expect(container.textContent).toContain("Stella is ready to install.");
    expect(container.textContent).not.toContain("Browser connection lost");
    expect(container.textContent).not.toContain(BRIDGE_MISSING_ERROR);
  });
});

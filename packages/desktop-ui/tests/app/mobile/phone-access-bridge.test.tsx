// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  hasConnectedAccount: true,
  phoneAccessState: undefined as
    | { pairedDevices: Array<{ mobileDeviceId: string }> }
    | undefined,
  intent: null as
    | {
        intentId: string;
        mobileDeviceId: string;
        createdAt: number;
        expiresAt: number;
      }
    | null,
  getPhoneAccessState: { name: "getPhoneAccessState" },
  watchIncomingConnectIntent: { name: "watchIncomingConnectIntent" },
  acknowledgeConnectIntent: { name: "acknowledgeConnectIntent" },
  acknowledgeIntent: vi.fn(),
  getDeviceIdOrNull: vi.fn(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    mobile_access: {
      getPhoneAccessState: probe.getPhoneAccessState,
      watchIncomingConnectIntent: probe.watchIncomingConnectIntent,
      acknowledgeConnectIntent: probe.acknowledgeConnectIntent,
    },
  },
}));

vi.mock("convex/react", () => ({
  useMutation: () => probe.acknowledgeIntent,
  useQuery: (query: unknown, args: unknown) => {
    if (args === "skip") {
      return undefined;
    }
    if (query === probe.getPhoneAccessState) {
      return probe.phoneAccessState;
    }
    if (query === probe.watchIncomingConnectIntent) {
      return probe.intent;
    }
    return undefined;
  },
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({
    hasConnectedAccount: probe.hasConnectedAccount,
  }),
}));

vi.mock("@/platform/electron/device", () => ({
  getDeviceIdOrNull: probe.getDeviceIdOrNull,
}));

import { PhoneAccessBridge } from "@/global/mobile/PhoneAccessBridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("PhoneAccessBridge prewarming", () => {
  let container: HTMLDivElement;
  let root: Root;
  let startPhoneAccessSession: ReturnType<typeof vi.fn>;
  let stopPhoneAccessSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    probe.hasConnectedAccount = true;
    probe.phoneAccessState = undefined;
    probe.intent = null;
    probe.acknowledgeIntent.mockReset().mockResolvedValue(undefined);
    probe.getDeviceIdOrNull.mockReset().mockResolvedValue("desktop-1");
    startPhoneAccessSession = vi.fn().mockResolvedValue({ ok: true });
    stopPhoneAccessSession = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        system: { startPhoneAccessSession, stopPhoneAccessSession },
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "electronAPI");
  });

  const renderBridge = async () => {
    await act(async () => {
      root.render(<PhoneAccessBridge />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("waits for pairing state, then starts and stops once as devices change", async () => {
    await renderBridge();
    expect(startPhoneAccessSession).not.toHaveBeenCalled();
    expect(stopPhoneAccessSession).not.toHaveBeenCalled();

    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-1" }],
    };
    await renderBridge();
    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);
    expect(stopPhoneAccessSession).not.toHaveBeenCalled();

    await renderBridge();
    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);

    probe.phoneAccessState = { pairedDevices: [] };
    await renderBridge();
    expect(stopPhoneAccessSession).toHaveBeenCalledTimes(1);

    await renderBridge();
    expect(stopPhoneAccessSession).toHaveBeenCalledTimes(1);
  });

  it("stops a prewarmed bridge when the account disconnects", async () => {
    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-1" }],
    };
    await renderBridge();
    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);

    probe.hasConnectedAccount = false;
    await renderBridge();
    expect(stopPhoneAccessSession).toHaveBeenCalledTimes(1);
  });

  it("finishes an in-flight start before stopping after account disconnect", async () => {
    let finishStart: (() => void) | undefined;
    startPhoneAccessSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve({ ok: true });
        }),
    );
    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-1" }],
    };
    await renderBridge();
    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);

    probe.hasConnectedAccount = false;
    await renderBridge();
    expect(stopPhoneAccessSession).not.toHaveBeenCalled();

    await act(async () => {
      finishStart?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stopPhoneAccessSession).toHaveBeenCalledTimes(1);
  });

  it("acknowledges an intent without starting an already prewarmed bridge again", async () => {
    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-1" }],
    };
    await renderBridge();
    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);

    probe.intent = {
      intentId: "intent-1",
      mobileDeviceId: "mobile-1",
      createdAt: 100,
      expiresAt: Date.now() + 60_000,
    };
    await renderBridge();

    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);
    expect(probe.acknowledgeIntent).toHaveBeenCalledTimes(1);
    expect(probe.acknowledgeIntent).toHaveBeenCalledWith({
      intentId: "intent-1",
    });

    await renderBridge();
    expect(probe.acknowledgeIntent).toHaveBeenCalledTimes(1);
  });

  it("holds a stale intent while no devices are paired, then handles it after pairing", async () => {
    probe.phoneAccessState = { pairedDevices: [] };
    probe.intent = {
      intentId: "intent-1",
      mobileDeviceId: "mobile-1",
      createdAt: 100,
      expiresAt: Date.now() + 60_000,
    };
    await renderBridge();

    expect(startPhoneAccessSession).not.toHaveBeenCalled();
    expect(probe.acknowledgeIntent).not.toHaveBeenCalled();

    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-1" }],
    };
    await renderBridge();

    expect(startPhoneAccessSession).toHaveBeenCalledTimes(1);
    expect(probe.acknowledgeIntent).toHaveBeenCalledOnce();
    expect(probe.acknowledgeIntent).toHaveBeenCalledWith({
      intentId: "intent-1",
    });
  });

  it("does not acknowledge a revoked device's intent when another phone remains paired", async () => {
    probe.phoneAccessState = {
      pairedDevices: [{ mobileDeviceId: "mobile-2" }],
    };
    probe.intent = {
      intentId: "intent-1",
      mobileDeviceId: "mobile-1",
      createdAt: 100,
      expiresAt: Date.now() + 60_000,
    };
    await renderBridge();

    expect(startPhoneAccessSession).toHaveBeenCalledOnce();
    expect(probe.acknowledgeIntent).not.toHaveBeenCalled();

    probe.phoneAccessState = {
      pairedDevices: [
        { mobileDeviceId: "mobile-2" },
        { mobileDeviceId: "mobile-1" },
      ],
    };
    await renderBridge();

    expect(startPhoneAccessSession).toHaveBeenCalledOnce();
    expect(probe.acknowledgeIntent).toHaveBeenCalledOnce();
  });
});

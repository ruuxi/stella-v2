// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  devices: [] as unknown[],
  deviceReads: 0,
  call: vi.fn(),
}));

vi.mock("@/platform/backend/backend-client", () => ({
  backendUrl: "https://backend.example",
  backendClient: { call: mocks.call },
}));

vi.mock("@/features/cloud/placement-client", () => ({
  listExecutionDevices: async () => {
    mocks.deviceReads += 1;
    return {
      protocol: 1,
      devices: mocks.devices,
      cloud: { capabilities: ["chat"] },
    };
  },
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getAuthToken: async () => "jwt-account",
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({ hasConnectedAccount: true }),
}));

vi.mock("@/platform/electron/device", () => ({
  getDeviceIdOrNull: async () => "desktop-here",
}));

import { ExecutionDevicesCard } from "@/global/settings/ExecutionDevicesCard";
import { LocalI18nProvider } from "@/shared/i18n";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("ExecutionDevicesCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  const rowFor = (deviceId: string) =>
    container.querySelector<HTMLElement>(`[data-device-id="${deviceId}"]`);
  const actionFor = (deviceId: string) =>
    rowFor(deviceId)?.querySelector<HTMLButtonElement>("[data-device-action]");

  const render = async () => {
    await act(async () => {
      root.render(
        <LocalI18nProvider>
          <ExecutionDevicesCard />
        </LocalI18nProvider>,
      );
    });
    await flush();
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.deviceReads = 0;
    mocks.devices = [
      {
        deviceId: "desktop-here",
        label: "This Mac",
        online: true,
        remoteExecutionEnabled: true,
        remoteExecution: "enabled",
        availability: { ready: true, capabilities: ["chat"] },
      },
      {
        deviceId: "desktop-studio",
        label: "Studio iMac",
        online: true,
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
      },
    ];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("lists every signed-in computer, marks this one, and reports consent apart from presence", async () => {
    await render();

    expect(mocks.deviceReads).toBe(1);
    expect(container.textContent).toContain("This Mac");
    expect(container.textContent).toContain("Studio iMac");
    expect(rowFor("desktop-here")?.textContent).toContain("This computer");
    expect(rowFor("desktop-studio")?.textContent).not.toContain(
      "This computer",
    );

    const studio = rowFor("desktop-studio");
    expect(studio?.textContent).toContain("Online");
    expect(studio?.textContent).toContain("Not enabled");
    expect(
      studio?.querySelector('[data-device-consent="unconfigured"]'),
    ).not.toBeNull();
    // Listing a device must never be the thing that enlists it.
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("enables a listed computer only when its Enable action is used", async () => {
    mocks.call.mockResolvedValue({
      deviceId: "desktop-studio",
      remoteExecution: "enabled",
      changed: true,
    });
    await render();

    const enable = actionFor("desktop-studio");
    expect(enable?.dataset.deviceAction).toBe("enable");
    expect(enable?.textContent).toBe("Enable");

    await act(async () => enable?.click());
    await flush();

    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.call).toHaveBeenCalledWith("devices.setRemoteExecution", {
      deviceId: "desktop-studio",
      enabled: true,
    });
    // The gate's answer is reflected without waiting for the next poll.
    expect(rowFor("desktop-studio")?.textContent).toContain("Accepting work");
    expect(actionFor("desktop-studio")?.dataset.deviceAction).toBe("disable");
  });

  it("offers the inverse for a computer that already agreed", async () => {
    mocks.call.mockResolvedValue({
      deviceId: "desktop-here",
      remoteExecution: "declined",
      changed: true,
    });
    await render();

    const disable = actionFor("desktop-here");
    expect(disable?.textContent).toBe("Turn off");

    await act(async () => disable?.click());
    await flush();

    expect(mocks.call).toHaveBeenCalledWith("devices.setRemoteExecution", {
      deviceId: "desktop-here",
      enabled: false,
    });
    expect(rowFor("desktop-here")?.textContent).toContain("Declined there");
  });

  it("says a waiting prompt and a refusal are different states", async () => {
    mocks.devices = [
      {
        deviceId: "desktop-asked",
        label: "Asked Mac",
        online: true,
        remoteExecutionEnabled: false,
        remoteExecution: "asking",
      },
      {
        deviceId: "desktop-refused",
        label: "Refused Mac",
        online: false,
        remoteExecutionEnabled: false,
        remoteExecution: "declined",
      },
    ];
    await render();

    expect(rowFor("desktop-asked")?.textContent).toContain(
      "Waiting for an answer there",
    );
    expect(rowFor("desktop-refused")?.textContent).toContain("Declined there");
    expect(rowFor("desktop-refused")?.textContent).toContain("Offline");
    // Still listed, still refusing, and still enableable by hand.
    expect(actionFor("desktop-refused")?.dataset.deviceAction).toBe("enable");
  });
});

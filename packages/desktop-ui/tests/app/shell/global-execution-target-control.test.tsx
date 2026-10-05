// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockDevice = {
  deviceId: string;
  label: string;
  online: boolean;
  remoteExecutionEnabled: boolean;
  remoteExecution: "unconfigured" | "asking" | "enabled" | "declined";
  availability?: { ready: boolean; capabilities: string[] };
};

const READY_ENABLED_DEVICE: MockDevice = {
  deviceId: "desktop-studio",
  label: "Studio iMac",
  online: true,
  remoteExecutionEnabled: true,
  remoteExecution: "enabled",
  availability: { ready: true, capabilities: ["chat"] },
};

const mocks = vi.hoisted(() => ({
  hasConnectedAccount: false,
  isCloudConversationReady: true,
  deviceReads: [] as unknown[],
  devices: [] as unknown[],
  openConnectDialog: vi.fn(),
  setTarget: vi.fn(),
}));

vi.mock("@/platform/backend/backend-client", () => ({
  backendUrl: "https://backend.example",
}));

vi.mock("@/features/cloud/placement-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/cloud/placement-client")
  >()),
  listExecutionDevices: async (args: unknown) => {
    mocks.deviceReads.push(args);
    return {
      protocol: 1,
      devices: mocks.devices,
      cloud: { capabilities: ["chat"] },
    };
  },
}));

vi.mock("@/global/integrations/connect-action", () => ({
  openConnectDialog: mocks.openConnectDialog,
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getAuthToken: async () => "jwt-account",
}));

vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => ({
    isCloudConversationReady: mocks.isCloudConversationReady,
  }),
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({
    hasConnectedAccount: mocks.hasConnectedAccount,
  }),
}));

vi.mock("@/features/execution-placement/execution-target-store", () => ({
  AUTOMATIC_EXECUTION_TARGET: { mode: "automatic" as const },
  executionTargetStore: { set: mocks.setTarget },
  useExecutionTarget: () => ({ mode: "automatic" as const }),
}));

vi.mock("@/platform/electron/device", () => ({
  getDeviceIdOrNull: async () => null,
}));

vi.mock("@/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <>
      <button type="button" data-open-picker onClick={() => onOpenChange(true)}>
        open
      </button>
      {children}
    </>
  ),
  PopoverBody: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/ui/icons", () => ({
  AppWindowMac: () => <span />,
  Check: () => <span />,
  Globe: () => <span />,
}));

import { GlobalExecutionTargetControl } from "@/shell/GlobalExecutionTargetControl";

describe("GlobalExecutionTargetControl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.hasConnectedAccount = false;
    mocks.isCloudConversationReady = true;
    mocks.deviceReads = [];
    mocks.devices = [{ ...READY_ENABLED_DEVICE }];
    mocks.openConnectDialog.mockClear();
    mocks.setTarget.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const openPicker = async () => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[data-open-picker]")
        ?.click();
    });
  };

  it("keeps local and cloud targets visible without reading account devices", async () => {
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });
    await openPicker();

    expect(mocks.deviceReads).toEqual([]);
    expect(container.textContent).toContain("This computer");
    expect(container.textContent).toContain("Cloud");
    expect(container.textContent).toContain("Sign in");
  });

  it("reads devices only while the picker is open", async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });
    expect(mocks.deviceReads).toEqual([]);
  });

  it("reads live device presence from the backend's owner gate", async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });
    await openPicker();

    expect(mocks.deviceReads).toEqual([
      {
        socketOrigin: "https://backend.example",
        getToken: expect.any(Function),
      },
    ]);
    expect(container.textContent).toContain("Studio iMac");
    const studio = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Studio iMac"),
    );
    expect(studio?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Busy");
  });

  const renderOpen = async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });
    await openPicker();
  };

  const optionFor = (label: string) =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(label),
    );

  it("names why each listed computer is refusing instead of calling it unavailable", async () => {
    mocks.devices = [
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-fresh",
        label: "Fresh Mac",
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
        availability: undefined,
      },
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-asked",
        label: "Asked Mac",
        remoteExecutionEnabled: false,
        remoteExecution: "asking",
        availability: undefined,
      },
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-refused",
        label: "Refused Mac",
        remoteExecutionEnabled: false,
        remoteExecution: "declined",
        availability: undefined,
      },
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-starting",
        label: "Starting Mac",
        availability: { ready: false, capabilities: [] },
      },
    ];
    await renderOpen();

    expect(container.textContent).not.toContain("Unavailable");
    expect(optionFor("Fresh Mac")?.textContent).toContain("Not enabled");
    expect(optionFor("Asked Mac")?.textContent).toContain(
      "Waiting for approval",
    );
    expect(optionFor("Refused Mac")?.textContent).toContain("Declined");
    expect(optionFor("Starting Mac")?.textContent).toContain("Not ready");
  });

  it("will not let a listed but unconfigured computer be chosen, or enable it by being picked", async () => {
    mocks.devices = [
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-fresh",
        label: "Fresh Mac",
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
        availability: undefined,
      },
    ];
    await renderOpen();

    const fresh = optionFor("Fresh Mac");
    expect(fresh?.disabled).toBe(true);

    await act(async () => fresh?.click());

    expect(mocks.setTarget).not.toHaveBeenCalled();
    expect(mocks.openConnectDialog).not.toHaveBeenCalled();
  });

  it("sends enabling to the device list rather than doing it from the picker", async () => {
    mocks.devices = [
      {
        ...READY_ENABLED_DEVICE,
        deviceId: "desktop-fresh",
        label: "Fresh Mac",
        remoteExecutionEnabled: false,
        remoteExecution: "unconfigured",
        availability: undefined,
      },
    ];
    await renderOpen();

    const enable = optionFor("Enable a computer");
    expect(enable).toBeDefined();

    await act(async () => enable?.click());

    expect(mocks.openConnectDialog).toHaveBeenCalledTimes(1);
    expect(mocks.setTarget).not.toHaveBeenCalled();
  });

  it("keeps the offer out of the way once every computer has agreed", async () => {
    await renderOpen();

    expect(optionFor("Enable a computer")).toBeUndefined();
    expect(optionFor("Studio iMac")?.disabled).toBe(false);
  });
});

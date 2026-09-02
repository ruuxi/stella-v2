// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasConnectedAccount: false,
  isCloudConversationReady: true,
  queryCalls: [] as unknown[],
  deviceReads: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useQuery: (_reference: unknown, args: unknown) => {
    mocks.queryCalls.push(args);
    return args === "skip"
      ? undefined
      : { httpOrigin: null, socketOrigin: "https://builder.example", protocol: 1 };
  },
}));

vi.mock("@/features/cloud/placement-client", () => ({
  listExecutionDevices: async (args: unknown) => {
    mocks.deviceReads.push(args);
    return {
      protocol: 1,
      devices: [
        {
          deviceId: "desktop-studio",
          label: "Studio iMac",
          remoteExecutionEnabled: true,
          online: true,
          availability: {
            ready: true,
            chatSlots: 1,
            agentSlots: 1,
            capabilities: ["chat"],
          },
        },
      ],
      cloud: { capabilities: ["chat"] },
    };
  },
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: async () => "jwt-account",
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
  executionTargetStore: { set: vi.fn() },
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
    mocks.queryCalls = [];
    mocks.deviceReads = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps local and cloud targets visible without querying account devices", async () => {
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });

    expect(mocks.queryCalls).toEqual(["skip"]);
    expect(container.textContent).toContain("This computer");
    expect(container.textContent).toContain("Cloud");
  });

  it("looks up the owner gate only after an account is connected", async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });

    expect(mocks.queryCalls).toEqual([{}]);
    // Presence is read from the gate, and only while the picker is open.
    expect(mocks.deviceReads).toEqual([]);
  });

  it("reads live device presence from the owner gate while open", async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[data-open-picker]")
        ?.click();
    });

    expect(mocks.deviceReads).toEqual([
      {
        socketOrigin: "https://builder.example",
        getToken: expect.any(Function),
      },
    ]);
    expect(container.textContent).toContain("Studio iMac");
  });
});

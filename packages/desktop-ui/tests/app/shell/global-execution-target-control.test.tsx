// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasConnectedAccount: false,
  isCloudConversationReady: true,
  queryCalls: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useQuery: (_reference: unknown, args: unknown) => {
    mocks.queryCalls.push(args);
    return args === "skip" ? undefined : [];
  },
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
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
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

  it("loads owned devices after an account is connected", async () => {
    mocks.hasConnectedAccount = true;
    await act(async () => {
      root.render(<GlobalExecutionTargetControl />);
    });

    expect(mocks.queryCalls).toEqual([{}]);
  });
});

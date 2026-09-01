// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = vi.hoisted(() => ({
  listMyApps: "cloud:listMyApps",
  listPendingOpInvocations: "cloud:listPendingOpInvocations",
  publishMyAppOperations: "cloud:publishMyAppOperations",
  claimOpInvocation: "cloud:claimOpInvocation",
  completeOpInvocation: "cloud:completeOpInvocation",
  listMyInteriorBuilds: "cloud:listMyInteriorBuilds",
  promoteMyInteriorBuild: "cloud:promoteMyInteriorBuild",
  rollbackMyInteriorBuild: "cloud:rollbackMyInteriorBuild",
}));

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  apps: [
    {
      appId: "app-one",
      ownerId: "owner-one",
      slug: "app-one",
      title: "App one",
      status: "active",
      activeBuildId: "build-one",
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  deployment: {
    deployableId: "stella",
    stableRouteId: "route-one",
    activeBuildId: null,
    previousBuildId: null,
    routeRevision: 1,
    builds: [],
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: () => mocks.mutation,
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === API.listMyApps) return mocks.apps;
    if (ref === API.listPendingOpInvocations) return [];
    if (ref === API.listMyInteriorBuilds) return mocks.deployment;
    return undefined;
  },
}));

vi.mock("@/features/cloud/cloud-api", () => ({ cloudApi: API }));

vi.mock("@/features/cloud/cloud-config", () => ({
  CLOUD_APPS_HOST: null,
  cloudAppUrl: () => null,
}));

vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => ({ accountScope: "account:owner-one" }),
}));

vi.mock("@/global/auth/services/auth-token", () => ({
  getAuthHeaders: vi.fn(),
}));

import { CloudAppPanel } from "@/features/cloud/CloudAppPanel";
import { StellaInteriorCard } from "@/features/cloud/StellaInteriorCard";

describe("cloud Apps host unavailable surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("does not frame or proxy an app when the host is unavailable", async () => {
    await act(async () => root.render(<CloudAppPanel slug="app-one" />));

    expect(container.textContent).toContain("Cloud apps unavailable");
    expect(container.textContent).toContain(
      "missing its cloud Apps host configuration",
    );
    expect(container.querySelector("iframe")).toBeNull();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "stella-app", id: "request", method: "fetch" },
      }),
    );
    await act(async () => Promise.resolve());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not render an interior link to the development host", async () => {
    await act(async () => root.render(<StellaInteriorCard />));

    expect(container.textContent).toContain("Web preview unavailable");
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).not.toContain(
      "stella-v2-apps-host-dev.lolruuxi.workers.dev",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = vi.hoisted(() => ({
  cloud: {
    listMyEngineConnections: "cloud:listMyEngineConnections",
    startEngineConnect: "cloud:startEngineConnect",
    finishEngineConnect: "cloud:finishEngineConnect",
    disconnectEngine: "cloud:disconnectEngine",
    setMyCloudExecution: "cloud:setMyCloudExecution",
    activateImportedCredential: "cloud:activateImportedCredential",
    activateImportedEngineSettings: "cloud:activateImportedEngineSettings",
    listMyInteriorBuilds: "cloud:listMyInteriorBuilds",
    ensureMyInteriorStableRoute: "cloud:ensureMyInteriorStableRoute",
    rotateMyInteriorStableRoute: "cloud:rotateMyInteriorStableRoute",
    promoteMyInteriorBuild: "cloud:promoteMyInteriorBuild",
    rollbackMyInteriorBuild: "cloud:rollbackMyInteriorBuild",
  },
  projects: {
    listMyProjects: "projects:listMyProjects",
    listMyGithubInstallations: "projects:listMyGithubInstallations",
    startGithubAppInstall: "projects:startGithubAppInstall",
    createMyProject: "projects:createMyProject",
    finishGithubConnect: "projects:finishGithubConnect",
  },
}));

const mocks = vi.hoisted(() => ({
  authenticated: true,
  queries: new Map<unknown, unknown>(),
  actions: new Map<unknown, ReturnType<typeof vi.fn>>(),
  mutations: new Map<unknown, ReturnType<typeof vi.fn>>(),
  queryCalls: [] as Array<{ ref: unknown; args: unknown }>,
  showToast: vi.fn(),
  publishExecution: vi.fn(),
}));

const requiredHandler = (
  handlers: Map<unknown, ReturnType<typeof vi.fn>>,
  ref: unknown,
) => {
  const handler = handlers.get(ref);
  if (!handler) throw new Error(`Missing test handler for ${String(ref)}`);
  return handler;
};

vi.mock("convex/react", () => ({
  ConvexReactClient: vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: mocks.authenticated }),
  useQuery: (ref: unknown, args: unknown) => {
    mocks.queryCalls.push({ ref, args });
    return args === "skip" ? undefined : mocks.queries.get(ref);
  },
  useAction: (ref: unknown) => requiredHandler(mocks.actions, ref),
  useMutation: (ref: unknown) => requiredHandler(mocks.mutations, ref),
}));

vi.mock("@/features/cloud/cloud-api", () => ({
  cloudApi: API.cloud,
  projectsApi: API.projects,
}));

vi.mock("@/features/cloud/cloud-execution-store", () => ({
  publishCloudExecutionSelection: mocks.publishExecution,
}));

vi.mock("@/global/auth/hooks/use-cloud-mode", () => ({
  useCloudMode: () => ({
    cloudMode: mocks.authenticated,
    accountScope: "account:test-owner",
  }),
}));

vi.mock("@/ui/toast", () => ({ showToast: mocks.showToast }));

import { CloudAccountCards } from "@/features/cloud/CloudAccountCards";

const engineConnections = () => ({
  chatEngine: "stella",
  execution: {
    engine: "stella",
    provider: "stella",
    model: "stella/anthropic/claude-sonnet-4.6",
    reasoningEffort: "default",
  },
  connections: [
    { provider: "anthropic", label: "Claude", updatedAt: 1 },
    { provider: "openai-codex", label: "ChatGPT", updatedAt: 1 },
  ],
  importedConnections: [],
  importedSettings: [],
});

const interiorDeployment = () => ({
  deployableId: "stella",
  stableRouteId: "route-one",
  activeBuildId: "build-active",
  previousBuildId: "build-previous",
  routeRevision: 7,
  builds: [
    {
      buildId: "build-active",
      deployableId: "stella",
      turnId: "turn-active",
      threadId: "thread-active",
      sourceRevision: "sha256:active",
      baseRevision: null,
      artifactPrefix: "active",
      manifestSha256: "manifest-active",
      artifactDigest: "digest-active",
      artifactSizeBytes: 1_048_576,
      bridgeAbi: 1,
      minShellVersion: "0.1.0",
      createdAt: 1,
      isActive: true,
      isPrevious: false,
    },
    {
      buildId: "build-candidate",
      deployableId: "stella",
      turnId: "turn-candidate",
      threadId: "thread-candidate",
      sourceRevision: "sha256:candidate",
      baseRevision: "sha256:active",
      artifactPrefix: "candidate",
      manifestSha256: "manifest-candidate",
      artifactDigest: "digest-candidate",
      artifactSizeBytes: 2_097_152,
      bridgeAbi: 1,
      minShellVersion: "0.1.0",
      createdAt: 2,
      isActive: false,
      isPrevious: false,
    },
  ],
});

describe("ported cloud account cards", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<CloudAccountCards />));
  };

  const findButton = (text: string, within: ParentNode = container) =>
    Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === text,
    );

  const card = (title: string) => {
    const heading = Array.from(
      container.querySelectorAll<HTMLElement>(".settings-card-title"),
    ).find((candidate) => candidate.textContent?.trim() === title);
    const result = heading?.closest<HTMLElement>(".settings-card");
    expect(result).not.toBeNull();
    return result!;
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.authenticated = true;
    mocks.queries.clear();
    mocks.actions.clear();
    mocks.mutations.clear();
    mocks.queryCalls = [];
    mocks.showToast.mockReset();
    mocks.publishExecution.mockReset();

    mocks.actions.set(
      API.cloud.startEngineConnect,
      vi.fn().mockResolvedValue({
        connectId: "connect-1",
        authorizeUrl: "https://provider.example/authorize",
      }),
    );
    mocks.actions.set(
      API.cloud.finishEngineConnect,
      vi.fn().mockResolvedValue({ ok: true }),
    );
    mocks.actions.set(
      API.projects.startGithubAppInstall,
      vi.fn().mockResolvedValue({
        stateId: "state-1",
        installUrl: "https://github.example/install",
      }),
    );

    mocks.mutations.set(
      API.cloud.disconnectEngine,
      vi.fn().mockResolvedValue(null),
    );
    mocks.mutations.set(
      API.cloud.setMyCloudExecution,
      vi.fn().mockResolvedValue(null),
    );
    mocks.mutations.set(
      API.cloud.activateImportedCredential,
      vi.fn().mockResolvedValue({ activated: true }),
    );
    mocks.mutations.set(
      API.cloud.activateImportedEngineSettings,
      vi.fn().mockResolvedValue({ activated: true }),
    );
    mocks.mutations.set(
      API.cloud.ensureMyInteriorStableRoute,
      vi.fn().mockResolvedValue({ stableRouteId: "route-new" }),
    );
    mocks.mutations.set(
      API.cloud.rotateMyInteriorStableRoute,
      vi.fn().mockResolvedValue({ stableRouteId: "route-two" }),
    );
    mocks.mutations.set(
      API.cloud.promoteMyInteriorBuild,
      vi.fn().mockResolvedValue({
        deployableId: "stella",
        activeBuildId: "build-candidate",
        previousBuildId: "build-active",
        routeRevision: 8,
      }),
    );
    mocks.mutations.set(
      API.cloud.rollbackMyInteriorBuild,
      vi.fn().mockResolvedValue({
        deployableId: "stella",
        activeBuildId: "build-previous",
        previousBuildId: "build-active",
        routeRevision: 8,
      }),
    );
    mocks.mutations.set(
      API.projects.createMyProject,
      vi.fn().mockResolvedValue({ projectId: "project-1" }),
    );
    mocks.mutations.set(
      API.projects.finishGithubConnect,
      vi.fn().mockResolvedValue({
        ok: true,
        accountLogin: "octocat",
        accountType: "User",
      }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders nothing while signed out and skips the engine query", async () => {
    mocks.authenticated = false;
    await render();

    expect(container.textContent).toBe("");
    expect(mocks.queryCalls).toEqual([]);
  });

  it("keeps the cards' loading surfaces and disables provider connects", async () => {
    await render();

    expect(card("Cloud engines")).toBeTruthy();
    expect(card("Cloud projects")).toBeTruthy();
    expect(card("Stella interior").textContent).toContain(
      "Loading deployments…",
    );
    const engineConnects = Array.from(
      card("Cloud engines").querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent?.trim() === "Connect");
    expect(engineConnects).toHaveLength(2);
    expect(engineConnects.every((button) => button.disabled)).toBe(true);
  });

  it("publishes the selected engine immediately after the mutation", async () => {
    mocks.queries.set(API.cloud.listMyEngineConnections, engineConnections());
    await render();

    await act(async () => {
      findButton("ChatGPT", card("Cloud engines"))?.click();
      await Promise.resolve();
    });

    const expected = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "default",
    };
    expect(
      mocks.mutations.get(API.cloud.setMyCloudExecution),
    ).toHaveBeenCalledWith({ execution: expected });
    expect(mocks.publishExecution).toHaveBeenCalledWith(expected);
  });

  it("fences select and rollback with the route revision shown to the user", async () => {
    mocks.queries.set(API.cloud.listMyInteriorBuilds, interiorDeployment());
    await render();

    await act(async () => {
      findButton("Select", card("Stella interior"))?.click();
      await Promise.resolve();
    });
    expect(
      mocks.mutations.get(API.cloud.promoteMyInteriorBuild),
    ).toHaveBeenCalledWith({
      buildId: "build-candidate",
      expectedRouteRevision: 7,
    });

    await act(async () => {
      findButton("Rollback", card("Stella interior"))?.click();
      await Promise.resolve();
    });
    expect(
      mocks.mutations.get(API.cloud.rollbackMyInteriorBuild),
    ).toHaveBeenCalledWith({ expectedRouteRevision: 7 });
  });

  it("requires the explicit GitHub connect-code step and names the account", async () => {
    mocks.queries.set(API.projects.listMyProjects, []);
    mocks.queries.set(API.projects.listMyGithubInstallations, {
      appConfigured: true,
      connections: [],
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await render();

    await act(async () => {
      findButton("Connect", card("Cloud projects"))?.click();
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.example/install",
      "_blank",
      "noopener",
    );

    const input = card("Cloud projects").querySelector<HTMLInputElement>(
      'input[placeholder="XXXX-XXXX-XXXX"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "ABCD-EFGH-IJKL");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      findButton("Finish", card("Cloud projects"))?.click();
      await Promise.resolve();
    });

    expect(
      mocks.mutations.get(API.projects.finishGithubConnect),
    ).toHaveBeenCalledWith({ connectCode: "ABCD-EFGH-IJKL" });
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "GitHub connected as octocat.",
      variant: "success",
    });
  });

  it("keeps project action failures contained in an error toast", async () => {
    mocks.queries.set(API.projects.listMyProjects, []);
    mocks.queries.set(API.projects.listMyGithubInstallations, {
      appConfigured: true,
      connections: [],
    });
    mocks.actions.set(
      API.projects.startGithubAppInstall,
      vi.fn().mockRejectedValue(new Error("GitHub is unavailable")),
    );
    await render();

    await act(async () => {
      findButton("Connect", card("Cloud projects"))?.click();
      await Promise.resolve();
    });

    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "GitHub is unavailable",
      variant: "error",
    });
    expect(container.textContent).toContain("Cloud projects");
  });
});

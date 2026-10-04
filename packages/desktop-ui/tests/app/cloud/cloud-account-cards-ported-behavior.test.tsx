// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  queries: new Map<unknown, unknown>(),
  actions: new Map<unknown, ReturnType<typeof vi.fn>>(),
  mutations: new Map<unknown, ReturnType<typeof vi.fn>>(),
  queryCalls: [] as Array<{ ref: unknown; args: unknown }>,
  showToast: vi.fn(),
  publishExecution: vi.fn(),
  engines: undefined as unknown,
  enginesApi: {
    startConnect: vi.fn(),
    finishConnect: vi.fn(),
    disconnect: vi.fn(),
    setExecution: vi.fn(),
  },
  projects: {
    list: undefined as unknown,
    github: undefined as unknown,
    startGithubInstall: vi.fn(),
    createCloudProject: vi.fn(),
    finishGithubConnect: vi.fn(),
  },
}));

const requiredHandler = (
  handlers: Map<unknown, ReturnType<typeof vi.fn>>,
  ref: unknown,
) => {
  const handler = handlers.get(ref);
  if (!handler) throw new Error(`Missing test handler for ${String(ref)}`);
  return handler;
};

vi.mock("@/global/auth/BackendAuthProvider", () => ({
  useAuthState: () => ({ isAuthenticated: mocks.authenticated, isLoading: false }),
  useQuery: (ref: unknown, args: unknown) => {
    mocks.queryCalls.push({ ref, args });
    return args === "skip" ? undefined : mocks.queries.get(ref);
  },
  useAction: (ref: unknown) => requiredHandler(mocks.actions, ref),
  useMutation: (ref: unknown) => requiredHandler(mocks.mutations, ref),
}));

vi.mock("@/features/cloud/cloud-api", () => ({
}));

vi.mock("@/features/cloud/cloud-projects-api", () => ({
  useCloudProjects: () => mocks.projects.list,
  useGithubConnections: () => mocks.projects.github,
  startGithubInstall: mocks.projects.startGithubInstall,
  createCloudProject: mocks.projects.createCloudProject,
  finishGithubConnect: mocks.projects.finishGithubConnect,
}));

vi.mock("@/features/cloud/cloud-engines-api", () => ({
  useCloudEngines: (enabled: boolean) => (enabled ? mocks.engines : undefined),
  cloudEnginesApi: mocks.enginesApi,
}));

vi.mock("@/features/cloud/cloud-execution-store", () => ({
  publishCloudExecutionSelection: mocks.publishExecution,
}));

vi.mock("@/global/auth/hooks/use-cloud-conversation-session", () => ({
  useCloudConversationSession: () => ({
    isCloudConversationReady: mocks.authenticated,
    accountScope: "account:test-owner",
  }),
}));

vi.mock("@/ui/toast", () => ({ showToast: mocks.showToast }));

import { CloudAccountCards } from "@/features/cloud/CloudAccountCards";

const engineConnections = () => ({
  selectedAt: 1,
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
    mocks.engines = undefined;
    mocks.enginesApi.startConnect.mockReset().mockResolvedValue({
      connectId: "connect-1",
      authorizeUrl: "https://provider.example/authorize",
    });
    mocks.enginesApi.finishConnect.mockReset().mockResolvedValue({ ok: true });
    mocks.enginesApi.disconnect.mockReset().mockResolvedValue(null);
    mocks.enginesApi.setExecution.mockReset().mockResolvedValue(null);
    mocks.projects.list = undefined;
    mocks.projects.github = undefined;
    mocks.projects.startGithubInstall.mockReset().mockResolvedValue({
      installUrl: "https://github.example/install",
    });
    mocks.projects.createCloudProject
      .mockReset()
      .mockResolvedValue({ projectId: "project-1" });
    mocks.projects.finishGithubConnect.mockReset().mockResolvedValue({
      ok: true,
      accountLogin: "octocat",
      accountType: "User",
    });

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

  it("keeps loading surfaces and disables provider connects", async () => {
    await render();

    expect(card("Cloud engines")).toBeTruthy();
    expect(card("Cloud projects")).toBeTruthy();
    const engineConnects = Array.from(
      card("Cloud engines").querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent?.trim() === "Connect");
    expect(engineConnects).toHaveLength(2);
    expect(engineConnects.every((button) => button.disabled)).toBe(true);
  });

  it("publishes the selected engine immediately after the mutation", async () => {
    mocks.engines = engineConnections();
    await render();

    await act(async () => {
      findButton("ChatGPT", card("Cloud engines"))?.click();
      await Promise.resolve();
    });

    const expected = {
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "default",
    };
    expect(mocks.enginesApi.setExecution).toHaveBeenCalledWith(expected);
    expect(mocks.publishExecution).toHaveBeenCalledWith(expected);
  });

  it("requires the explicit GitHub connect-code step and names the account", async () => {
    mocks.projects.list = [];
    mocks.projects.github = { appConfigured: true, connections: [] };
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

    expect(mocks.projects.finishGithubConnect).toHaveBeenCalledWith(
      "ABCD-EFGH-IJKL",
    );
    expect(mocks.showToast).toHaveBeenCalledWith({
      title: "GitHub connected as octocat.",
      variant: "success",
    });
  });

  it("keeps project action failures contained in an error toast", async () => {
    mocks.projects.list = [];
    mocks.projects.github = { appConfigured: true, connections: [] };
    mocks.projects.startGithubInstall.mockRejectedValue(
      new Error("GitHub is unavailable"),
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

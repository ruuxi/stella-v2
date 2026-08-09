// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(() => ({
    cacheScope: "account:test@example.com",
    hasConnectedAccount: true,
  })),
  billing: vi.fn(() => ({ authenticated: true, plan: "pro" })),
  summaryEngine: vi.fn(),
}));

vi.mock("@/convex/api", () => ({
  api: { billing: { getSubscriptionStatus: "billing:getSubscriptionStatus" } },
}));
vi.mock("@/global/billing/SubscriptionUpgradeDialog", () => ({
  SUBSCRIPTION_UPGRADED_EVENT: "stella:subscription-upgraded",
}));
vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: mocks.auth,
}));
vi.mock("@/shared/lib/use-convex-one-shot", () => ({
  usePersistentConvexOneShot: mocks.billing,
}));
vi.mock("@/features/chat/use-agent-progress-summary-engine", () => ({
  useAgentProgressSummaryEngine: mocks.summaryEngine,
}));

import {
  AgentProgressSummaryController,
  canUseStellaProgressSummaries,
  filterProgressSummaryTasks,
  getProgressSummaryProvider,
  isStellaProviderProgressSummaryTask,
} from "@/features/chat/AgentProgressSummaryController";

const task = (
  id: string,
  snapshot?: TaskItem["modelConfigSnapshot"],
  source: TaskItem["source"] = "stella",
): TaskItem => ({
  id,
  description: `Task ${id}`,
  agentType: "general",
  source,
  readOnly: source === "claude-native",
  status: "running",
  ...(snapshot ? { modelConfigSnapshot: snapshot } : {}),
  startedAtMs: 1,
  lastUpdatedAtMs: 1,
});

const stellaTask = task("stella", {
  engine: "default",
  routeModel: "stella/openai/gpt-5.6-sol",
});
const codexTask = task("codex", {
  engine: "codex_cli",
  routeModel: "stella/openai/gpt-5.6-sol",
  engineModel: "gpt-5.6-sol",
});
const claudeTask = task("claude", {
  engine: "claude_code_local",
  routeModel: "stella/anthropic/claude-sonnet-4-5",
  engineModel: "sonnet",
});
const directProviderTask = task("direct", {
  engine: "default",
  routeModel: "openrouter/x-ai/grok-4.5",
});

describe("agent progress summary provider and plan policy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.auth.mockClear();
    mocks.billing.mockReset();
    mocks.billing.mockReturnValue({ authenticated: true, plan: "pro" });
    mocks.summaryEngine.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("classifies only managed Stella routes as Stella-provider work", () => {
    expect(isStellaProviderProgressSummaryTask(stellaTask)).toBe(true);
    expect(isStellaProviderProgressSummaryTask(codexTask)).toBe(false);
    expect(isStellaProviderProgressSummaryTask(claudeTask)).toBe(false);
    expect(isStellaProviderProgressSummaryTask(directProviderTask)).toBe(false);
    expect(
      isStellaProviderProgressSummaryTask(
        task("legacy-claude", undefined, "claude-native"),
      ),
    ).toBe(false);
    expect(getProgressSummaryProvider(task("legacy-stella"))).toBe("unknown");
    expect(isStellaProviderProgressSummaryTask(task("legacy-stella"))).toBe(
      false,
    );
  });

  it("allows Stella summaries only above Go", () => {
    for (const plan of [undefined, "free", "go"]) {
      expect(
        canUseStellaProgressSummaries({
          hasConnectedAccount: true,
          billingStatus: plan ? { authenticated: true, plan } : undefined,
        }),
      ).toBe(false);
    }
    for (const plan of ["pro", "plus", "ultra"]) {
      expect(
        canUseStellaProgressSummaries({
          hasConnectedAccount: true,
          billingStatus: { authenticated: true, plan },
        }),
      ).toBe(true);
    }
    expect(
      canUseStellaProgressSummaries({
        hasConnectedAccount: false,
        billingStatus: { authenticated: true, plan: "pro" },
      }),
    ).toBe(false);
  });

  it("filters Stella work without filtering external-provider work", () => {
    expect(
      filterProgressSummaryTasks(
        [
          stellaTask,
          codexTask,
          claudeTask,
          directProviderTask,
          task("unknown"),
        ],
        false,
      ).map((item) => item.id),
    ).toEqual(["codex", "claude", "direct"]);
  });

  it("does not inspect auth or billing for non-Stella tasks", async () => {
    await act(async () => {
      root.render(
        <AgentProgressSummaryController
          tasks={[codexTask, claudeTask, directProviderTask]}
        />,
      );
    });

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.billing).not.toHaveBeenCalled();
    expect(mocks.summaryEngine).toHaveBeenLastCalledWith([
      codexTask,
      claudeTask,
      directProviderTask,
    ]);
  });

  it("uses the plan path for Stella and keeps external tasks on Free", async () => {
    mocks.billing.mockReturnValue({ authenticated: true, plan: "free" });

    await act(async () => {
      root.render(
        <AgentProgressSummaryController tasks={[stellaTask, codexTask]} />,
      );
    });

    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(mocks.billing).toHaveBeenCalledWith(
      "billing:getSubscriptionStatus",
      {},
      expect.objectContaining({
        refreshCached: false,
        scope: "account:test@example.com",
      }),
    );
    expect(mocks.summaryEngine).toHaveBeenLastCalledWith([codexTask]);
  });
});

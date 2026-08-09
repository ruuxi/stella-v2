import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/api";
import { SUBSCRIPTION_UPGRADED_EVENT } from "@/global/billing/SubscriptionUpgradeDialog";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  isActivityFeedTask,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { usePersistentConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import { useAgentProgressSummaryEngine } from "./use-agent-progress-summary-engine";

const BILLING_CACHE_TTL_MS = 5 * 60 * 1000;

type BillingStatusLite = {
  authenticated?: boolean;
  plan?: string;
};

type ProgressSummaryProvider = "stella" | "external" | "unknown";

/**
 * Progress summaries are billed to Stella only when the task itself is using
 * Stella's managed provider. Native Claude/Codex engines and direct provider
 * routes use the user's selected provider, so account policy must not run for
 * those tasks at all.
 */
export const getProgressSummaryProvider = (
  task: Pick<TaskItem, "modelConfigSnapshot" | "source">,
): ProgressSummaryProvider => {
  if (task.source === "claude-native") return "external";

  const snapshot = task.modelConfigSnapshot;
  // New runs always carry a snapshot. An old row without one cannot be routed
  // safely, so omit its generated summary instead of guessing a provider.
  if (!snapshot) return "unknown";
  if (snapshot.engine !== "default") return "external";

  const routeModel = snapshot.routeModel.trim().toLowerCase();
  return routeModel.length === 0 ||
    routeModel === "stella" ||
    routeModel.startsWith("stella/")
    ? "stella"
    : "external";
};

export const isStellaProviderProgressSummaryTask = (
  task: Pick<TaskItem, "modelConfigSnapshot" | "source">,
): boolean => getProgressSummaryProvider(task) === "stella";

export const canUseStellaProgressSummaries = (args: {
  hasConnectedAccount: boolean;
  billingStatus: BillingStatusLite | undefined;
}): boolean => {
  if (
    !args.hasConnectedAccount ||
    args.billingStatus?.authenticated === false
  ) {
    return false;
  }
  const plan = args.billingStatus?.plan?.trim().toLowerCase();
  return Boolean(plan && plan !== "free" && plan !== "go");
};

export const filterProgressSummaryTasks = (
  tasks: readonly TaskItem[],
  allowStellaProvider: boolean,
): TaskItem[] =>
  tasks.filter((task) => {
    const provider = getProgressSummaryProvider(task);
    return (
      provider === "external" || (provider === "stella" && allowStellaProvider)
    );
  });

const ExternalProgressSummaryRunner = ({
  tasks,
}: {
  tasks: readonly TaskItem[];
}) => {
  const eligibleTasks = useMemo(
    () => filterProgressSummaryTasks(tasks, false),
    [tasks],
  );
  useAgentProgressSummaryEngine(eligibleTasks);
  return null;
};

const StellaPlanAwareProgressSummaryRunner = ({
  tasks,
}: {
  tasks: readonly TaskItem[];
}) => {
  const { cacheScope, hasConnectedAccount } = useAuthSessionState();
  const [billingRefreshKey, setBillingRefreshKey] = useState(0);

  useEffect(() => {
    const handler = () => setBillingRefreshKey((value) => value + 1);
    window.addEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
    return () =>
      window.removeEventListener(SUBSCRIPTION_UPGRADED_EVENT, handler);
  }, []);

  const billingStatus = usePersistentConvexOneShot(
    api.billing.getSubscriptionStatus,
    hasConnectedAccount ? {} : "skip",
    {
      scope: cacheScope,
      ttlMs: BILLING_CACHE_TTL_MS,
      refreshKey: billingRefreshKey,
      // The account pill and model picker already populate this same scoped
      // cache. Reuse it without another request; fetch only when it is absent
      // or expired. An explicit upgrade event refreshes immediately.
      refreshCached: billingRefreshKey > 0,
    },
  ) as BillingStatusLite | undefined;

  const allowStellaProvider = canUseStellaProgressSummaries({
    hasConnectedAccount,
    billingStatus,
  });
  const eligibleTasks = useMemo(
    () => filterProgressSummaryTasks(tasks, allowStellaProvider),
    [allowStellaProvider, tasks],
  );

  useAgentProgressSummaryEngine(eligibleTasks);
  return null;
};

/**
 * Mounts the billing-aware path only while a running Stella-provider task
 * needs summaries. A conversation containing only native/direct-provider work
 * never invokes auth state or billing hooks.
 */
export const AgentProgressSummaryController = ({
  tasks,
}: {
  tasks: readonly TaskItem[];
}) => {
  const hasRunningStellaProviderTask = tasks.some(
    (task) =>
      task.status === "running" &&
      isActivityFeedTask(task) &&
      isStellaProviderProgressSummaryTask(task),
  );

  return hasRunningStellaProviderTask ? (
    <StellaPlanAwareProgressSummaryRunner tasks={tasks} />
  ) : (
    <ExternalProgressSummaryRunner tasks={tasks} />
  );
};

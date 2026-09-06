import { useState, useSyncExternalStore } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { cloudApi } from "@/features/cloud/cloud-api";
import {
  getCloudExecutionSelectionSnapshot,
  publishCloudExecutionSelection,
  subscribeCloudExecutionSelection,
} from "@/features/cloud/cloud-execution-store";
import { useModelCatalog } from "./hooks/use-model-catalog";
import { ProviderModelPanel } from "./ProviderModelPanel";
import { getStellaResolvedModelName } from "./lib/model-catalog";
import { useT } from "@/shared/i18n";

/** The website saves the same account route that cloud turn dispatch reads. */
export function WebsiteModelPicker({
  active = true,
  onSelected,
  className,
}: {
  active?: boolean;
  onSelected?: () => void;
  className?: string;
}) {
  const t = useT();
  const { isAuthenticated } = useConvexAuth();
  const connections = useQuery(
    cloudApi.listMyEngineConnections,
    isAuthenticated ? {} : "skip",
  );
  const setExecution = useMutation(cloudApi.setMyCloudExecution);
  const localExecution = useSyncExternalStore(
    subscribeCloudExecutionSelection,
    getCloudExecutionSelectionSnapshot,
    () => null,
  );
  const execution = localExecution ?? connections?.execution;
  const { groups, models, refresh, refreshing, error: catalogError } = useModelCatalog();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = execution?.engine === "stella" ? execution.model : "";
  const selected = models.find((model) => model.id === current);

  const select = async (model: string) => {
    if (pending || !isAuthenticated || !model) return;
    setPending(true);
    setError(null);
    try {
      const next = {
        engine: "stella" as const,
        provider: "stella" as const,
        model,
        reasoningEffort: execution?.reasoningEffort ?? "default",
      };
      await setExecution({ execution: next });
      publishCloudExecutionSelection(next);
      onSelected?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={["agent-model-picker", className].filter(Boolean).join(" ")}>
      <ProviderModelPanel
        value={current}
        defaultLabel="Stella"
        currentLabel={selected ? getStellaResolvedModelName(selected) : execution?.model ?? "Stella"}
        groups={groups}
        visibleProviders={["stella"]}
        disabled={!active || !isAuthenticated || !connections || pending}
        ariaLabel={t("settings.agentModelPicker.assistantPickerAriaLabel")}
        onSelect={(model) => void select(model)}
        hideDefaultRow
        hideSelectedTitle
        onRefresh={() => void refresh()}
        catalogError={catalogError}
        refreshing={refreshing}
      />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

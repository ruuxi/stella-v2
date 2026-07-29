import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cloudApi } from "@/features/cloud/cloud-api";
import { publishCloudExecutionSelection } from "@/features/cloud/cloud-execution-store";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { showToast } from "@/ui/toast";
import "./CloudModelPicker.css";

type CloudExecutionEngine = CloudExecutionSelection["engine"];

const ENGINE_OPTIONS: ReadonlyArray<{
  engine: CloudExecutionEngine;
  label: string;
  connection?: "anthropic" | "openai-codex";
}> = [
  { engine: "stella", label: "Stella" },
  { engine: "anthropic", label: "Claude", connection: "anthropic" },
  {
    engine: "openai-codex",
    label: "ChatGPT",
    connection: "openai-codex",
  },
];

const DEFAULT_MODEL: Record<CloudExecutionEngine, string> = {
  stella: "stella/anthropic/claude-sonnet-4.6",
  anthropic: "claude-sonnet-4-6",
  "openai-codex": "gpt-5.6-sol",
};

const NATIVE_MODEL_OPTIONS: Record<
  Exclude<CloudExecutionEngine, "stella">,
  ReadonlyArray<{ id: string; label: string }>
> = {
  anthropic: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  ],
  "openai-codex": [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
};

const REASONING_OPTIONS: ReadonlyArray<{
  value: AgentModelReasoningEffort;
  label: string;
}> = [
  { value: "default", label: "Auto" },
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

const sameExecution = (
  left: CloudExecutionSelection,
  right: CloudExecutionSelection,
): boolean =>
  left.engine === right.engine &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort;

const selectionFor = (
  engine: CloudExecutionEngine,
  model: string,
  reasoningEffort: AgentModelReasoningEffort,
): CloudExecutionSelection => {
  if (engine === "stella") {
    return { engine, provider: engine, model, reasoningEffort };
  }
  if (engine === "anthropic") {
    return { engine, provider: engine, model, reasoningEffort };
  }
  return { engine, provider: engine, model, reasoningEffort };
};

const friendlyError = (error: unknown): string => {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  const message = (data as { message?: unknown })?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (error instanceof Error && error.message) return error.message;
  return "Cloud model settings could not be saved.";
};

/**
 * Browser-only model picker. Cloud execution is server-owned, so this surface
 * never reads local preferences or reaches through Electron IPC.
 */
export function CloudModelPicker() {
  const { isAuthenticated } = useConvexAuth();
  const connections = useQuery(
    cloudApi.listMyEngineConnections,
    isAuthenticated ? {} : "skip",
  );
  const saveExecution = useMutation(cloudApi.setMyCloudExecution);
  const { stellaModels, loading: catalogLoading } = useModelCatalog();
  const [optimistic, setOptimistic] = useState<CloudExecutionSelection | null>(
    null,
  );
  const [customModel, setCustomModel] = useState("");
  const [saving, setSaving] = useState(false);

  const execution = optimistic ?? connections?.execution ?? null;
  const connectedProviders = useMemo(
    () => new Set((connections?.connections ?? []).map((row) => row.provider)),
    [connections?.connections],
  );

  useEffect(() => {
    if (
      optimistic &&
      connections?.execution &&
      sameExecution(optimistic, connections.execution)
    ) {
      setOptimistic(null);
    }
  }, [connections?.execution, optimistic]);

  useEffect(() => {
    setCustomModel(execution?.model ?? "");
  }, [execution?.engine, execution?.model]);

  const stellaOptions = useMemo(() => {
    const models = stellaModels
      .filter((model) => model.provider === "stella")
      .map((model) => ({
        id: model.id,
        label: model.name,
        detail: model.upstreamModel,
        disabled: model.allowedForAudience === false,
      }));
    if (
      execution?.engine === "stella" &&
      !models.some((model) => model.id === execution.model)
    ) {
      models.unshift({
        id: execution.model,
        label: execution.model,
        detail: "Current managed route",
        disabled: false,
      });
    }
    return models;
  }, [execution, stellaModels]);

  const nativeOptions = useMemo(() => {
    if (!execution || execution.engine === "stella") return [];
    const options = [...NATIVE_MODEL_OPTIONS[execution.engine]];
    if (!options.some((model) => model.id === execution.model)) {
      options.unshift({ id: execution.model, label: execution.model });
    }
    return options;
  }, [execution]);

  const commit = useCallback(
    async (next: CloudExecutionSelection) => {
      if (execution && sameExecution(execution, next)) return;
      setOptimistic(next);
      setSaving(true);
      try {
        await saveExecution({ execution: next });
        publishCloudExecutionSelection(next);
      } catch (error) {
        setOptimistic(null);
        showToast({ title: friendlyError(error), variant: "error" });
      } finally {
        setSaving(false);
      }
    },
    [execution, saveExecution],
  );

  const chooseEngine = useCallback(
    (engine: CloudExecutionEngine) => {
      if (!execution || engine === execution.engine) return;
      void commit(
        selectionFor(engine, DEFAULT_MODEL[engine], execution.reasoningEffort),
      );
    },
    [commit, execution],
  );

  const chooseModel = useCallback(
    (model: string) => {
      if (!execution) return;
      void commit(
        selectionFor(execution.engine, model, execution.reasoningEffort),
      );
    },
    [commit, execution],
  );

  const chooseReasoning = useCallback(
    (reasoningEffort: AgentModelReasoningEffort) => {
      if (!execution) return;
      void commit(
        selectionFor(execution.engine, execution.model, reasoningEffort),
      );
    },
    [commit, execution],
  );

  if (!isAuthenticated) {
    return (
      <div className="cloud-model-picker cloud-model-picker--centered">
        Sign in to choose a cloud model.
      </div>
    );
  }

  if (!execution) {
    return (
      <div
        className="cloud-model-picker cloud-model-picker--centered"
        aria-busy="true"
      >
        Loading cloud models…
      </div>
    );
  }

  const engineConnected =
    execution.engine === "stella" || connectedProviders.has(execution.provider);

  return (
    <div className="cloud-model-picker">
      <div className="cloud-model-picker__header">
        <div>
          <div className="cloud-model-picker__title">Cloud model</div>
          <div className="cloud-model-picker__subtitle">
            Used by browser chat and cloud agents.
          </div>
        </div>
        <span
          className="cloud-model-picker__status"
          data-saving={saving || undefined}
        >
          {saving ? "Saving…" : "Saved"}
        </span>
      </div>

      <div className="cloud-model-picker__engines" aria-label="Cloud engine">
        {ENGINE_OPTIONS.map((option) => {
          const connected =
            !option.connection || connectedProviders.has(option.connection);
          return (
            <button
              key={option.engine}
              type="button"
              className="cloud-model-picker__engine"
              data-active={execution.engine === option.engine || undefined}
              disabled={saving || !connected}
              title={
                connected
                  ? undefined
                  : option.engine === "anthropic"
                    ? "Connect Claude in Settings first"
                    : "Connect ChatGPT in Settings first"
              }
              onClick={() => chooseEngine(option.engine)}
            >
              {option.label}
              {!connected ? (
                <span className="cloud-model-picker__locked">Connect</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {!engineConnected ? (
        <div className="cloud-model-picker__notice">
          This engine is disconnected. Connect it in Settings before using it.
        </div>
      ) : null}

      <div className="cloud-model-picker__models" aria-label="Models">
        {execution.engine === "stella"
          ? stellaOptions.map((model) => (
              <button
                key={model.id}
                type="button"
                className="cloud-model-picker__model"
                data-active={execution.model === model.id || undefined}
                disabled={saving || model.disabled}
                title={
                  model.disabled
                    ? "This model is not available on your current plan"
                    : undefined
                }
                onClick={() => chooseModel(model.id)}
              >
                <span className="cloud-model-picker__model-copy">
                  <span className="cloud-model-picker__model-name">
                    {model.label}
                  </span>
                  {model.detail ? (
                    <span className="cloud-model-picker__model-detail">
                      {model.detail}
                    </span>
                  ) : null}
                </span>
                {execution.model === model.id ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
              </button>
            ))
          : nativeOptions.map((model) => (
              <button
                key={model.id}
                type="button"
                className="cloud-model-picker__model"
                data-active={execution.model === model.id || undefined}
                disabled={saving || !engineConnected}
                onClick={() => chooseModel(model.id)}
              >
                <span className="cloud-model-picker__model-copy">
                  <span className="cloud-model-picker__model-name">
                    {model.label}
                  </span>
                  <span className="cloud-model-picker__model-detail">
                    {model.id}
                  </span>
                </span>
                {execution.model === model.id ? (
                  <span aria-hidden="true">✓</span>
                ) : null}
              </button>
            ))}
        {execution.engine === "stella" &&
        catalogLoading &&
        stellaOptions.length === 0 ? (
          <div className="cloud-model-picker__empty">
            Loading Stella models…
          </div>
        ) : null}
      </div>

      <div className="cloud-model-picker__custom">
        <label htmlFor="cloud-model-id">Exact model ID</label>
        <div className="cloud-model-picker__custom-row">
          <input
            id="cloud-model-id"
            type="text"
            value={customModel}
            onChange={(event) => setCustomModel(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={saving || !engineConnected}
          />
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={
              saving ||
              !engineConnected ||
              !customModel.trim() ||
              customModel.trim() === execution.model
            }
            onClick={() => chooseModel(customModel.trim())}
          >
            Use
          </Button>
        </div>
      </div>

      <div className="cloud-model-picker__footer">
        <span>Reasoning</span>
        <Select
          value={execution.reasoningEffort}
          onValueChange={(value) =>
            chooseReasoning(value as AgentModelReasoningEffort)
          }
          options={REASONING_OPTIONS}
          disabled={saving || !engineConnected}
          aria-label="Cloud reasoning effort"
        />
      </div>
    </div>
  );
}

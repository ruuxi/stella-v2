import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  ENGINE_MODEL_CATALOG,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@stella/contracts/engine-model-catalog";
import { useT } from "../i18n";
import { getBackendClient, readBackendView } from "./backend";
import { authClient } from "./auth-client";
import { getConvexTokenForOwner } from "./auth-token";
import { observeCloudConversationIdentity } from "./cloud-conversation-auth";
import { useConvexTokenOwner } from "./use-convex-token-owner";
import { runOwnerBoundModelRequest } from "./cloud-model-selection";
import {
  fetchStellaCatalog,
  STELLA_DEFAULT_MODEL,
  stellaModelLabel,
  type StellaCatalog,
} from "./stella-model-catalog";
import { notifyError } from "./haptics";
import { userFacingError } from "./user-facing-error";

export type ModelEngine = CloudExecutionSelection["engine"];

export const MODEL_ENGINE_OPTIONS: ReadonlyArray<{ id: ModelEngine; label: string }> = [
  { id: "stella", label: "Stella" },
  { id: "anthropic", label: "Claude Code" },
  { id: "openai-codex", label: "Codex" },
];

const EMPTY_CATALOG: StellaCatalog = { models: [], agentKeys: [] };
const EMPTY_ENGINE_MODELS: EngineModelCatalog = { claude: [], codex: [] };

export type ModelOption = {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  /** False when the account's plan can't use this model. */
  available: boolean;
};

type LoadedState = {
  scope: string;
  execution: CloudExecutionSelection;
  catalog: StellaCatalog;
  engineModels: EngineModelCatalog;
  connectedProviders: string[];
};

const engineModelList = (
  engineModels: EngineModelCatalog,
  engine: ModelEngine,
): EngineModelOption[] =>
  engine === "anthropic"
    ? engineModels.claude
    : engine === "openai-codex"
      ? engineModels.codex
      : [];

/** The first model an engine lands on when the user switches to it. */
const defaultModelFor = (
  engine: ModelEngine,
  engineModels: EngineModelCatalog,
): string =>
  engine === "stella"
    ? STELLA_DEFAULT_MODEL
    : (engineModelList(engineModels, engine)[0]?.id ??
      (engine === "anthropic" ? "default" : "gpt-6-sol"));

/**
 * The account's model selection. Lists and the saved choice both come from
 * the server, never from a paired computer; the desktop mirrors the saved
 * choice into its local runtime, so one pick applies to cloud and computer
 * turns alike.
 */
export function useCloudModelSettings(active: boolean) {
  const t = useT();
  const session = authClient.useSession();
  const identity = useMemo(
    () => observeCloudConversationIdentity(session.data),
    [session.data?.user?.id, session.data?.session?.id],
  );
  const owner = useConvexTokenOwner(identity).identity;
  const scope = owner ? `${owner.identityKey}:${owner.identityRevision}` : null;
  const currentScope = useRef<string | null>(scope);
  const writePending = useRef(false);
  const readRevision = useRef(0);
  const [state, setState] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    currentScope.current = scope;
    writePending.current = false;
    setSaving(false);
    setLoading(false);
    return () => { currentScope.current = null; };
  }, [scope]);
  const loaded = state?.scope === scope ? state : null;
  const execution = loaded?.execution ?? null;
  const catalog = loaded?.catalog ?? EMPTY_CATALOG;
  const engineModels = loaded?.engineModels ?? EMPTY_ENGINE_MODELS;
  const connectedProviders = loaded?.connectedProviders;

  const refresh = useCallback(async () => {
    if (!owner || !scope || !active || writePending.current) return;
    const revision = ++readRevision.current;
    setLoading(true);
    try {
      const next = await runOwnerBoundModelRequest({
        getToken: () => getConvexTokenForOwner(owner.userSubject, owner.expectedSubject),
        isCurrent: () => currentScope.current === scope && readRevision.current === revision,
        request: async (token) => {
          const [settings, catalog] = await Promise.all([
            readBackendView("engines.get", {}),
            fetchStellaCatalog({ headers: { Authorization: `Bearer ${token}` } }),
          ]);
          return {
            execution: settings.execution,
            connectedProviders: settings.connections.map((row) => row.provider),
            engineModels: ENGINE_MODEL_CATALOG,
            catalog,
          };
        },
      });
      if (next) setState({ scope, ...next });
    } catch (error) {
      if (currentScope.current === scope) {
        Alert.alert(t("settings.compactModelList.loadFailed"), userFacingError(error));
      }
    } finally {
      if (currentScope.current === scope && readRevision.current === revision) setLoading(false);
    }
  }, [owner, scope, active, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  const apply = useCallback(async (next: CloudExecutionSelection) => {
    if (!active || !owner || !scope || !loaded || writePending.current) return;
    writePending.current = true;
    ++readRevision.current;
    setLoading(false);
    setSaving(true);
    // Show the pick immediately; a failed save restores the previous one.
    const previous = loaded;
    setState({ ...loaded, execution: next });
    try {
      await runOwnerBoundModelRequest({
        getToken: () => getConvexTokenForOwner(owner.userSubject, owner.expectedSubject),
        isCurrent: () => currentScope.current === scope,
        request: async () => {
          await getBackendClient().call("engines.setExecution", { execution: next });
        },
      });
    } catch (error) {
      if (currentScope.current === scope) {
        setState(previous);
        notifyError();
        Alert.alert(t("app.chat.miniModelPicker.updateFailedTitle"), userFacingError(error));
      }
    } finally {
      if (currentScope.current === scope) {
        writePending.current = false;
        setSaving(false);
      }
    }
  }, [active, owner, scope, loaded, t]);

  const engine: ModelEngine = execution?.engine ?? "stella";
  const effort = execution?.reasoningEffort ?? "default";

  const selectEngineModel = useCallback(
    (targetEngine: ModelEngine, model: string) => {
      if (!execution) return;
      if (targetEngine === "stella") {
        const allowed =
          model === STELLA_DEFAULT_MODEL ||
          catalog.models.some((entry) => entry.id === model && entry.allowedForAudience);
        if (!allowed) return;
        void apply({ engine: "stella", provider: "stella", model, reasoningEffort: "default" });
        return;
      }
      if (!engineModelList(engineModels, targetEngine).some((entry) => entry.id === model)) {
        return;
      }
      // Keep the engine's effort when staying on it; a new engine starts on Auto.
      const reasoningEffort = execution.engine === targetEngine ? execution.reasoningEffort : "default";
      void apply(
        targetEngine === "anthropic"
          ? { engine: "anthropic", provider: "anthropic", model, reasoningEffort }
          : { engine: "openai-codex", provider: "openai-codex", model, reasoningEffort },
      );
    },
    [apply, catalog.models, engineModels, execution],
  );

  const selectEngine = useCallback(
    (targetEngine: ModelEngine) => {
      if (!execution || targetEngine === execution.engine) return;
      selectEngineModel(targetEngine, defaultModelFor(targetEngine, engineModels));
    },
    [engineModels, execution, selectEngineModel],
  );

  const selectEffort = useCallback(
    (next: CloudExecutionSelection["reasoningEffort"]) => {
      if (execution && execution.engine !== "stella") {
        void apply({ ...execution, reasoningEffort: next });
      }
    },
    [apply, execution],
  );

  const modelsFor = useCallback(
    (targetEngine: ModelEngine): ModelOption[] => {
      const selectedId = execution?.engine === targetEngine ? execution.model : null;
      if (targetEngine === "stella") {
        // The opaque default is always selectable, even when the catalog
        // lists no concrete model for this plan.
        const models = catalog.models.some((model) => model.id === STELLA_DEFAULT_MODEL)
          ? catalog.models
          : [
              { id: STELLA_DEFAULT_MODEL, name: "Stella Recommended", allowedForAudience: true },
              ...catalog.models,
            ];
        return models.map((model) => ({
          id: model.id,
          label: model.name,
          selected: model.id === selectedId,
          available: model.allowedForAudience,
        }));
      }
      return engineModelList(engineModels, targetEngine).map((model) => ({
        id: model.id,
        label: model.name,
        description: model.description,
        selected: model.id === selectedId,
        available: true,
      }));
    },
    [catalog.models, engineModels, execution],
  );

  const label = useMemo(() => {
    if (!execution) return "Stella";
    if (execution.engine === "stella") return stellaModelLabel(catalog, execution.model);
    const name =
      engineModelList(engineModels, execution.engine).find((model) => model.id === execution.model)
        ?.name ?? execution.model;
    return execution.engine === "anthropic" ? `Claude Code · ${name}` : name;
  }, [catalog, engineModels, execution]);

  // The compact composer picker only lists models this plan can use.
  const models = useMemo(
    () => modelsFor(engine).filter((model) => model.available),
    [engine, modelsFor],
  );

  return useMemo(
    () => ({
      execution,
      engine,
      loading,
      saving,
      refresh,
      label,
      effort,
      // Stella-managed runs take their effort from the backend config; only
      // the Claude Code / Codex engines expose one.
      supportsEffortSelection: Boolean(execution && execution.engine !== "stella"),
      /** Providers connected for cloud runs; undefined until loaded. */
      connectedProviders,
      models,
      modelsFor,
      selectModel: (model: string) => selectEngineModel(engine, model),
      selectEngineModel,
      selectEngine,
      selectEffort,
    }),
    [
      connectedProviders,
      effort,
      engine,
      execution,
      label,
      loading,
      models,
      modelsFor,
      refresh,
      saving,
      selectEffort,
      selectEngine,
      selectEngineModel,
    ],
  );
}

export type ModelSettings = ReturnType<typeof useCloudModelSettings>;

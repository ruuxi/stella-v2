import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { env } from "../config/env";
import { useT } from "../i18n";
import { authClient } from "./auth-client";
import { getConvexTokenForOwner } from "./auth-token";
import { observeCloudConversationIdentity } from "./cloud-conversation-auth";
import { useConvexTokenOwner } from "./use-convex-token-owner";
import { managedCloudModelSelection, runOwnerBoundModelRequest } from "./cloud-model-selection";
import { fetchStellaCatalog, stellaModelLabel, type StellaCatalog } from "./desktop-model-prefs";
import { notifyError } from "./haptics";
import { userFacingError } from "./user-facing-error";

const readRef = makeFunctionReference<"query", Record<string, never>, {
  execution: CloudExecutionSelection;
}>("cloud_engines:listMyEngineConnections");
const writeRef = makeFunctionReference<"mutation", { execution: CloudExecutionSelection }, null>(
  "cloud_engines:setMyCloudExecution",
);
const EMPTY_CATALOG: StellaCatalog = { models: [], agentKeys: [] };

/** Account preferences use an owner-bound token, independently of the desktop bridge. */
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
  const [state, setState] = useState<{
    scope: string;
    execution: CloudExecutionSelection;
    catalog: StellaCatalog;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => {
    currentScope.current = scope;
    writePending.current = false;
    setSaving(false);
    setLoading(false);
    return () => { currentScope.current = null; };
  }, [scope]);
  const execution = state?.scope === scope ? state.execution : null;
  const catalog = state?.scope === scope ? state.catalog : EMPTY_CATALOG;

  const refresh = useCallback(async () => {
    if (!owner || !scope || !active || writePending.current) return;
    const revision = ++readRevision.current;
    setLoading(true);
    try {
      const next = await runOwnerBoundModelRequest({
        getToken: () => getConvexTokenForOwner(owner.userSubject, owner.expectedSubject),
        isCurrent: () => currentScope.current === scope && readRevision.current === revision,
        request: async (token) => {
          const client = new ConvexHttpClient(env.convexUrl);
          client.setAuth(token);
          const [settings, catalog] = await Promise.all([
            client.query(readRef, {}),
            fetchStellaCatalog({ headers: { Authorization: `Bearer ${token}` } }),
          ]);
          return { execution: settings.execution, catalog };
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
    if (!active || !owner || !scope || !execution || writePending.current) return;
    writePending.current = true;
    ++readRevision.current;
    setLoading(false);
    setSaving(true);
    try {
      const saved = await runOwnerBoundModelRequest({
        getToken: () => getConvexTokenForOwner(owner.userSubject, owner.expectedSubject),
        isCurrent: () => currentScope.current === scope,
        request: async (token) => {
          const client = new ConvexHttpClient(env.convexUrl);
          client.setAuth(token);
          await client.mutation(writeRef, { execution: next });
          return next;
        },
      });
      if (saved) setState({ scope, execution: saved, catalog });
    } catch (error) {
      if (currentScope.current === scope) {
        notifyError();
        Alert.alert(t("app.chat.miniModelPicker.updateFailedTitle"), userFacingError(error));
      }
    } finally {
      if (currentScope.current === scope) {
        writePending.current = false;
        setSaving(false);
      }
    }
  }, [active, owner, scope, execution, catalog, t]);

  return {
    loading,
    saving,
    refresh,
    label: execution ? stellaModelLabel(catalog, execution.model) : "Stella",
    effort: execution?.reasoningEffort ?? "default",
    models: catalog.models.filter((model) => model.allowedForAudience).map((model) => ({
      id: model.id,
      label: model.name,
      selected: execution?.engine === "stella" && execution.model === model.id,
    })),
    selectModel: (model: string) => {
      if (execution && catalog.models.some((entry) => entry.id === model && entry.allowedForAudience)) {
        void apply(managedCloudModelSelection(model, execution));
      }
    },
    selectEffort: (effort: CloudExecutionSelection["reasoningEffort"]) => {
      if (execution) void apply({ ...execution, reasoningEffort: effort });
    },
  };
}

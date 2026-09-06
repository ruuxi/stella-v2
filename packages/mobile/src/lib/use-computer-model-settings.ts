import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert } from "react-native";
import {
  buildRuntimeAssignPatch,
  buildRuntimeSetEffortPatch,
  buildStellaAssignPatch,
  buildStellaClearPatch,
  buildStellaSetEffortPatch,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  getDesktopModelPrefs,
  runtimeSelectedEffort,
  setDesktopModelPrefs,
  STELLA_DEFAULT_MODEL,
  fetchStellaCatalog,
  stellaSelectedEffort,
  stellaModelLabel,
  stellaSelectedModelId,
  type DesktopModelPrefsPatch,
  type DesktopModelSnapshot,
  type ReasoningEffort,
  type StellaCatalog,
} from "./desktop-model-prefs";
import { withDesktopBridgeRecovery } from "./desktop-bridge-chat";
import type { StoredPhoneAccess } from "./phone-access";
import { notifyError } from "./haptics";
import { userFacingError } from "./user-facing-error";

const LABEL_KEY = "stella-mobile.computer-model-label";
const RECENTS_KEY = "stella-mobile.computer-model-recents";
const MAX_RECENTS = 5;

const EMPTY_CATALOG: StellaCatalog = {
  models: [],
  agentKeys: ["orchestrator", "general"],
};

const labelForSnapshot = (
  snapshot: DesktopModelSnapshot,
  catalog: StellaCatalog,
): string => {
  switch (snapshot.agentRuntimeEngine) {
    case "codex_cli":
      return snapshot.codexModel || DEFAULT_CODEX_MODEL;
    case "claude_code_local":
      return snapshot.claudeCodeModel &&
        snapshot.claudeCodeModel !== DEFAULT_CLAUDE_CODE_MODEL
        ? snapshot.claudeCodeModel
        : "Claude Code";
    default:
      return stellaModelLabel(
        catalog,
        stellaSelectedModelId(snapshot) || STELLA_DEFAULT_MODEL,
      );
  }
};

const routeIdForSnapshot = (snapshot: DesktopModelSnapshot): string => {
  switch (snapshot.agentRuntimeEngine) {
    case "codex_cli":
      return `codex-cli/${snapshot.codexModel || DEFAULT_CODEX_MODEL}`;
    case "claude_code_local":
      return `claude-code/${snapshot.claudeCodeModel || DEFAULT_CLAUDE_CODE_MODEL}`;
    default:
      return stellaSelectedModelId(snapshot) || STELLA_DEFAULT_MODEL;
  }
};

const routeFamily = (routeId: string): "codex" | "claude" | "stella" => {
  if (routeId.startsWith("codex-cli/")) return "codex";
  if (routeId.startsWith("claude-code/")) return "claude";
  return "stella";
};

const labelForRoute = (routeId: string, catalog: StellaCatalog): string => {
  if (routeId.startsWith("codex-cli/")) {
    return routeId.slice("codex-cli/".length) || "Codex";
  }
  if (routeId.startsWith("claude-code/")) {
    const model = routeId.slice("claude-code/".length);
    return model && model !== DEFAULT_CLAUDE_CODE_MODEL ? model : "Claude Code";
  }
  return stellaModelLabel(catalog, routeId);
};

const normalizeRecents = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      ),
    ),
  ).slice(0, MAX_RECENTS);
};

export type ComputerRecentModel = {
  id: string;
  label: string;
  selected: boolean;
};

export type ComputerModelSettings = ReturnType<typeof useComputerModelSettings>;

/**
 * Backs the Computer chat's model row: fetches the Stella catalog for the tray
 * and keeps the floating "Model" row's label in sync with the desktop. The
 * label is cached in AsyncStorage so the menu shows the current model instantly
 * without a desktop round-trip; the tray reconciles it via `syncFromSnapshot`.
 */
export function useComputerModelSettings(access: StoredPhoneAccess | null) {
  const [catalog, setCatalog] = useState<StellaCatalog>(EMPTY_CATALOG);
  const [selectedModelLabel, setSelectedModelLabel] = useState("Stella");
  const [snapshot, setSnapshot] = useState<DesktopModelSnapshot | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const catalogRef = useRef<StellaCatalog>(EMPTY_CATALOG);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(LABEL_KEY).then((label) => {
      if (!cancelled && label) setSelectedModelLabel(label);
    });
    void AsyncStorage.getItem(RECENTS_KEY).then((raw) => {
      if (cancelled || !raw) return;
      try {
        setRecentIds(normalizeRecents(JSON.parse(raw)));
      } catch {
        // Ignore a stale/corrupt cache; the next successful selection repairs it.
      }
    });
    void fetchStellaCatalog().then((next) => {
      if (cancelled) return;
      catalogRef.current = next;
      setCatalog(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const nextLabel = labelForSnapshot(snapshot, catalog);
    setSelectedModelLabel(nextLabel);
    void AsyncStorage.setItem(LABEL_KEY, nextLabel);
  }, [catalog, snapshot]);

  const recordRecent = useCallback((routeId: string) => {
    setRecentIds((previous) => {
      const next = [routeId, ...previous.filter((id) => id !== routeId)].slice(
        0,
        MAX_RECENTS,
      );
      void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Reconcile the cached label and mini picker with a fresh desktop snapshot.
  const syncFromSnapshot = useCallback(
    (nextSnapshot: DesktopModelSnapshot) => {
      setSnapshot(nextSnapshot);
      const nextLabel = labelForSnapshot(nextSnapshot, catalogRef.current);
      setSelectedModelLabel(nextLabel);
      void AsyncStorage.setItem(LABEL_KEY, nextLabel);
      recordRecent(routeIdForSnapshot(nextSnapshot));
    },
    [recordRecent],
  );

  const refresh = useCallback(async () => {
    if (!access || loading) return;
    setLoading(true);
    try {
      syncFromSnapshot(
        await withDesktopBridgeRecovery(access, getDesktopModelPrefs),
      );
    } finally {
      setLoading(false);
    }
  }, [access, loading, syncFromSnapshot]);

  useEffect(() => {
    setSnapshot(null);
    if (access) void refresh().catch(() => undefined);
    // Access identity is the refresh boundary; `refresh` also changes with its
    // loading latch and must not turn one load into a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access?.desktopDeviceId]);

  const applyPatch = useCallback(
    async (patch: DesktopModelPrefsPatch) => {
      if (!access || saving) return;
      setSaving(true);
      try {
        syncFromSnapshot(
          await withDesktopBridgeRecovery(access, (bridge) =>
            setDesktopModelPrefs(bridge, patch),
          ),
        );
      } catch (error) {
        notifyError();
        Alert.alert("Couldn't update model", userFacingError(error));
      } finally {
        setSaving(false);
      }
    },
    [access, saving, syncFromSnapshot],
  );

  const selectedEffort: ReasoningEffort = snapshot
    ? snapshot.agentRuntimeEngine === "codex_cli" ||
      snapshot.agentRuntimeEngine === "claude_code_local"
      ? runtimeSelectedEffort(snapshot, snapshot.agentRuntimeEngine)
      : stellaSelectedEffort(snapshot)
    : "default";

  const selectEffort = useCallback(
    (effort: ReasoningEffort) => {
      if (!snapshot) return;
      const engine = snapshot.agentRuntimeEngine;
      void applyPatch(
        engine === "codex_cli" || engine === "claude_code_local"
          ? buildRuntimeSetEffortPatch(engine, effort)
          : buildStellaSetEffortPatch(snapshot, catalog.agentKeys, effort),
      );
    },
    [applyPatch, catalog.agentKeys, snapshot],
  );

  const selectRecentModel = useCallback(
    (routeId: string) => {
      if (!snapshot) return;
      // Recents span every engine/provider, so route by the recent id's own
      // family — not the active engine — and switch `agentRuntimeEngine` as
      // needed. Mirrors desktop's `buildRecentModelSelectionPatch`, where a
      // recent pick implies its engine.
      const family = routeFamily(routeId);
      let patch: DesktopModelPrefsPatch | null = null;
      if (family === "codex") {
        patch = {
          ...buildRuntimeAssignPatch(
            snapshot,
            "codex_cli",
            catalog.agentKeys,
            routeId.slice("codex-cli/".length),
            runtimeSelectedEffort(snapshot, "codex_cli"),
          ),
          agentRuntimeEngine: "codex_cli",
        };
      } else if (family === "claude") {
        patch = {
          ...buildRuntimeAssignPatch(
            snapshot,
            "claude_code_local",
            catalog.agentKeys,
            routeId.slice("claude-code/".length),
            runtimeSelectedEffort(snapshot, "claude_code_local"),
          ),
          agentRuntimeEngine: "claude_code_local",
        };
      } else {
        const base =
          routeId === STELLA_DEFAULT_MODEL
            ? buildStellaClearPatch(snapshot, catalog.agentKeys)
            : buildStellaAssignPatch(
                snapshot,
                catalog.agentKeys,
                routeId,
                stellaSelectedEffort(snapshot),
              );
        patch = { ...base, agentRuntimeEngine: "default" };
      }
      if (patch) void applyPatch(patch);
    },
    [applyPatch, catalog.agentKeys, snapshot],
  );

  // Mirrors desktop's MiniModelPicker (`buildRecentModelRows`): the current
  // selection first, then the freshest recents across ALL engines/providers
  // (Stella, Codex, Claude Code, BYOK), deduped and capped. Desktop does NOT
  // gate the recents to the active engine, so neither do we.
  const recentModels = useMemo<ComputerRecentModel[]>(() => {
    if (!snapshot) return [];
    const currentId = routeIdForSnapshot(snapshot);
    return [currentId, ...recentIds]
      .filter((id, index, all) => all.indexOf(id) === index)
      .slice(0, MAX_RECENTS)
      .map((id) => ({
        id,
        label: labelForRoute(id, catalog),
        selected: id === currentId,
      }));
  }, [catalog, recentIds, snapshot]);

  // Only an explicit desktop "off" hides model surfaces: `null` (no snapshot
  // yet) and older desktops without the flag keep them visible.
  const developerModeEnabled = snapshot ? snapshot.developerModeEnabled : null;

  return {
    catalog,
    developerModeEnabled,
    loading,
    recentModels,
    refresh,
    saving,
    selectedEffort,
    selectedModelLabel,
    selectEffort,
    selectRecentModel,
    snapshot,
    syncFromSnapshot,
  };
}

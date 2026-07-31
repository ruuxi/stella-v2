import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  STELLA_DEFAULT_MODEL,
  fetchStellaCatalog,
  stellaModelLabel,
  stellaSelectedModelId,
  type DesktopModelSnapshot,
  type StellaCatalog,
} from "./desktop-model-prefs";

const LABEL_KEY = "stella-mobile.computer-model-label";

const EMPTY_CATALOG: StellaCatalog = { models: [], agentKeys: [] };

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

/**
 * Backs the Computer chat's model row: fetches the Stella catalog for the tray
 * and keeps the floating "Model" row's label in sync with the desktop. The
 * label is cached in AsyncStorage so the menu shows the current model instantly
 * without a desktop round-trip; the tray reconciles it via `syncFromSnapshot`.
 */
export function useComputerModelSettings() {
  const [catalog, setCatalog] = useState<StellaCatalog>(EMPTY_CATALOG);
  const [selectedModelLabel, setSelectedModelLabel] = useState("Stella");
  const catalogRef = useRef<StellaCatalog>(EMPTY_CATALOG);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(LABEL_KEY).then((label) => {
      if (!cancelled && label) setSelectedModelLabel(label);
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

  // Reconcile the cached label with a fresh desktop snapshot (from the tray).
  const syncFromSnapshot = useCallback((snapshot: DesktopModelSnapshot) => {
    const nextLabel = labelForSnapshot(snapshot, catalogRef.current);
    setSelectedModelLabel(nextLabel);
    void AsyncStorage.setItem(LABEL_KEY, nextLabel);
  }, []);

  return { catalog, selectedModelLabel, syncFromSnapshot };
}

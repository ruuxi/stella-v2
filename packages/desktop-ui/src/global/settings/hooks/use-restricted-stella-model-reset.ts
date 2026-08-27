import { useEffect, useMemo, useRef } from "react";
import { useModelCatalog } from "@/global/settings/hooks/use-model-catalog";

type LocalModelPreferences = {
  modelOverrides?: Record<string, string>;
  assistantPropagatedAgents?: string[];
};

const isStellaOverride = (modelId: string | undefined): modelId is string =>
  typeof modelId === "string" && modelId.startsWith("stella/");

export function useRestrictedStellaModelReset() {
  const { models, loading } = useModelCatalog();
  const resetKeyRef = useRef<string | null>(null);

  const availableStellaModelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const model of models) {
      if (model.provider === "stella") {
        ids.add(model.id);
      }
    }
    return ids;
  }, [models]);

  useEffect(() => {
    if (loading) return;

    const resetKey = Array.from(availableStellaModelIds).sort().join("|");
    if (resetKeyRef.current === resetKey) return;

    let cancelled = false;
    resetKeyRef.current = resetKey;

    const resetUnavailableOverrides = async () => {
      let preferences: LocalModelPreferences | null | undefined;
      try {
        preferences =
          await window.electronAPI?.system?.getLocalModelPreferences?.();
      } catch {
        return;
      }
      if (cancelled) return;

      const currentOverrides = preferences?.modelOverrides ?? {};
      const nextOverrides = { ...currentOverrides };
      let changed = false;

      for (const [key, override] of Object.entries(currentOverrides)) {
        if (
          isStellaOverride(override) &&
          !availableStellaModelIds.has(override)
        ) {
          delete nextOverrides[key];
          changed = true;
        }
      }

      if (!changed) return;

      try {
        await window.electronAPI?.system?.setLocalModelPreferences?.({
          modelOverrides: nextOverrides,
          assistantPropagatedAgents:
            preferences?.assistantPropagatedAgents ?? [],
        });
        if (!cancelled) {
          window.dispatchEvent(
            new CustomEvent("stella:local-model-preferences-changed"),
          );
        }
      } catch {
        resetKeyRef.current = null;
      }
    };

    void resetUnavailableOverrides();

    return () => {
      cancelled = true;
    };
  }, [availableStellaModelIds, loading]);
}

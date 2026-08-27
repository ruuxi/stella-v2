import { useCallback, useEffect, useRef } from "react";
import { router } from "@/router";
import {
  getModelRestrictionActionLabel,
  getModelRestrictionDescription,
  isRestrictedModelOverrideAudience,
  type ManagedModelAudience,
} from "@/global/billing/audience";
import { useCapabilityAccess } from "@/global/billing/use-capability-access";
import { BYOK_TOAST_ACTION } from "@/global/billing/byok-action";
import {
  resolveTierRestrictedModelNotice,
  type NoticeRuntimeEngine,
} from "./tier-restricted-model-notice";
import { showToast } from "@/ui/toast";

type LocalModelPreferences = {
  modelOverrides?: Record<string, string>;
  agentRuntimeEngine?: NoticeRuntimeEngine;
};

const buildToastDedupeKey = (
  audience: ManagedModelAudience,
  agent: string,
  model: string,
): string => `${audience}|${agent}|${model}`;

export function useTierRestrictedModelToast() {

  const { audience } = useCapabilityAccess();
  const audienceRef = useRef<ManagedModelAudience | null>(audience);
  audienceRef.current = audience;

  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    seenRef.current = new Set();
  }, [audience]);

  return useCallback(async () => {
    const audience = audienceRef.current;
    if (!isRestrictedModelOverrideAudience(audience) || !audience) return;

    let preferences: LocalModelPreferences | null | undefined;
    try {
      preferences =
        await window.electronAPI?.system?.getLocalModelPreferences?.();
    } catch {
      return;
    }
    const notice = resolveTierRestrictedModelNotice({
      audience,
      agentRuntimeEngine: preferences?.agentRuntimeEngine,
      modelOverrides: preferences?.modelOverrides,
    });
    if (!notice) return;

    const dedupeKey = buildToastDedupeKey(audience, notice.agent, notice.model);
    if (seenRef.current.has(dedupeKey)) return;
    seenRef.current.add(dedupeKey);

    showToast({
      title: "Model not available on your plan",
      description: getModelRestrictionDescription({
        audience,
        modelLabel: notice.modelLabel,
        tense: "is",
      }),
      variant: "error",
      duration: 8000,
      action: {
        label: getModelRestrictionActionLabel(audience),
        onClick: () => {
          void router.navigate({ to: "/billing" });
        },
      },
      secondaryAction: BYOK_TOAST_ACTION,
    });
  }, []);
}

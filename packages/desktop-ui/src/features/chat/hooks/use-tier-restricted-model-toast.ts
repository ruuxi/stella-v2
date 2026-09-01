/**
 * Surface a "this model isn't available on your plan" notice when a user on
 * a restricted tier (anonymous / free / go) submits a chat with a saved
 * non-default Stella model override AND Stella's own runtime is the
 * committed engine.
 *
 * The picker (`AgentModelPicker`) notifies at selection time, but a user
 * whose plan downgrades AFTER they picked a model would never see the
 * picker again before sending — this hook catches that case at submit
 * time. Deduped per (audience, agent, model) combo so it doesn't spam on
 * every send.
 *
 * Backend (`stella_provider/request.ts`) silently coerces the model in
 * either case — this is purely a UX notice.
 */
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
import { presentComposerNotice } from "@/features/chat/composer-notice-store";

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
  // Shares the app's single capability/billing subscription rather than
  // opening a second one — and mounting it here is what keeps the
  // audience snapshot fresh for the non-React streaming error path,
  // since this hook is on every chat send.
  const { audience } = useCapabilityAccess();
  const audienceRef = useRef<ManagedModelAudience | null>(audience);
  audienceRef.current = audience;

  // Reset dedupe set whenever audience changes — re-upgrading should clear
  // prior toasts so a re-downgrade re-notifies.
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

    // Pinned above the composer (toast fallback when no chat surface is
    // mounted): the user has to pick a model or upgrade before their
    // choice takes effect, so it must not slide away on its own.
    presentComposerNotice({
      conversationId: null,
      kind: "upgrade",
      title: "Model not available on your plan",
      description: getModelRestrictionDescription({
        audience,
        modelLabel: notice.modelLabel,
        tense: "is",
      }),
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

/**
 * Settings card: replay onboarding, and pick which onboarding runs.
 *
 * Replay is a light reset — it clears completion, resume state, and any
 * parked hand-off, then lets the shell swap back to onboarding. Nothing
 * about the account, memory, or conversations is touched, so the flow can
 * be re-run as often as needed while it is being tuned.
 */
import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { useT } from "@/shared/i18n";
import { useOnboardingState } from "@/global/onboarding/use-onboarding-state";
import {
  clearOnboardingChatProgress,
  readOnboardingVariant,
  writeOnboardingVariant,
} from "./onboarding-chat-flow";
import { clearPendingHandoff } from "./pending-handoff";
import { resetDiscoveryJob } from "./discovery-job";

const VARIANT_EVENT = "stella:onboarding-variant-changed";
const variantListeners = new Set<() => void>();
const subscribeVariant = (listener: () => void) => {
  variantListeners.add(listener);
  const handler = () => listener();
  window.addEventListener(VARIANT_EVENT, handler);
  return () => {
    variantListeners.delete(listener);
    window.removeEventListener(VARIANT_EVENT, handler);
  };
};

export function OnboardingReplayCard() {
  const t = useT();
  const { reset } = useOnboardingState();
  const variant = useSyncExternalStore(
    subscribeVariant,
    readOnboardingVariant,
    () => "chat" as const,
  );

  const handleReplay = useCallback(() => {
    clearOnboardingChatProgress();
    clearPendingHandoff();
    resetDiscoveryJob();
    reset();
  }, [reset]);

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">
          {t("settings.onboardingReplay.title")}
        </h3>
        <Button
          type="button"
          variant="ghost"
          className="pill-btn"
          onClick={handleReplay}
        >
          {t("settings.onboardingReplay.action")}
        </Button>
      </div>
      <p className="settings-card-desc">
        {t("settings.onboardingReplay.description")}
      </p>
      <div className="settings-card-header">
        <span className="settings-card-desc">
          {t("settings.onboardingReplay.legacyToggle")}
        </span>
        <Switch
          checked={variant === "legacy"}
          hideLabel
          label={t("settings.onboardingReplay.legacyToggle")}
          onCheckedChange={(next) => {
            writeOnboardingVariant(next ? "legacy" : "chat");
            window.dispatchEvent(new Event(VARIANT_EVENT));
          }}
        />
      </div>
    </div>
  );
}

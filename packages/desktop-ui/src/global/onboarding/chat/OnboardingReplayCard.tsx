/**
 * Settings card: replay onboarding.
 *
 * A light reset — it clears completion, resume state, and any parked
 * hand-off, then lets the shell swap back to onboarding. Nothing about the
 * account, memory, or conversations is touched, so the flow can be re-run
 * as often as needed.
 */
import { useCallback } from "react";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import { useOnboardingState } from "@/global/onboarding/use-onboarding-state";
import { clearOnboardingChatProgress } from "./onboarding-chat-flow";
import { clearPendingHandoff } from "./pending-handoff";
import { resetDiscoveryJob } from "./discovery-job";

export function OnboardingReplayCard() {
  const t = useT();
  const { reset } = useOnboardingState();

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
    </div>
  );
}

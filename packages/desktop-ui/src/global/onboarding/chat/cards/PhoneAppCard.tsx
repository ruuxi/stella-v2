/**
 * "Get the app" — the phone app's store link as a QR code, skippable.
 *
 * Nothing to pair: once the phone signs in to the same account it reaches
 * this computer on its own, so the card is only the download.
 */
import { Button } from "@/ui/button";
import { Smartphone } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { GetTheApp } from "@/global/integrations/GetTheApp";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type PhoneAppCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

export function PhoneAppCard({ active, answered, onAnswer }: PhoneAppCardProps) {
  const t = useT();

  if (answered !== undefined) {
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <Smartphone size={15} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {t("global.integrations.getApp.title")}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="obc-card">
      <div className="obc-card__section obc-phone-app">
        <GetTheApp />
      </div>
      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active}
          onClick={() => onAnswer("done")}
        >
          {t("common.continue")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!active}
          onClick={() => onAnswer("skipped")}
        >
          {t("onboarding.chat.gmail.skip")}
        </Button>
      </div>
    </div>
  );
}

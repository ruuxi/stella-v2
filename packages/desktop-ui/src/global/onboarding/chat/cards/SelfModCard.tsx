/**
 * "I can change myself" — the self-modification card (desktop only).
 *
 * One film of the real loop: ask for a feature in Stella, an agent drafts
 * it in her own source with a live preview, and the Update card applies it
 * with the app's focus-pull transition. Continue is never gated; the film
 * can be replayed once it finishes.
 */
import { useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { RotateCcw, Wand2 } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { useChoreography, useTypedText } from "@/global/onboarding/demo/use-choreography";
import {
  SELFMOD_CUES,
  SELFMOD_PROMPT,
  SelfModFilm,
} from "@/global/onboarding/film/selfmod-film";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type SelfModCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

export function SelfModCard({ active, answered, onAnswer }: SelfModCardProps) {
  const t = useT();
  const [done, setDone] = useState(false);
  const film = useChoreography({
    cues: SELFMOD_CUES,
    active: active && answered === undefined,
    onDone: () => setDone(true),
  });
  const typed = useTypedText(SELFMOD_PROMPT, active && !film.has("send"), {
    startDelay: 400,
    charMs: 28,
  });

  const replay = useCallback(() => {
    setDone(false);
    film.restart();
  }, [film]);

  if (answered !== undefined) {
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <Wand2 size={15} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {t("onboarding.chat.selfmod.settledTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.selfmod.settledDesc")}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="obc-card">
      <div className="obc-card__section">
        <h3 className="obc-card__title">{t("onboarding.chat.selfmod.title")}</h3>
        <p className="obc-card__body">{t("onboarding.chat.selfmod.body")}</p>
      </div>

      <div className="obc-cap-frame">
        <div className="obc-cap-stage obc-cap-stage--film" aria-hidden="true">
          <div className="obc-cap-chapter" data-active>
            <SelfModFilm has={film.has} typed={typed.value} typing={typed.typing} />
          </div>
        </div>
        <button
          type="button"
          className="obc-cap-replay"
          data-visible={done || undefined}
          disabled={!done}
          aria-label={t("onboarding.chat.capabilities.replay")}
          onClick={replay}
        >
          <RotateCcw size={12} />
        </button>
      </div>

      <ol className="obc-steps">
        {(["ask", "preview", "update"] as const).map((step, index) => (
          <li key={step} className="obc-steps__item">
            <span className="obc-steps__num">{index + 1}</span>
            <span className="obc-steps__text">
              <b>{t(`onboarding.chat.selfmod.steps.${step}.title`)}</b>
              <span>{t(`onboarding.chat.selfmod.steps.${step}.body`)}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active}
          onClick={() => onAnswer("done")}
        >
          {t("common.continue")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">{t("onboarding.chat.selfmod.hint")}</span>
      </div>
    </div>
  );
}

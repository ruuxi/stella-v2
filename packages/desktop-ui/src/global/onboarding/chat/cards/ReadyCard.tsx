/**
 * The finale — "Here's what I picked up."
 *
 * The payoff for the discovery step: a few phrases Stella now knows about
 * the person, four starters written for them, and the raw notes behind it
 * a click away. Tapping a starter opens the real thread with that request
 * already sent; "Start chatting" opens it empty. If discovery was skipped
 * (or is still running) the card degrades gracefully instead of stalling.
 */
import { useMemo } from "react";
import { Button } from "@/ui/button";
import { ChevronDown } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import type { OnboardingStarter } from "@stella/contracts/desktop/onboarding";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";
import { useDiscoveryJob } from "../discovery-job";
import type { PendingComposerDraft } from "../pending-handoff";

type ReadyCardProps = {
  active: boolean;
  discoveryAnswered: OnboardingChatAnswer | undefined;
  onStart: (draft?: PendingComposerDraft) => void;
};

const GENERIC_STARTER_KEYS = [
  "onboarding.chat.ready.generic.plan",
  "onboarding.chat.ready.generic.browse",
  "onboarding.chat.ready.generic.file",
  "onboarding.chat.ready.generic.watch",
] as const;

export function ReadyCard({
  active,
  discoveryAnswered,
  onStart,
}: ReadyCardProps) {
  const t = useT();
  const job = useDiscoveryJob();

  const genericStarters = useMemo<OnboardingStarter[]>(
    () =>
      GENERIC_STARTER_KEYS.map((key) => ({
        title: t(`${key}.title`),
        prompt: t(`${key}.prompt`),
      })),
    [t],
  );

  const pending =
    discoveryAnswered === "accepted" &&
    (job.status === "collecting" ||
      job.status === "synthesizing" ||
      job.status === "saving");
  const result = job.status === "done" ? job.result : null;
  const highlights = result?.profileHighlights ?? [];
  const starters =
    result && result.starters.length > 0 ? result.starters : genericStarters;
  const personalized = Boolean(result);

  return (
    <div className="obc-card">
      {pending ? (
        <div className="obc-card__section">
          <span className="obc-card__label">
            {t("onboarding.chat.ready.pendingLabel")}
          </span>
          <div className="obc-chips" aria-hidden="true">
            <span className="obc-skeleton" style={{ width: 96 }} />
            <span className="obc-skeleton" style={{ width: 128 }} />
            <span className="obc-skeleton" style={{ width: 84 }} />
          </div>
          <p className="obc-card__body">{t("onboarding.chat.ready.pendingBody")}</p>
        </div>
      ) : highlights.length > 0 ? (
        <div className="obc-card__section">
          <span className="obc-card__label">
            {t("onboarding.chat.ready.highlightsLabel")}
          </span>
          <div className="obc-chips">
            {highlights.map((highlight, index) => (
              <span
                key={highlight}
                className="obc-chip"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                {highlight}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="obc-card__section">
        <span className="obc-card__label">
          {personalized
            ? t("onboarding.chat.ready.startersLabelPersonal")
            : t("onboarding.chat.ready.startersLabel")}
        </span>
        {pending ? (
          <div className="obc-starters" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <div className="obc-starter" key={index}>
                <span className="obc-skeleton" style={{ width: "60%" }} />
                <span className="obc-skeleton" style={{ width: "90%" }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="obc-starters">
            {starters.map((starter, index) => (
              <button
                key={`${starter.title}:${index}`}
                type="button"
                className="obc-starter"
                disabled={!active}
                style={{ animationDelay: `${index * 50}ms` }}
                onClick={() => onStart({ text: starter.prompt, send: true })}
              >
                <span className="obc-starter__title">{starter.title}</span>
                <span className="obc-starter__prompt">{starter.prompt}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {result?.coreMemory ? (
        <details className="obc-notes">
          <summary>
            {t("onboarding.chat.ready.notesSummary")}
            <ChevronDown size={14} className="obc-notes__chevron" />
          </summary>
          <pre className="obc-notes__body">{result.coreMemory}</pre>
          <div className="obc-notes__foot">{t("onboarding.chat.ready.notesFoot")}</div>
        </details>
      ) : null}

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active}
          onClick={() => onStart()}
        >
          {pending
            ? t("onboarding.chat.ready.startAnyway")
            : t("onboarding.chat.ready.start")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">
          {t("onboarding.chat.ready.hint")}
        </span>
      </div>
    </div>
  );
}

/**
 * "So, what can I do?" — the capabilities card.
 *
 * Five short films (see `film/capability-films.tsx`), each one real request
 * carried out end to end: Stella spawns agents, the camera follows the work,
 * and the result comes back into the chat. User-paced: the word strip jumps
 * to or replays any film, films auto-advance after a short hold, and
 * Continue is never gated.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RotateCcw } from "@/ui/icons";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import {
  useChoreography,
  useTypedText,
  type ChoreographyCue,
} from "@/global/onboarding/demo/use-choreography";
import {
  CAPABILITY_FILMS,
  type CapabilityFilm,
  type CapabilityId,
} from "@/global/onboarding/film/capability-films";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type CapabilitiesCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

const TYPE_CHAR_MS = 26;
const TYPE_START_DELAY_MS = 350;
const AUTO_ADVANCE_HOLD_MS = 1400;

const CHAPTERS = CAPABILITY_FILMS;
type ChapterId = CapabilityId;

const scriptEnd = (cues: ChoreographyCue[]) => cues[cues.length - 1]!.at;

function useChapterScript(
  cues: ChoreographyCue[],
  active: boolean,
  playNonce: number,
  onDone: () => void,
) {
  const { has, restart } = useChoreography({ cues, active, onDone });
  const nonceRef = useRef(playNonce);
  useEffect(() => {
    if (nonceRef.current === playNonce) return;
    nonceRef.current = playNonce;
    if (active) restart();
  }, [active, playNonce, restart]);
  return has;
}

function Chapter({
  spec,
  active,
  playNonce,
  onDone,
}: {
  spec: CapabilityFilm;
  active: boolean;
  playNonce: number;
  onDone: () => void;
}) {
  const has = useChapterScript(spec.cues, active, playNonce, onDone);
  const typed = useTypedText(spec.prompt, active && !has("send"), {
    startDelay: TYPE_START_DELAY_MS,
    charMs: TYPE_CHAR_MS,
  });
  return <>{spec.render({ has, typed: typed.value, typing: typed.typing })}</>;
}

export function CapabilitiesCard({
  active,
  answered,
  onAnswer,
}: CapabilitiesCardProps) {
  const t = useT();
  const [chapterIndex, setChapterIndex] = useState(0);
  const [playNonce, setPlayNonce] = useState(0);
  const [chapterDone, setChapterDone] = useState(false);
  const [playedChapters, setPlayedChapters] = useState<ReadonlySet<ChapterId>>(
    () => new Set(),
  );
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearAdvanceTimer, [clearAdvanceTimer]);

  const handleChapterDone = useCallback(
    (index: number) => {
      const chapter = CHAPTERS[index]!;
      setPlayedChapters((prev) => {
        if (prev.has(chapter.id)) return prev;
        const next = new Set(prev);
        next.add(chapter.id);
        return next;
      });
      setChapterDone(true);
      if (index >= CHAPTERS.length - 1) return;
      clearAdvanceTimer();
      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        setChapterDone(false);
        setChapterIndex(index + 1);
      }, AUTO_ADVANCE_HOLD_MS);
    },
    [clearAdvanceTimer],
  );

  const playChapter = useCallback(
    (index: number) => {
      clearAdvanceTimer();
      setChapterDone(false);
      setChapterIndex(index);
      setPlayNonce((nonce) => nonce + 1);
    },
    [clearAdvanceTimer],
  );

  if (answered !== undefined) {
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <Play size={14} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {t("onboarding.chat.capabilities.settledTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {CHAPTERS.map((chapter) =>
              t(`onboarding.chat.capabilities.${chapter.id}.word`),
            ).join(" · ")}
          </span>
        </span>
      </div>
    );
  }

  const activeChapter = CHAPTERS[chapterIndex]!;

  return (
    <div className="obc-card">
      <h3 className="obc-card__title" key={activeChapter.id}>
        {t(`onboarding.chat.capabilities.${activeChapter.id}.title`)}
      </h3>

      <div className="obc-cap-frame">
        <div className="obc-cap-stage obc-cap-stage--film" aria-hidden="true">
          {/* Only the active chapter mounts so inactive demos never burn frames. */}
          <div key={activeChapter.id} className="obc-cap-chapter" data-active>
            <Chapter
              spec={activeChapter}
              active={active}
              playNonce={playNonce}
              onDone={() => handleChapterDone(chapterIndex)}
            />
          </div>
        </div>
        <button
          type="button"
          className="obc-cap-replay"
          data-visible={chapterDone || undefined}
          disabled={!chapterDone}
          aria-label={t("onboarding.chat.capabilities.replay")}
          onClick={() => playChapter(chapterIndex)}
        >
          <RotateCcw size={12} />
        </button>
      </div>

      <div
        className="obc-cap-words"
        role="tablist"
        aria-label={t("onboarding.chat.capabilities.tablist")}
      >
        {CHAPTERS.map((chapter, index) => {
          const isActive = index === chapterIndex;
          return (
            <button
              key={chapter.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className="obc-cap-words__word"
              data-active={isActive || undefined}
              data-completed={playedChapters.has(chapter.id) || undefined}
              onClick={() => playChapter(index)}
            >
              <span className="obc-cap-words__label">
                {t(`onboarding.chat.capabilities.${chapter.id}.word`)}
              </span>
              <span className="obc-cap-words__track" aria-hidden="true">
                {isActive ? (
                  <span
                    key={playNonce}
                    className="obc-cap-words__fill"
                    style={{ animationDuration: `${scriptEnd(chapter.cues)}ms` }}
                  />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <p className="obc-cap-caption" key={`caption:${activeChapter.id}`}>
        {t(`onboarding.chat.capabilities.${activeChapter.id}.caption`)}
      </p>

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active}
          onClick={() => onAnswer("done")}
        >
          {t("common.continue")}
        </Button>
      </div>
    </div>
  );
}

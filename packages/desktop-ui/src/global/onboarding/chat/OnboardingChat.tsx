/**
 * Chat-style onboarding surface.
 *
 * Looks and behaves like the real chat: the same window chrome, the same
 * assistant rows, the same composer at the bottom. The difference is that
 * the assistant's messages are scripted and each one carries a card. The
 * user answers cards (or types anything into the composer to skip
 * straight in), and the shell swaps to the real conversation on finish.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { InlineWorkingIndicator } from "@/app/chat/InlineWorkingIndicator";
import { Markdown } from "@/app/chat/Markdown";
import { LegalDialog } from "@/global/legal/LegalDialog";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { StellaCharacter, type StellaCharacterState } from "@/ui/stella-character/StellaCharacter";
import type { StellaMarkHandle } from "@/ui/stella-character/rig";
import { LOCALE_NATIVE_LABELS, useI18n, useT } from "@/shared/i18n";
import { useWindowFocus } from "@/shared/hooks/use-window-focus";
import { OnboardingComposer } from "./OnboardingComposer";
import { DiscoveryCard } from "./cards/DiscoveryCard";
import { CapabilitiesCard } from "./cards/CapabilitiesCard";
import { MemoryCard } from "./cards/MemoryCard";
import { ThemeCard } from "./cards/ThemeCard";
import { ExtrasCard } from "./cards/ExtrasCard";
import { ReadyCard } from "./cards/ReadyCard";
import { useDiscoveryJob } from "./discovery-job";
import type { OnboardingChatStep } from "./onboarding-chat-flow";
import type { PendingComposerDraft } from "./pending-handoff";
import {
  useOnboardingChat,
  type OnboardingChatEntry,
  type OnboardingChatHandoff,
} from "./use-onboarding-chat";
import "@/app/chat/full-shell.chat.css";
import "./onboarding-chat.css";

type OnboardingChatProps = {
  isAuthenticated: boolean;
  onComplete: (handoff: OnboardingChatHandoff) => void;
};

type LegalDocument = "terms" | "privacy";

/** Mark edge length, and how far above its target row it floats. */
const MARK_SIZE_PX = 40;
const MARK_OFFSET_PX = MARK_SIZE_PX + 6;
const SPEAKING_MS = 1600;

/** The resting pose while a step waits on the user. */
const STEP_MOODS: Record<OnboardingChatStep, StellaCharacterState> = {
  discovery: "listening",
  capabilities: "idle",
  memory: "idle",
  theme: "listening",
  extras: "idle",
  ready: "happy",
};

/**
 * "By using Stella, you agree to our {terms} and {privacy}." — the
 * placeholders become buttons so word order can follow each locale.
 */
function LegalLine({
  onOpen,
}: {
  onOpen: (document: LegalDocument) => void;
}) {
  const t = useT();
  const parts = t("onboarding.legalFooter").split(/\{(\w+)\}/);
  const slots: Record<string, ReactNode> = {
    terms: (
      <button
        type="button"
        className="obc-legal__link"
        onClick={() => onOpen("terms")}
      >
        {t("onboarding.termsOfService")}
      </button>
    ),
    privacy: (
      <button
        type="button"
        className="obc-legal__link"
        onClick={() => onOpen("privacy")}
      >
        {t("onboarding.privacyPolicy")}
      </button>
    ),
  };
  return (
    <p className="obc-legal">
      {parts.map((part, index) =>
        index % 2 === 0 ? (
          <span key={index}>{part}</span>
        ) : (
          <span key={index}>{slots[part] ?? `{${part}}`}</span>
        ),
      )}
    </p>
  );
}

export function OnboardingChat({ isAuthenticated, onComplete }: OnboardingChatProps) {
  const t = useT();
  const { locale, setLocale, supportedLocales } = useI18n();
  const job = useDiscoveryJob();
  const windowFocused = useWindowFocus();
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(null);
  const markRef = useRef<StellaMarkHandle | null>(null);

  const { entries, currentStep, answers, indicator, exiting, answer, finish } =
    useOnboardingChat({ onFinished: onComplete });

  // Composer state — fully controlled, like the real chat surfaces.
  const [message, setMessage] = useState("");

  const handleSend = useCallback(() => {
    const text = message.trim();
    if (!text) return;
    finish({ composerDraft: { text, send: true } });
  }, [finish, message]);

  const handleStart = useCallback(
    (draft?: PendingComposerDraft) => {
      markRef.current?.sparkle();
      finish(draft ? { composerDraft: draft } : {});
    },
    [finish],
  );

  const handleSkipAll = useCallback(() => finish({}), [finish]);

  /* ── Scrolling ────────────────────────────────────────────────────
   * A new assistant message scrolls into view from its top (cards are
   * tall); a user bubble or the typing indicator pins to the bottom. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastEntryId = entries[entries.length - 1]?.id ?? null;
  const lastEntryKind = entries[entries.length - 1]?.kind ?? null;
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !lastEntryId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = scroller.querySelector<HTMLElement>(
        `[data-obc-entry="${CSS.escape(lastEntryId)}"]`,
      );
      if (lastEntryKind === "assistant" && target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [lastEntryId, lastEntryKind]);

  useEffect(() => {
    if (!indicator.active) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const frame = window.requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [indicator.active]);

  /* ── The mark travels with the conversation ─────────────────────
   * It sits above whatever Stella is doing right now: the typing indicator
   * while she "types", then the message that lands in that spot. Position
   * is measured from the DOM and animated with a CSS transition, so the
   * mark glides down the transcript rather than jumping. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [markTop, setMarkTop] = useState<number | null>(null);
  const lastAssistantId =
    [...entries].reverse().find((entry) => entry.kind === "assistant")?.id ?? null;
  const placeMark = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    // Through the hand-off the indicator is still on screen, clearing the
    // row the reply is about to fill; keep the mark there so it doesn't dip
    // back to the previous message for a frame and then drop down again.
    const target =
      indicator.active || indicator.handoff
        ? content.querySelector<HTMLElement>(".obc-indicator")
      : lastAssistantId
        ? content.querySelector<HTMLElement>(
            `[data-obc-entry="${CSS.escape(lastAssistantId)}"]`,
          )
        : null;
    if (!target) return;
    setMarkTop(target.offsetTop - MARK_OFFSET_PX);
  }, [indicator.active, indicator.handoff, lastAssistantId]);

  useLayoutEffect(() => {
    placeMark();
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placeMark());
    observer.observe(content);
    return () => observer.disconnect();
  }, [placeMark, entries.length]);

  // A reply that just landed gets a short "speaking" beat before settling.
  const [speaking, setSpeaking] = useState(false);
  const lastFreshAssistantId =
    [...entries].reverse().find((entry) => entry.kind === "assistant" && entry.fresh)
      ?.id ?? null;
  useEffect(() => {
    if (!lastFreshAssistantId) return;
    setSpeaking(true);
    const timer = window.setTimeout(() => setSpeaking(false), SPEAKING_MS);
    return () => window.clearTimeout(timer);
  }, [lastFreshAssistantId]);

  const jobBusy =
    job.status === "collecting" ||
    job.status === "synthesizing" ||
    job.status === "saving";
  const mood: StellaCharacterState = exiting
    ? "celebrate"
    : indicator.active
      ? "writing"
      : speaking
        ? "speaking"
        : currentStep === "ready"
          ? "happy"
          : jobBusy
            ? "reading"
            : STEP_MOODS[currentStep];

  useEffect(() => {
    if (currentStep === "ready") markRef.current?.sparkle();
  }, [currentStep]);

  /* ── Prose per step ─────────────────────────────────────────────── */
  const proseFor = (step: OnboardingChatStep): string => {
    if (step !== "ready") return t(`onboarding.chat.messages.${step}`);
    if (answers.discovery !== "accepted") {
      return t("onboarding.chat.messages.readyGeneric");
    }
    if (job.status === "done" && job.result?.welcomeMessage) {
      return job.result.welcomeMessage;
    }
    if (job.status === "failed") {
      return t("onboarding.chat.messages.readyFailed");
    }
    return t("onboarding.chat.messages.readyPending");
  };

  const cardFor = (step: OnboardingChatStep): ReactNode => {
    const active = currentStep === step && !exiting;
    const answered = answers[step];
    switch (step) {
      case "discovery":
        return (
          <DiscoveryCard
            active={active}
            answered={answered}
            isAuthenticated={isAuthenticated}
            onAnswer={(kind) => answer(step, kind)}
          />
        );
      case "capabilities":
        return (
          <CapabilitiesCard
            active={active}
            answered={answered}
            onAnswer={(kind) => answer(step, kind)}
          />
        );
      case "memory":
        return (
          <MemoryCard
            active={active}
            answered={answered}
            onAnswer={(kind) => answer(step, kind)}
          />
        );
      case "theme":
        return (
          <ThemeCard
            active={active}
            answered={answered}
            onAnswer={(kind) => answer(step, kind)}
          />
        );
      case "extras":
        return (
          <ExtrasCard
            active={active}
            answered={answered}
            isAuthenticated={isAuthenticated}
            onAnswer={(kind) => answer(step, kind)}
          />
        );
      case "ready":
        return (
          <ReadyCard
            active={active}
            discoveryAnswered={answers.discovery}
            onStart={handleStart}
          />
        );
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  };

  const renderEntry = (entry: OnboardingChatEntry, index: number) => {
    if (entry.kind === "user") {
      return (
        <div
          key={entry.id}
          data-obc-entry={entry.id}
          className={`obc-row obc-row--user event-row event-row--user${entry.fresh ? " event-row--user--just-sent" : ""}`}
        >
          <div className="event-item user chat-bubble-text">
            <div className="event-user-body">
              <div className="event-body">{entry.text}</div>
            </div>
          </div>
        </div>
      );
    }
    const isFirst = index === 0;
    return (
      <div
        key={entry.id}
        data-obc-entry={entry.id}
        className={`obc-row obc-row--assistant event-row event-row--assistant${entry.fresh ? " event-row--assistant--just-arrived" : ""}`}
      >
        <div className="event-item assistant">
          <div className="assistant-message-text chat-bubble-text">
            <Markdown
              text={proseFor(entry.step)}
              cacheKey={`onboarding:${entry.step}`}
              hideHorizontalRules
            />
          </div>
          {cardFor(entry.step)}
          {isFirst ? <LegalLine onOpen={setActiveLegalDoc} /> : null}
        </div>
      </div>
    );
  };

  return (
    <div
      className="obc-surface"
      data-exiting={exiting || undefined}
      data-step={currentStep}
      data-testid="onboarding-chat"
    >
      <LegalDialog
        document={activeLegalDoc}
        onOpenChange={(open) => {
          if (!open) setActiveLegalDoc(null);
        }}
      />

      <div className="obc-dragbar">
        <div className="obc-dragbar__lang">
        <Select
          value={locale}
          aria-label={t("common.language")}
          onValueChange={(value) => setLocale(value)}
          options={supportedLocales.map((code) => ({
            value: code,
            label: LOCALE_NATIVE_LABELS[code],
          }))}
        />
        </div>
        <Button
          type="button"
          size="small"
          variant="ghost"
          className="obc-dragbar__skip"
          disabled={exiting}
          onClick={handleSkipAll}
        >
          {t("onboarding.chat.skipSetup")}
        </Button>
      </div>

      <div className="full-body-main">
        <div className="chat-viewport-region">
          <div ref={scrollRef} className="session-content obc-scroll">
            <div ref={contentRef} className="obc-content">
              <div
                className="obc-mark"
                aria-hidden="true"
                data-visible={markTop !== null || undefined}
                style={markTop !== null ? { top: markTop } : undefined}
              >
                <StellaCharacter
                  className="obc-mark__glyph"
                  handleRef={markRef}
                  size={MARK_SIZE_PX}
                  state={mood}
                  shape="star"
                  ink="aurora"
                  glow
                  followPointer
                  paused={!windowFocused}
                />
              </div>
              {entries.map(renderEntry)}
              <div className="obc-indicator">
                <InlineWorkingIndicator
                  active={indicator.active}
                  handoff={indicator.handoff}
                />
              </div>
              <div className="obc-tail" aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="composer-wrap">
          <OnboardingComposer
            value={message}
            onChange={setMessage}
            onSend={handleSend}
            disabled={exiting}
          />
        </div>
      </div>
    </div>
  );
}

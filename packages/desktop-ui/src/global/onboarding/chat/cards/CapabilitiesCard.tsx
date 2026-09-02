/**
 * "So, what can I do?" — the capabilities card.
 *
 * Five short chapters, each a real request typed into a faithful mock of
 * the app on the left while a second window on the right shows what Stella
 * is actually doing: filling a reservation form, checking out a pair of
 * shoes (with the user's confirmation), updating a spreadsheet, assembling
 * a website and putting it live, dropping a mod into a game. User-paced:
 * the word strip jumps or replays any chapter, chapters auto-advance after
 * a short hold, and Continue is never gated.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Clock,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Globe,
  Play,
  Presentation,
  RotateCcw,
  Box,
  Code,
  type IconComponent,
} from "@/ui/icons";
import { Button } from "@/ui/button";
import { useT } from "@/shared/i18n";
import {
  DemoBubble,
  DemoChat,
  DemoComposer,
  DemoShell,
  DemoWorkCard,
  DemoWorking,
} from "@/global/onboarding/demo/DemoShell";
import {
  DemoSplit,
  GameScene,
  ReservationScene,
  SheetScene,
  ShopScene,
  SiteScene,
  type Has,
} from "@/global/onboarding/demo/DemoScenes";
import {
  useChoreography,
  useTypedText,
  type ChoreographyCue,
} from "@/global/onboarding/demo/use-choreography";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type CapabilitiesCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

type ChapterId = "errands" | "shopping" | "work" | "build" | "games";

const TYPE_CHAR_MS = 26;
const TYPE_START_DELAY_MS = 300;
const AUTO_ADVANCE_HOLD_MS = 1700;

type Receipt = { cue: string; icon: IconComponent; label: string };

type ChapterSpec = {
  id: ChapterId;
  cues: ChoreographyCue[];
  prompt: string;
  workingLabel: string;
  reply: string;
  receipts: Receipt[];
  /** The "with your OK" moment — a confirm card in the chat. */
  confirm?: { cue: string; doneCue: string; label: string; amount: string };
  scene: (has: Has) => ReactNode;
};

const CHAPTERS: ChapterSpec[] = [
  {
    id: "errands",
    cues: [
      { id: "send", at: 1500 },
      { id: "working", at: 1900 },
      { id: "page", at: 2300 },
      { id: "fill-1", at: 3000 },
      { id: "fill-2", at: 3500 },
      { id: "fill-3", at: 4000 },
      { id: "click", at: 4700 },
      { id: "confirmed", at: 5300 },
      { id: "work-1", at: 5400 },
      { id: "work-1-done", at: 5500 },
      { id: "work-2", at: 5900 },
      { id: "work-2-done", at: 6600 },
      { id: "reply", at: 7000 },
      { id: "end", at: 8300 },
    ],
    prompt: "Book sushi for two on Friday at 8",
    workingLabel: "Browsing OpenTable…",
    reply: "Booked Kura Sushi for Friday at 8. The confirmation is in your email.",
    receipts: [
      { cue: "work-1", icon: Globe, label: "opentable.com · Fri 8:00 PM · party of 2" },
      { cue: "work-2", icon: Clock, label: "Added to your calendar" },
    ],
    scene: (has) => <ReservationScene has={has} />,
  },
  {
    id: "shopping",
    cues: [
      { id: "send", at: 1500 },
      { id: "working", at: 1900 },
      { id: "page", at: 2300 },
      { id: "size", at: 3100 },
      { id: "cart", at: 3900 },
      { id: "confirm", at: 4600 },
      { id: "confirm-done", at: 5900 },
      { id: "placed", at: 6400 },
      { id: "work-1", at: 6500 },
      { id: "work-1-done", at: 6700 },
      { id: "reply", at: 7200 },
      { id: "end", at: 8500 },
    ],
    prompt: "Order the trail runners I looked at yesterday, size 10",
    workingLabel: "Finding them…",
    reply: "Ordered. They arrive Thursday, receipt's in your email.",
    receipts: [
      { cue: "work-1", icon: CreditCard, label: "Order #48213 · $129.99 · arrives Thu" },
    ],
    confirm: {
      cue: "confirm",
      doneCue: "confirm-done",
      label: "Trail Runner 2 · size 10",
      amount: "$129.99",
    },
    scene: (has) => <ShopScene has={has} />,
  },
  {
    id: "work",
    cues: [
      { id: "send", at: 1800 },
      { id: "working", at: 2200 },
      { id: "page", at: 2600 },
      { id: "cells-1", at: 3100 },
      { id: "cells-2", at: 3600 },
      { id: "cells-3", at: 4100 },
      { id: "work-1", at: 4300 },
      { id: "work-1-done", at: 4600 },
      { id: "deck", at: 4900 },
      { id: "work-2", at: 5200 },
      { id: "work-2-done", at: 5800 },
      { id: "work-3", at: 5900 },
      { id: "work-3-done", at: 6400 },
      { id: "reply", at: 6900 },
      { id: "end", at: 8100 },
    ],
    prompt: "Update the Q3 sheet and build the board deck",
    workingLabel: "Working in Excel…",
    reply: "Sheet updated and the deck is rebuilt. Want a read-through?",
    receipts: [
      { cue: "work-1", icon: FileSpreadsheet, label: "Q3-revenue.xlsx · 214 cells updated" },
      { cue: "work-2", icon: Presentation, label: "Board deck.pptx · 14 slides" },
      { cue: "work-3", icon: FileText, label: "Summary.docx · drafted" },
    ],
    scene: (has) => <SheetScene has={has} />,
  },
  {
    id: "build",
    cues: [
      { id: "send", at: 1700 },
      { id: "working", at: 2100 },
      { id: "page", at: 2500 },
      { id: "hero", at: 3100 },
      { id: "menu", at: 3700 },
      { id: "order", at: 4300 },
      { id: "work-1", at: 4500 },
      { id: "work-1-done", at: 4800 },
      { id: "pay", at: 5000 },
      { id: "work-2", at: 5200 },
      { id: "work-2-done", at: 5600 },
      { id: "live", at: 6000 },
      { id: "work-3", at: 6100 },
      { id: "work-3-done", at: 6400 },
      { id: "reply", at: 6900 },
      { id: "end", at: 8200 },
    ],
    prompt: "Build me a website for my bakery with online ordering",
    workingLabel: "Building the site…",
    reply: "It's live at marasbakery.com. Orders go straight to your phone.",
    receipts: [
      { cue: "work-1", icon: Code, label: "Built 4 pages from your menu" },
      { cue: "work-2", icon: CreditCard, label: "Online ordering connected" },
      { cue: "work-3", icon: Globe, label: "Published to marasbakery.com" },
    ],
    scene: (has) => <SiteScene has={has} />,
  },
  {
    id: "games",
    cues: [
      { id: "send", at: 1600 },
      { id: "working", at: 2000 },
      { id: "page", at: 2400 },
      { id: "file", at: 3200 },
      { id: "work-1", at: 3300 },
      { id: "work-1-done", at: 3700 },
      { id: "game", at: 4300 },
      { id: "tame", at: 5100 },
      { id: "work-2", at: 5200 },
      { id: "work-2-done", at: 5600 },
      { id: "reply", at: 6100 },
      { id: "end", at: 7400 },
    ],
    prompt: "Add a mod to Minecraft so I can tame foxes",
    workingLabel: "Writing the mod…",
    reply: "Done. Launch the game and hand a fox some berries.",
    receipts: [
      { cue: "work-1", icon: Code, label: "fox-taming-1.0.jar · built" },
      { cue: "work-2", icon: Box, label: "Dropped into your mods folder" },
    ],
    scene: (has) => <GameScene has={has} />,
  },
];

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

function DemoConfirmCard({
  visible,
  done,
  label,
  amount,
}: {
  visible: boolean;
  done: boolean;
  label: string;
  amount: string;
}) {
  return (
    <div className="odemo-confirm" data-visible={visible || undefined} data-done={done || undefined}>
      <span className="odemo-confirm__icon">
        <CreditCard size={11} />
      </span>
      <span className="odemo-confirm__text">
        <b>{done ? "Confirmed" : "Confirm purchase?"}</b>
        <i>
          {label} · {amount}
        </i>
      </span>
      <span className="odemo-confirm__btn">
        {done ? <Check size={10} /> : "Confirm"}
      </span>
    </div>
  );
}

function Chapter({
  spec,
  active,
  playNonce,
  onDone,
}: {
  spec: ChapterSpec;
  active: boolean;
  playNonce: number;
  onDone: () => void;
}) {
  const has = useChapterScript(spec.cues, active, playNonce, onDone);
  const typed = useTypedText(spec.prompt, active && !has("send"), {
    startDelay: TYPE_START_DELAY_MS,
    charMs: TYPE_CHAR_MS,
  });
  const firstReceiptCue = spec.receipts[0]?.cue ?? "reply";
  const firstBusyCue = spec.confirm?.cue ?? firstReceiptCue;

  return (
    <DemoSplit
      chat={
        <DemoShell>
          <DemoChat
            started={has("send")}
            composer={
              <DemoComposer
                value={has("send") ? "" : typed.value}
                typing={typed.typing && !has("send")}
                sending={has("send") && !has("working")}
              />
            }
          >
            <DemoBubble role="user" visible={has("send")}>
              {spec.prompt}
            </DemoBubble>
            <DemoWorking
              visible={has("working") && !has(firstBusyCue)}
              label={spec.workingLabel}
            />
            {spec.confirm ? (
              <DemoConfirmCard
                visible={has(spec.confirm.cue)}
                done={has(spec.confirm.doneCue)}
                label={spec.confirm.label}
                amount={spec.confirm.amount}
              />
            ) : null}
            {spec.receipts.map((receipt) => {
              const Icon = receipt.icon;
              return (
                <DemoWorkCard
                  key={receipt.cue}
                  visible={has(receipt.cue)}
                  done={has(`${receipt.cue}-done`)}
                  icon={<Icon size={12} />}
                >
                  {receipt.label}
                </DemoWorkCard>
              );
            })}
            <DemoBubble role="assistant" visible={has("reply")}>
              {spec.reply}
            </DemoBubble>
          </DemoChat>
        </DemoShell>
      }
      scene={spec.scene(has)}
    />
  );
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
        <div className="obc-cap-stage" aria-hidden="true">
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

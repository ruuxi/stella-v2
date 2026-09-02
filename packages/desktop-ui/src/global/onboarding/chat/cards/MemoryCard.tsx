/**
 * "One conversation" — the chatbot-versus-Stella card.
 *
 * Plays the experience everyone knows first: a sidebar full of threads and
 * an assistant that can't remember last week. One click morphs the same
 * window into Stella, where the same question just gets answered. The
 * point is made by the contrast, not by copy.
 */
import { useCallback, useState } from "react";
import { Button } from "@/ui/button";
import { ArrowRight, MessageSquare } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { ChatbotMock, StellaMemoryMock } from "@/global/onboarding/demo/DemoScenes";
import {
  useChoreography,
  type ChoreographyCue,
} from "@/global/onboarding/demo/use-choreography";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type MemoryCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

const CHATBOT_CUES: ChoreographyCue[] = [
  { id: "q", at: 700 },
  { id: "reply", at: 2100 },
  { id: "end", at: 2600 },
];

const STELLA_CUES: ChoreographyCue[] = [
  { id: "q", at: 500 },
  { id: "recall", at: 1300 },
  { id: "found", at: 2500 },
  { id: "reply", at: 3500 },
  { id: "end", at: 4300 },
];

type Mode = "chatbot" | "stella";

export function MemoryCard({ active, answered, onAnswer }: MemoryCardProps) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("chatbot");
  const [chatbotDone, setChatbotDone] = useState(false);
  const chatbot = useChoreography({
    cues: CHATBOT_CUES,
    active: active && mode === "chatbot",
    onDone: () => setChatbotDone(true),
  });
  const stella = useChoreography({
    cues: STELLA_CUES,
    active: active && mode === "stella",
  });

  const showStella = useCallback(() => setMode("stella"), []);

  if (answered !== undefined) {
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <MessageSquare size={15} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {t("onboarding.chat.memory.settledTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.memory.settledDesc")}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="obc-card">
      <div className="obc-card__section">
        <h3 className="obc-card__title">
          {mode === "stella"
            ? t("onboarding.chat.memory.titleStella")
            : t("onboarding.chat.memory.titleChatbot")}
        </h3>
        <p className="obc-card__body">
          {mode === "stella"
            ? t("onboarding.chat.memory.bodyStella")
            : t("onboarding.chat.memory.bodyChatbot")}
        </p>
      </div>

      <div className="obc-cap-frame">
        <div className="obc-cap-stage obc-cap-stage--memory" aria-hidden="true">
          <div className="omorph" data-mode={mode}>
            <div className="omorph__chatbot">
              <ChatbotMock has={chatbot.has} />
            </div>
            <div className="omorph__stella">
              <StellaMemoryMock has={stella.has} />
            </div>
          </div>
        </div>
      </div>

      <div className="obc-actions">
        {mode === "chatbot" ? (
          <Button
            type="button"
            variant="primary"
            disabled={!active || !chatbotDone}
            onClick={showStella}
          >
            {t("onboarding.chat.memory.showStella")}
            <ArrowRight size={14} />
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={!active}
            onClick={() => onAnswer("done")}
          >
            {t("common.continue")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={!active}
          onClick={() => onAnswer("skipped")}
        >
          {t("onboarding.chat.memory.skip")}
        </Button>
      </div>
    </div>
  );
}

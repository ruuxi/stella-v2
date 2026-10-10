/**
 * "Connect Gmail" — the one connector worth asking about up front.
 *
 * Shown right after sign-in, and only to signed-in users of the desktop app:
 * Gmail connects through the Stella account (the same Store connect flow as
 * Settings › Connectors), so the card just runs `nativeIntegrations.enable`
 * for it. That call opens Google in the browser and resolves once the
 * connection is confirmed, so the card can say "Connected" honestly.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Check, LoaderCircle } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

const GMAIL_CONNECTOR_ID = "gmail";

type GmailCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

type Phase = "idle" | "connecting" | "connected" | "error";

/** Gmail's mark, fitted to the 24px box the other row icons use. */
function GmailMark({ size }: { size: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden
    >
      <g transform="translate(0 3) scale(0.272727) translate(-52 -42)">
        <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path
          fill="#fbbc04"
          d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2"
        />
        <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path
          fill="#c5221f"
          d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2"
        />
      </g>
    </svg>
  );
}

export function GmailCard({ active, answered, onAnswer }: GmailCardProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("idle");

  // Already connected (Settings, another device, an earlier run): say so.
  useEffect(() => {
    if (answered !== undefined) return;
    const api = window.electronAPI?.nativeIntegrations;
    if (!api?.list) return;
    let cancelled = false;
    void api
      .list()
      .then((list) => {
        if (cancelled) return;
        if (list.some((entry) => entry.id === GMAIL_CONNECTOR_ID && entry.enabled)) {
          setPhase((current) => (current === "idle" ? "connected" : current));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [answered]);

  const connect = useCallback(async () => {
    const api = window.electronAPI?.nativeIntegrations;
    if (!api?.enable) {
      setPhase("error");
      return;
    }
    setPhase("connecting");
    try {
      const updated = await api.enable({ id: GMAIL_CONNECTOR_ID });
      setPhase(updated.enabled ? "connected" : "error");
    } catch (error) {
      console.warn("[onboarding-chat] Gmail connect failed", error);
      setPhase("error");
    }
  }, []);

  if (answered !== undefined) {
    const connected = answered === "done";
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          {connected ? <Check size={15} /> : <GmailMark size={15} />}
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {connected
              ? t("onboarding.chat.gmail.settledTitle")
              : t("onboarding.chat.gmail.settledSkippedTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.gmail.settledDesc")}
          </span>
        </span>
      </div>
    );
  }

  const connected = phase === "connected";
  const connecting = phase === "connecting";

  return (
    <div className="obc-card">
      <div className="obc-rows">
        <div className="obc-row-item">
          <span className="obc-row-item__icon">
            <GmailMark size={20} />
          </span>
          <span className="obc-row-item__text">
            <span className="obc-row-item__title">
              {t("onboarding.chat.gmail.title")}
            </span>
            <span className="obc-row-item__desc">
              {t("onboarding.chat.gmail.body")}
            </span>
          </span>
          {connected ? (
            <span className="obc-row-item__done">
              <Check size={14} />
              {t("onboarding.chat.gmail.connected")}
            </span>
          ) : null}
        </div>
      </div>

      {phase === "error" ? (
        <p className="obc-card__fine obc-card__fine--error" role="alert">
          {t("onboarding.chat.gmail.error")}
        </p>
      ) : null}

      <div className="obc-actions">
        {connected ? (
          <Button
            type="button"
            variant="primary"
            disabled={!active}
            onClick={() => onAnswer("done")}
          >
            {t("common.continue")}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="primary"
              disabled={!active || connecting}
              onClick={() => void connect()}
            >
              {connecting ? (
                <>
                  <LoaderCircle
                    className="stella-loader-circle"
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {t("onboarding.chat.gmail.connecting")}
                </>
              ) : (
                t("onboarding.chat.gmail.connect")
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!active}
              onClick={() => onAnswer("skipped")}
            >
              {t("onboarding.chat.gmail.skip")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

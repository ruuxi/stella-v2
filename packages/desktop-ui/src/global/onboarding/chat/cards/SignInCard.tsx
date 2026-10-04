/**
 * "Sign in" — how Stella thinks.
 *
 * Three ways in, any of which is enough: a Stella account (Google or email,
 * the same dialog as the top bar), or the Claude or ChatGPT subscription the
 * user already pays for, used through Claude Code or Codex. Connecting one
 * of those also makes it the engine Stella runs on, the same switch the
 * model picker makes; a lens slides to whichever one is in use, and tapping
 * another connected row moves it.
 *
 * Nothing here blocks: every install already has an anonymous Stella
 * session with free previews, so the step can be skipped.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/ui/brand-icon";
import { Check, KeyRound, LogIn } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { AuthDialog } from "@/global/auth/AuthDialog";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  findOauthCredential,
  useLlmCredentials,
} from "@/global/settings/hooks/use-llm-credentials";
import {
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  type ModelPickerEngine,
} from "@/global/settings/lib/engine-model-routing";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

type SignInCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

type OptionId = "stella" | "claude" | "codex";

const OPTIONS: {
  id: OptionId;
  engine: ModelPickerEngine;
  provider?: string;
  brand: string;
}[] = [
  { id: "stella", engine: "default", brand: "stella" },
  { id: "claude", engine: "claude_code_local", provider: "anthropic", brand: "anthropic" },
  { id: "codex", engine: "codex_cli", provider: "openai-codex", brand: "openai" },
];

const ENGINE_TO_OPTION: Record<ModelPickerEngine, OptionId> = {
  default: "stella",
  claude_code_local: "claude",
  codex_cli: "codex",
};

const readEngine = async (): Promise<ModelPickerEngine | null> => {
  const preferences = await window.electronAPI?.system?.getLocalModelPreferences?.();
  return (preferences?.agentRuntimeEngine as ModelPickerEngine | undefined) ?? null;
};

/** The same engine switch the model picker commits. */
const switchEngine = async (engine: ModelPickerEngine): Promise<boolean> => {
  const system = window.electronAPI?.system;
  const preferences = await system?.getLocalModelPreferences?.();
  if (!system?.setLocalModelPreferences || !preferences) return false;
  if (preferences.agentRuntimeEngine === engine) return true;
  await system.setLocalModelPreferences({
    ...buildEngineRoutingPatch(preferences, engine),
    ...buildEngineTransitionReasoningPatch(preferences, engine),
  });
  window.dispatchEvent(new CustomEvent("stella:local-model-preferences-changed"));
  return true;
};

export function SignInCard({ active, answered, onAnswer }: SignInCardProps) {
  const t = useT();
  const session = useAuthSessionState();
  const credentials = useLlmCredentials();
  const [authOpen, setAuthOpen] = useState(false);
  const [pending, setPending] = useState<OptionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<ModelPickerEngine | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void readEngine().then((current) => {
      if (!cancelled) setEngine(current);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = useMemo<Record<OptionId, boolean>>(
    () => ({
      stella: session.hasConnectedAccount,
      claude: Boolean(findOauthCredential(credentials.oauthCredentials, "anthropic")),
      codex: Boolean(findOauthCredential(credentials.oauthCredentials, "openai-codex")),
    }),
    [credentials.oauthCredentials, session.hasConnectedAccount],
  );
  const anyConnected = connected.stella || connected.claude || connected.codex;
  const inUse: OptionId | null = engine ? ENGINE_TO_OPTION[engine] : null;
  // The lens only marks a choice the user can see is real.
  const lensOn: OptionId | null = inUse && connected[inUse] ? inUse : null;

  const applyEngine = useCallback(async (option: (typeof OPTIONS)[number]) => {
    if (await switchEngine(option.engine)) setEngine(option.engine);
  }, []);

  const handleRow = useCallback(
    async (option: (typeof OPTIONS)[number]) => {
      if (pending) return;
      setError(null);
      if (connected[option.id]) {
        await applyEngine(option);
        return;
      }
      if (option.id === "stella") {
        setAuthOpen(true);
        return;
      }
      setPending(option.id);
      cancelledRef.current = false;
      try {
        await credentials.loginOAuth(option.provider!, { announceConnection: false });
        const validation = await credentials.validateOAuth(option.provider!);
        if (!validation.connected) throw new Error("not connected");
        await credentials.reload();
        await applyEngine(option);
      } catch (caught) {
        if (!cancelledRef.current) {
          console.warn("[onboarding-chat] Subscription sign-in failed", caught);
          setError(t("onboarding.chat.signin.error"));
        }
      } finally {
        setPending(null);
      }
    },
    [applyEngine, connected, credentials, pending, t],
  );

  const handleCancel = useCallback(() => {
    if (pending && pending !== "stella") {
      cancelledRef.current = true;
      const provider = OPTIONS.find((option) => option.id === pending)?.provider;
      if (provider) void credentials.cancelOAuth(provider);
    }
  }, [credentials, pending]);

  /* ── The lens: one highlight that glides to the row in use ─────── */
  const listRef = useRef<HTMLDivElement | null>(null);
  const [lens, setLens] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !lensOn) {
      setLens(null);
      return;
    }
    const row = list.querySelector<HTMLElement>(`[data-option="${lensOn}"]`);
    if (row) setLens({ top: row.offsetTop, height: row.offsetHeight });
  }, [lensOn, answered]);

  if (answered !== undefined) {
    const label =
      lensOn && lensOn !== "stella"
        ? t("onboarding.chat.signin.settledEngine", {
            name: t(`onboarding.chat.signin.options.${lensOn}.title`),
          })
        : connected.stella
          ? t("onboarding.chat.signin.settledStella")
          : t("onboarding.chat.signin.settledSkipped");
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          {anyConnected ? <Check size={15} /> : <KeyRound size={15} />}
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">{label}</span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.signin.settledDesc")}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="obc-card">
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
      <div className="obc-card__section">
        <h3 className="obc-card__title">{t("onboarding.chat.signin.title")}</h3>
        <p className="obc-card__body">{t("onboarding.chat.signin.body")}</p>
      </div>

      <div className="obc-signin" ref={listRef}>
        <span
          className="obc-signin__lens"
          data-visible={lens ? true : undefined}
          style={lens ? { transform: `translateY(${lens.top}px)`, height: lens.height } : undefined}
          aria-hidden="true"
        />
        {OPTIONS.map((option, index) => {
          const isConnected = connected[option.id];
          const isPending = pending === option.id;
          const isInUse = lensOn === option.id;
          const detail =
            option.id === "stella" && isConnected && session.user?.email
              ? session.user.email
              : t(`onboarding.chat.signin.options.${option.id}.body`);
          return (
            <button
              key={option.id}
              type="button"
              className="obc-signin__row"
              data-option={option.id}
              data-connected={isConnected || undefined}
              data-in-use={isInUse || undefined}
              data-pending={isPending || undefined}
              disabled={!active || (pending !== null && !isPending)}
              aria-pressed={isInUse}
              aria-label={`${t(`onboarding.chat.signin.options.${option.id}.title`)}, ${
                isPending
                  ? t("common.loading")
                  : isConnected
                    ? t(isInUse ? "onboarding.chat.signin.inUse" : "onboarding.chat.signin.use")
                    : t(
                        option.id === "stella"
                          ? "onboarding.chat.signin.signIn"
                          : "onboarding.chat.signin.connect",
                      )
              }`}
              style={{ animationDelay: `${index * 70}ms` }}
              onClick={() => void (isPending ? undefined : handleRow(option))}
            >
              <span className="obc-signin__icon">
                <BrandIcon brand={option.brand} size={20} />
              </span>
              <span className="obc-signin__text">
                <span className="obc-signin__title">
                  {t(`onboarding.chat.signin.options.${option.id}.title`)}
                </span>
                <span className="obc-signin__desc">{detail}</span>
              </span>
              <span className="obc-signin__state">
                {isPending ? (
                  <span className="obc-signin__spinner" aria-label={t("common.loading")} />
                ) : isConnected ? (
                  <span className="obc-signin__badge">
                    <svg viewBox="0 0 24 24" width={13} height={13} aria-hidden>
                      <path d="M5 12.8 9.9 17.7 19 7.3" pathLength={24} />
                    </svg>
                    {isInUse
                      ? t("onboarding.chat.signin.inUse")
                      : t("onboarding.chat.signin.use")}
                  </span>
                ) : (
                  <span className="obc-signin__action">
                    {option.id === "stella" ? <LogIn size={13} /> : null}
                    {t(
                      option.id === "stella"
                        ? "onboarding.chat.signin.signIn"
                        : "onboarding.chat.signin.connect",
                    )}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {pending && pending !== "stella" ? (
        <p className="obc-card__fine">
          {t("onboarding.chat.signin.waiting")}{" "}
          <button type="button" className="obc-link-btn" onClick={handleCancel}>
            {t("common.cancel")}
          </button>
        </p>
      ) : error ? (
        <p className="obc-card__fine obc-card__fine--error" role="alert">
          {error}
        </p>
      ) : (
        <p className="obc-card__fine">{t("onboarding.chat.signin.fine")}</p>
      )}

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active || pending !== null}
          onClick={() => onAnswer(anyConnected ? "done" : "skipped")}
        >
          {anyConnected ? t("common.continue") : t("onboarding.chat.signin.skip")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">{t("onboarding.chat.signin.hint")}</span>
      </div>
    </div>
  );
}

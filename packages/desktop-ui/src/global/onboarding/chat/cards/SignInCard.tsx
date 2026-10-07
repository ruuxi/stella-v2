/**
 * "Sign in" — how Stella thinks.
 *
 * Three ways in: a Stella account (Google or email, the same dialog as the
 * top bar), or the Claude or ChatGPT plan the user already pays for. Claude runs through Claude Code on Claude Code's own
 * sign-in: in the desktop app this computer's `claude` signs in (Anthropic's
 * page, then the code it shows pasted here); on the website the owner's
 * cloud signs in the same way. ChatGPT is Sign in with ChatGPT: in the
 * desktop app this computer signs in on its own; on the website it signs in
 * Stella's cloud. Connecting one also makes
 * it the engine Stella runs on, the same switch the model picker makes; a
 * lens slides to whichever one is in use, and tapping another connected row
 * moves it.
 *
 * The step cannot be skipped. Chats are stored in the user's Stella account,
 * so it finishes once that account is signed in; only with chats kept on
 * this computer (Settings) is a connected Claude or ChatGPT plan enough.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/ui/brand-icon";
import { Check, KeyRound, LogIn } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import { AuthDialog } from "@/global/auth/AuthDialog";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import { useChatStorageMode } from "@/features/chat/services/chat-storage-preference";
import { useCloudEngines } from "@/features/cloud/cloud-engines-api";
import { ClaudeLoginPrompt } from "@/features/claude/ClaudeLoginPrompt";
import { useClaudeLocalAccounts } from "@/features/claude/use-claude-local-accounts";
import { useClaudeLogin } from "@/features/claude/use-claude-login";
import { EngineConnectPrompt } from "@/features/cloud/EngineConnectPrompt";
import { useEngineConnect } from "@/features/cloud/use-engine-connect";
import { isEngineConnectionUsable } from "@stella/contracts/backend/engines";
import { announceChatGptPlanUse } from "@/features/chatgpt/ChatGptBrand";
import { useChatGptProfiles } from "@/features/chatgpt/use-chatgpt-profiles";
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

type OptionId = "stella" | "claude" | "chatgpt";

const OPTIONS: {
  id: OptionId;
  engine: ModelPickerEngine;
  brand: string;
}[] = [
  { id: "stella", engine: "default", brand: "stella" },
  { id: "claude", engine: "claude_code_local", brand: "anthropic" },
  { id: "chatgpt", engine: "codex_cli", brand: "openai" },
];

const ENGINE_TO_OPTION: Record<ModelPickerEngine, OptionId> = {
  default: "stella",
  claude_code_local: "claude",
  codex_cli: "chatgpt",
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
  const { isAuthenticated } = useAuthState();
  const engines = useCloudEngines(isAuthenticated);
  const connect = useEngineConnect();
  // ChatGPT: this computer's own sign-in in the desktop app; in a browser,
  // the sign-in of Stella's cloud.
  const chatgpt = useChatGptProfiles();
  // Claude: this computer's Claude Code in the desktop app; in a browser,
  // the owner's cloud.
  const claudeLocal = useClaudeLocalAccounts();
  const storageMode = useChatStorageMode();
  const [authOpen, setAuthOpen] = useState(false);
  const [pending, setPending] = useState<OptionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<ModelPickerEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readEngine().then((current) => {
      if (!cancelled) setEngine(current);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = useMemo<Record<OptionId, boolean>>(() => {
    const connections = engines?.connections ?? [];
    return {
      stella: session.hasConnectedAccount,
      claude: claudeLocal.available
        ? claudeLocal.signedIn
        : connections.some((row) => row.provider === "anthropic" && isEngineConnectionUsable(row)),
      chatgpt: chatgpt.available
        ? chatgpt.usable
        : connections.some((row) => row.provider === "chatgpt" && isEngineConnectionUsable(row)),
    };
  }, [
    chatgpt.available,
    chatgpt.usable,
    claudeLocal.available,
    claudeLocal.signedIn,
    engines?.connections,
    session.hasConnectedAccount,
  ]);
  const anyConnected = connected.stella || connected.claude || connected.chatgpt;
  const canContinue =
    connected.stella || (storageMode === "local" && anyConnected);
  const inUse: OptionId | null = engine ? ENGINE_TO_OPTION[engine] : null;
  // The lens only marks a choice the user can see is real.
  const lensOn: OptionId | null = inUse && connected[inUse] ? inUse : null;

  const { start: startConnect, cancel: cancelConnect } = connect;
  const { signIn: signInChatGpt, cancelSignIn: cancelChatGptSignIn } = chatgpt;

  const applyEngine = useCallback(async (option: (typeof OPTIONS)[number]) => {
    if (await switchEngine(option.engine)) setEngine(option.engine);
  }, []);

  const { reload: reloadClaudeLocal } = claudeLocal;
  const claudeLogin = useClaudeLogin({
    onSignedIn: () => {
      void reloadClaudeLocal();
      void applyEngine(OPTIONS[1]!);
    },
  });
  const { start: startClaudeLogin } = claudeLogin;
  // A Claude sign-in waits on the pasted code rather than on a promise.
  const busyOption: OptionId | null = pending ?? (claudeLogin.open ? "claude" : null);

  const handleRow = useCallback(
    async (option: (typeof OPTIONS)[number]) => {
      if (busyOption) return;
      setError(null);
      if (connected[option.id]) {
        await applyEngine(option);
        return;
      }
      if (option.id === "stella") {
        setAuthOpen(true);
        return;
      }
      if (option.id === "claude") {
        if (claudeLocal.available && !claudeLocal.cliInstalled) {
          setError(t("onboarding.chat.signin.claudeCliMissing"));
          return;
        }
        void startClaudeLogin(
          claudeLocal.available
            ? { place: "local", ...(claudeLocal.defaultSignedOut ? { configId: "default" } : {}) }
            : { place: "cloud" },
        );
        return;
      }
      setPending(option.id);
      try {
        // Resolves false (null) when the user cancels; the live account
        // list marks the row connected on its own.
        if (option.id === "chatgpt" && chatgpt.available) {
          const profile = await signInChatGpt();
          if (profile?.planUsage) {
            announceChatGptPlanUse();
            await applyEngine(option);
          }
        } else if (await startConnect()) {
          announceChatGptPlanUse();
          await applyEngine(option);
        }
      } catch (caught) {
        console.warn("[onboarding-chat] Subscription sign-in failed", caught);
        setError(t("onboarding.chat.signin.error"));
      } finally {
        setPending(null);
      }
    },
    [
      applyEngine,
      busyOption,
      chatgpt.available,
      claudeLocal.available,
      claudeLocal.cliInstalled,
      claudeLocal.defaultSignedOut,
      connected,
      signInChatGpt,
      startClaudeLogin,
      startConnect,
      t,
    ],
  );

  const handleCancel = useCallback(() => {
    if (pending === "chatgpt" && chatgpt.available) cancelChatGptSignIn();
    else if (pending === "chatgpt") cancelConnect();
  }, [cancelChatGptSignIn, cancelConnect, chatgpt.available, pending]);

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
        : t("onboarding.chat.signin.settledStella");
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
          const isPending = busyOption === option.id;
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
              disabled={!active || (busyOption !== null && !isPending)}
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

      {claudeLogin.open ? (
        <ClaudeLoginPrompt login={claudeLogin} />
      ) : connect.flow ? (
        <EngineConnectPrompt connect={connect} />
      ) : pending && pending !== "stella" ? (
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
          disabled={!active || busyOption !== null || !canContinue}
          onClick={() => onAnswer("done")}
        >
          {t("common.continue")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">{t("onboarding.chat.signin.hint")}</span>
      </div>
    </div>
  );
}

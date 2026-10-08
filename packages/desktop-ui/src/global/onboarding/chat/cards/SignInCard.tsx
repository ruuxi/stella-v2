/**
 * "Sign in" — how Stella thinks.
 *
 * Four ways in, any of which is enough: a Stella account (Google or email,
 * the same dialog as the top bar), the Claude or ChatGPT plan the user
 * already pays for, or their own provider API key. Claude runs through Claude
 * Code on Claude Code's own sign-in: in the desktop app this computer's
 * `claude` signs in (approve on Anthropic's page and it finishes by itself);
 * on the website the owner's cloud signs in, with the code Anthropic's page
 * shows pasted here. ChatGPT is Sign in with ChatGPT: in the desktop app this
 * computer signs in on its own; on the website it signs in Stella's cloud.
 * Connecting one also makes
 * it the engine Stella runs on, the same switch the model picker makes; a
 * lens slides to whichever one is in use, and tapping another connected row
 * moves it.
 *
 * Stella models need a Stella account, so Continue waits for one of the
 * four. Continuing without a Stella account moves the engine onto the
 * connected provider so the first message never goes to a Stella model.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { BrandIcon } from "@/ui/brand-icon";
import { Check, KeyRound, LogIn } from "@/ui/icons";
import { Select } from "@/ui/select";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";
import {
  API_KEY_PROVIDERS,
  ASSISTANT_AGENT_KEYS,
  DEFAULT_MODEL_BY_PROVIDER,
} from "@/global/settings/lib/provider-default-models";
import { useLlmCredentials } from "@/global/settings/hooks/use-llm-credentials";
import { useT } from "@/shared/i18n";
import { AuthDialog } from "@/global/auth/AuthDialog";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
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

type OptionId = "stella" | "claude" | "chatgpt" | "apikey";

type Option = {
  id: OptionId;
  engine: ModelPickerEngine;
  brand: string;
};

const BASE_OPTIONS: Option[] = [
  { id: "stella", engine: "default", brand: "stella" },
  { id: "claude", engine: "claude_code_local", brand: "anthropic" },
  { id: "chatgpt", engine: "codex_cli", brand: "openai" },
];

const API_KEY_OPTION: Option = { id: "apikey", engine: "default", brand: "key" };

const ENGINE_TO_OPTION: Record<ModelPickerEngine, OptionId> = {
  default: "stella",
  claude_code_local: "claude",
  codex_cli: "chatgpt",
};

type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

const isApiKeyModel = (model: string | undefined): boolean => {
  const provider = model?.split("/")[0];
  return Boolean(provider && DEFAULT_MODEL_BY_PROVIDER[provider]);
};

const readSelection = async (): Promise<{
  engine: ModelPickerEngine;
  apiKeyModel: boolean;
} | null> => {
  const preferences = await window.electronAPI?.system?.getLocalModelPreferences?.();
  if (!preferences) return null;
  return {
    engine: (preferences.agentRuntimeEngine as ModelPickerEngine | undefined) ?? "default",
    apiKeyModel: isApiKeyModel(preferences.modelOverrides?.orchestrator),
  };
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

const routeToApiKeyProvider = async (provider: string): Promise<boolean> => {
  const system = window.electronAPI?.system;
  const preferences = await system?.getLocalModelPreferences?.();
  const model = DEFAULT_MODEL_BY_PROVIDER[provider];
  if (!system?.setLocalModelPreferences || !preferences || !model) return false;
  const enginePatch =
    preferences.agentRuntimeEngine === "default"
      ? {}
      : {
          ...buildEngineRoutingPatch(preferences, "default"),
          ...buildEngineTransitionReasoningPatch(preferences, "default"),
        };
  const modelOverrides = {
    ...(enginePatch.modelOverrides ?? preferences.modelOverrides ?? {}),
  };
  for (const key of ASSISTANT_AGENT_KEYS) modelOverrides[key] = model;
  await system.setLocalModelPreferences({ ...enginePatch, modelOverrides });
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
  const credentials = useLlmCredentials();
  const apiKeysAvailable = Boolean(window.electronAPI?.system?.saveLlmCredential);
  const options = useMemo(
    () => (apiKeysAvailable ? [...BASE_OPTIONS, API_KEY_OPTION] : BASE_OPTIONS),
    [apiKeysAvailable],
  );
  const [authOpen, setAuthOpen] = useState(false);
  const [pending, setPending] = useState<OptionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<ModelPickerEngine | null>(null);
  const [apiKeyModel, setApiKeyModel] = useState(false);
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [keyProvider, setKeyProvider] = useState<ApiKeyProvider>(API_KEY_PROVIDERS[0]);
  const [keyDraft, setKeyDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void readSelection().then((current) => {
      if (cancelled || !current) return;
      setEngine(current.engine);
      setApiKeyModel(current.apiKeyModel);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connectedApiKeyProvider =
    credentials.apiKeys.find((key) => DEFAULT_MODEL_BY_PROVIDER[key.provider])
      ?.provider ?? null;

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
      apikey: apiKeysAvailable && connectedApiKeyProvider !== null,
    };
  }, [
    apiKeysAvailable,
    chatgpt.available,
    chatgpt.usable,
    claudeLocal.available,
    claudeLocal.signedIn,
    connectedApiKeyProvider,
    engines?.connections,
    session.hasConnectedAccount,
  ]);
  const anyConnected =
    connected.stella || connected.claude || connected.chatgpt || connected.apikey;
  const inUse: OptionId | null = engine
    ? engine === "default" && apiKeyModel
      ? "apikey"
      : ENGINE_TO_OPTION[engine]
    : null;
  // The lens only marks a choice the user can see is real.
  const lensOn: OptionId | null = inUse && connected[inUse] ? inUse : null;

  const { start: startConnect, cancel: cancelConnect } = connect;
  const { signIn: signInChatGpt, cancelSignIn: cancelChatGptSignIn } = chatgpt;

  const applyEngine = useCallback(
    async (option: Option) => {
      if (option.id === "apikey") {
        if (connectedApiKeyProvider && (await routeToApiKeyProvider(connectedApiKeyProvider))) {
          setEngine("default");
          setApiKeyModel(true);
        }
        return;
      }
      if (await switchEngine(option.engine)) {
        setEngine(option.engine);
        setApiKeyModel(false);
      }
    },
    [connectedApiKeyProvider],
  );

  const saveApiKey = useCallback(async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setPending("apikey");
    setError(null);
    try {
      const label =
        LLM_PROVIDERS.find((provider) => provider.key === keyProvider)?.label ?? keyProvider;
      await credentials.saveApiKey(keyProvider, label, trimmed);
      if (await routeToApiKeyProvider(keyProvider)) {
        setEngine("default");
        setApiKeyModel(true);
      }
      setKeyDraft("");
      setKeyFormOpen(false);
    } catch (caught) {
      console.warn("[onboarding-chat] API key save failed", caught);
      setError(t("onboarding.chat.signin.error"));
    } finally {
      setPending(null);
    }
  }, [credentials, keyDraft, keyProvider, t]);

  const handleContinue = useCallback(async () => {
    if (!connected.stella && !lensOn) {
      const fallback = options.find((option) => option.id !== "stella" && connected[option.id]);
      if (fallback) await applyEngine(fallback);
    }
    onAnswer("done");
  }, [applyEngine, connected, lensOn, onAnswer, options]);

  const { reload: reloadClaudeLocal } = claudeLocal;
  const claudeLogin = useClaudeLogin({
    onSignedIn: () => {
      void reloadClaudeLocal();
      void applyEngine(BASE_OPTIONS[1]!);
    },
  });
  const { start: startClaudeLogin } = claudeLogin;
  // A Claude sign-in is open until it finishes or is canceled, not a promise.
  const busyOption: OptionId | null = pending ?? (claudeLogin.open ? "claude" : null);

  const handleRow = useCallback(
    async (option: Option) => {
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
      if (option.id === "apikey") {
        setKeyFormOpen((open) => !open);
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
        {options.map((option, index) => {
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
                {option.id === "apikey" ? (
                  <KeyRound size={18} />
                ) : (
                  <BrandIcon brand={option.brand} size={20} />
                )}
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

      {keyFormOpen ? (
        <form
          className="obc-signin__key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveApiKey();
          }}
        >
          <Select
            value={keyProvider}
            onValueChange={(value) => setKeyProvider(value)}
            aria-label={t("onboarding.chat.signin.options.apikey.title")}
            options={API_KEY_PROVIDERS.map((provider) => ({
              value: provider,
              label: LLM_PROVIDERS.find((entry) => entry.key === provider)?.label ?? provider,
            }))}
          />
          <input
            className="obc-signin__key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyDraft}
            placeholder={LLM_PROVIDERS.find((entry) => entry.key === keyProvider)?.placeholder}
            aria-label={t("onboarding.chat.signin.options.apikey.title")}
            onChange={(event) => setKeyDraft(event.target.value)}
            disabled={!active || pending === "apikey"}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!active || pending === "apikey" || !keyDraft.trim()}
          >
            {t("common.save")}
          </Button>
        </form>
      ) : null}

      {claudeLogin.open ? (
        <ClaudeLoginPrompt login={claudeLogin} />
      ) : connect.flow ? (
        <EngineConnectPrompt connect={connect} />
      ) : pending && pending !== "stella" && pending !== "apikey" ? (
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
          disabled={!active || busyOption !== null || !anyConnected}
          onClick={() => void handleContinue()}
        >
          {t("common.continue")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">{t("onboarding.chat.signin.hint")}</span>
      </div>
    </div>
  );
}

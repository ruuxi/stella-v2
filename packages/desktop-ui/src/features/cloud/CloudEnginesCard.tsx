import { useCallback, useState } from "react";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  isEngineConnectionUsable,
  type ChatGptSharedRegistration,
  type EngineConnection,
  type EngineSettings,
} from "@stella/contracts/backend/engines";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { isWebsiteHost } from "@/platform/capabilities";
import {
  announceChatGptPlanUse,
  ContinueWithChatGptButton,
  ManageChatGptUsageLink,
} from "@/features/chatgpt/ChatGptBrand";
import { ChatGptSharedRegistrations } from "@/features/chatgpt/ChatGptSharedRegistrations";
import { ClaudeAccountsSection } from "@/features/claude/ClaudeAccountsSection";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { EngineAccountList, type EngineAccountRow } from "./EngineAccountList";
import { EngineConnectPrompt } from "./EngineConnectPrompt";
import { useEngineConnect, type EngineConnectOptions } from "./use-engine-connect";
import { publishCloudExecutionSelection } from "./cloud-execution-store";

/**
 * "Claude & ChatGPT accounts" for the Stella account.
 *
 * Claude: Stella never holds a Claude credential. Each computer and the
 * owner's cloud run Claude Code on Claude Code's own sign-in; Stella keeps
 * only which accounts exist, where each is signed in, and which one is
 * active.
 *
 * ChatGPT: Stella's cloud is its own Sign in with ChatGPT host, signed in
 * here and refreshed by the server; its tokens never reach a client. Each
 * computer signs in to ChatGPT separately (Settings › Account, on that
 * computer), and any host can reuse a registration another host made. The
 * cloud's engine is chosen here too.
 */

const K = "settings.engineAccounts";

const rowOf = (row: EngineConnection): EngineAccountRow => ({
  id: row.accountId,
  label: row.name ?? row.label,
  ...(row.email ? { email: row.email } : {}),
  ...(row.plan ? { plan: row.plan } : {}),
  active: row.active,
  ...(row.status ? { status: row.status } : {}),
  ...(row.planUsage !== undefined ? { planUsage: row.planUsage } : {}),
});

function CloudChatGptAccounts({
  settings,
  refreshing,
}: {
  settings: EngineSettings | undefined;
  refreshing: boolean;
}) {
  const t = useT();
  const connect = useEngineConnect();
  const [busy, setBusy] = useState(false);
  const connections = (settings?.connections ?? []).filter(
    (row) => row.provider === "chatgpt",
  );
  const accounts = connections.map(rowOf);
  // Registrations another host made that the cloud hasn't signed in with.
  const shared = (settings?.chatGptRegistrations ?? []).filter(
    (registration: ChatGptSharedRegistration) =>
      (registration.email || registration.name) &&
      !connections.some((row) => row.clientId === registration.clientId),
  );
  const { start } = connect;

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await action();
        if (done) showToast({ title: done });
      } catch (error) {
        showToast({
          title: error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
          variant: "error",
        });
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const signIn = useCallback(
    async (options: EngineConnectOptions = {}) => {
      try {
        if (!(await start(options))) return;
        showToast({ title: t(`${K}.chatgptCloudSignedIn`) });
        announceChatGptPlanUse();
      } catch (error) {
        showToast({
          title: error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
          variant: "error",
        });
      }
    },
    [start, t],
  );
  const disabled = busy || refreshing || connect.flow !== null;

  return (
    <EngineAccountList
      title={t(`${K}.chatgptCloudTitle`)}
      description={`${t(`${K}.chatgptCloudDescription`)} ${
        isWebsiteHost()
          ? t(`${K}.chatgptCloudComputersWebsite`)
          : t(`${K}.chatgptCloudComputersDesktop`)
      }`}
      accounts={accounts}
      busy={busy || refreshing}
      adding={connect.flow !== null}
      onAdd={() => void signIn()}
      addButton={
        <ContinueWithChatGptButton
          onClick={() => void signIn()}
          disabled={disabled}
          loading={connect.busy}
          {...(accounts.length + shared.length > 0
            ? { label: t(`${K}.addAnotherChatgpt`) }
            : {})}
        />
      }
      onUse={(accountId) =>
        void run(() => cloudEnginesApi.setActiveAccount("chatgpt", accountId))
      }
      onSignOut={(accountId) =>
        void run(async () => {
          const result = await cloudEnginesApi.disconnect("chatgpt", accountId);
          if (result && !result.revoked) {
            showToast({
              title: t(`${K}.revokeTitleCloud`),
              description: t(`${K}.revokeUnconfirmed`),
            });
          }
        }, t(`${K}.signedOut`))
      }
      onSignInAgain={(accountId) => void signIn({ accountId })}
      onEnablePlanUsage={(accountId) => void signIn({ accountId, enablePlanUsage: true })}
      onRemove={(accountId) =>
        void run(
          () => cloudEnginesApi.disconnect("chatgpt", accountId, { forget: true }),
          t(`${K}.removed`),
        )
      }
      addFlow={
        <>
          <ChatGptSharedRegistrations
            registrations={shared}
            disabled={disabled}
            onContinue={(clientId) => void signIn({ clientId })}
          />
          {connect.flow ? <EngineConnectPrompt connect={connect} /> : null}
        </>
      }
      footer={
        accounts.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-sublabel">{t(`${K}.manageUsageHint`)}</div>
            <div className="settings-row-control">
              <ManageChatGptUsageLink />
            </div>
          </div>
        ) : null
      }
    />
  );
}

export function CloudEnginesCard() {
  const t = useT();
  const { isAuthenticated } = useAuthState();
  const connections = useCloudEngines(isAuthenticated);
  const [switching, setSwitching] = useState(false);

  if (!isAuthenticated) return null;

  const usableProviders = new Set<string>(
    (connections?.connections ?? [])
      .filter(isEngineConnectionUsable)
      .map((row) => row.provider),
  );
  const chatEngine = connections?.execution.engine ?? "stella";
  const refreshing = connections === undefined;

  const chooseEngine = async (engine: CloudExecutionSelection["engine"]) => {
    if (engine === chatEngine) return;
    setSwitching(true);
    try {
      const reasoningEffort: AgentModelReasoningEffort =
        connections?.execution.reasoningEffort ?? "default";
      const execution: CloudExecutionSelection =
        engine === "stella"
          ? {
              engine,
              provider: engine,
              // The backend resolves Stella's default model per audience.
              model: "stella/default",
              reasoningEffort,
            }
          : engine === "anthropic"
            ? // Claude Code's own alias: the recommended model for the account.
              { engine, provider: engine, model: "default", reasoningEffort }
            : { engine, provider: engine, model: "gpt-6.1-sol", reasoningEffort };
      await cloudEnginesApi.setExecution(execution);
      publishCloudExecutionSelection(execution);
    } catch (error) {
      showToast({
        title: error instanceof Error && error.message ? error.message : t(`${K}.errorGeneric`),
        variant: "error",
      });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t(`${K}.cardTitle`)}</h3>
      <div className="settings-row">
        <div className="settings-row-sublabel">{t(`${K}.cardIntro`)}</div>
      </div>
      <ClaudeAccountsSection settings={connections} refreshing={refreshing} />
      <CloudChatGptAccounts settings={connections} refreshing={refreshing} />
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{t(`${K}.runsOnLabel`)}</div>
          <div className="settings-row-sublabel">{t(`${K}.runsOnDescription`)}</div>
        </div>
        <div
          className="settings-row-control"
          style={{ display: "flex", gap: 6 }}
        >
          <Button
            type="button"
            variant="ghost"
            className={`pill-btn${chatEngine === "stella" ? " pill-btn--active" : ""}`}
            onClick={() => void chooseEngine("stella")}
            disabled={switching}
          >
            Stella
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`pill-btn${chatEngine === "anthropic" ? " pill-btn--active" : ""}`}
            onClick={() => void chooseEngine("anthropic")}
            disabled={switching || !usableProviders.has("anthropic")}
            title={usableProviders.has("anthropic") ? undefined : t(`${K}.needsClaudeCloud`)}
          >
            Claude
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`pill-btn${chatEngine === "chatgpt" ? " pill-btn--active" : ""}`}
            onClick={() => void chooseEngine("chatgpt")}
            disabled={switching || !usableProviders.has("chatgpt")}
            title={usableProviders.has("chatgpt") ? undefined : t(`${K}.needsChatgptCloud`)}
          >
            ChatGPT
          </Button>
        </div>
      </div>
    </div>
  );
}

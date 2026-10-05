import { useCallback, useState } from "react";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import {
  isEngineConnectionUsable,
  type EngineConnection,
  type EngineProvider,
  type EngineSettings,
} from "@stella/contracts/backend/engines";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { isWebsiteHost } from "@/platform/capabilities";
import {
  announceChatGptPlanUse,
  ContinueWithChatGptButton,
  ManageChatGptUsageLink,
} from "@/features/chatgpt/ChatGptBrand";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { EngineAccountList, type EngineAccountRow } from "./EngineAccountList";
import { EngineConnectPrompt } from "./EngineConnectPrompt";
import { useEngineConnect, type EngineConnectOptions } from "./use-engine-connect";
import { publishCloudExecutionSelection } from "./cloud-execution-store";

/**
 * "Claude & ChatGPT": the subscriptions kept with the Stella account.
 *
 * Claude: the owner's one list of Claude subscriptions, powering Claude Code
 * on every one of the owner's computers and cloud turns. Devices sign in and
 * refresh; the server keeps an encrypted token.
 *
 * ChatGPT: Stella's cloud is its own Sign in with ChatGPT host, signed in
 * here and refreshed by the server; its tokens never reach a client. Each
 * computer signs in to ChatGPT separately (Settings › Account, on that
 * computer). The cloud's engine is chosen here too.
 */

const friendlyError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "That didn't work. Try again.";

const rowOf = (row: EngineConnection): EngineAccountRow => ({
  id: row.accountId,
  label: row.name ?? row.label,
  ...(row.email ? { email: row.email } : {}),
  ...(row.plan ? { plan: row.plan } : {}),
  active: row.active,
  ...(row.limitedUntil ? { limitedUntil: row.limitedUntil } : {}),
  ...(row.status ? { status: row.status } : {}),
  ...(row.planUsage !== undefined ? { planUsage: row.planUsage } : {}),
  ...(row.provider === "chatgpt" ? { limitText: "Usage limit reached" } : {}),
});

function useAccountActions(provider: EngineProvider) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) showToast({ title: done });
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, []);
  return {
    busy,
    run,
    onUse: (accountId: string) =>
      void run(() => cloudEnginesApi.setActiveAccount(provider, accountId)),
    onToggleAutoSwitch: (enabled: boolean) =>
      void run(() => cloudEnginesApi.setAutoSwitch(provider, enabled)),
  };
}

function ClaudeAccounts({
  settings,
  refreshing,
}: {
  settings: EngineSettings | undefined;
  refreshing: boolean;
}) {
  const connect = useEngineConnect();
  const actions = useAccountActions("anthropic");
  const accounts = (settings?.connections ?? [])
    .filter((row) => row.provider === "anthropic")
    .map(rowOf);
  const { start } = connect;
  const handleStart = useCallback(async () => {
    try {
      if (await start("anthropic")) {
        showToast({ title: "Claude (Pro/Max) account connected." });
      }
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    }
  }, [start]);

  return (
    <EngineAccountList
      title="Claude (Pro/Max)"
      description={
        accounts.length > 0
          ? "The checked account runs Claude Code on all your computers and in the cloud. Your own devices sign in and refresh it; Stella's server only stores the encrypted token."
          : "Use your Claude subscription on all your computers and in the cloud. You sign in on your own device, which also keeps it refreshed; Stella's server only stores the encrypted token."
      }
      accounts={accounts}
      autoSwitch={settings?.autoSwitch?.anthropic ?? false}
      autoSwitchDescription="When the checked account reaches its 5-hour or weekly limit, move to the next account until it resets."
      busy={actions.busy || refreshing}
      adding={connect.flow !== null}
      addLabel="Add account"
      onAdd={() => void handleStart()}
      onUse={actions.onUse}
      onSignOut={(accountId) =>
        void actions.run(() => cloudEnginesApi.disconnect("anthropic", accountId), "Signed out.")
      }
      onToggleAutoSwitch={actions.onToggleAutoSwitch}
      addFlow={connect.flow ? <EngineConnectPrompt connect={connect} /> : null}
    />
  );
}

function CloudChatGptAccounts({
  settings,
  refreshing,
}: {
  settings: EngineSettings | undefined;
  refreshing: boolean;
}) {
  const connect = useEngineConnect();
  const actions = useAccountActions("chatgpt");
  const accounts = (settings?.connections ?? [])
    .filter((row) => row.provider === "chatgpt")
    .map(rowOf);
  const { start } = connect;
  const signIn = useCallback(
    async (options: EngineConnectOptions = {}) => {
      try {
        if (!(await start("chatgpt", options))) return;
        showToast({ title: "Stella's cloud is signed in to ChatGPT." });
        announceChatGptPlanUse();
      } catch (error) {
        showToast({ title: friendlyError(error), variant: "error" });
      }
    },
    [start],
  );
  const website = isWebsiteHost();

  return (
    <EngineAccountList
      title="ChatGPT for your cloud"
      description={
        <>
          Cloud chat and cloud agents use your ChatGPT plan, and that usage
          counts against it. Stella's cloud keeps its own sign-in, separate
          from your computers
          {website
            ? "; each computer signs in to ChatGPT in the Stella desktop app."
            : "; this computer's ChatGPT sign-in is below."}
        </>
      }
      accounts={accounts}
      autoSwitch={settings?.autoSwitch?.chatgpt ?? false}
      autoSwitchDescription="When the checked account reaches a ChatGPT usage limit, move to the next signed-in account."
      busy={actions.busy || refreshing}
      adding={connect.flow !== null}
      addLabel="Add account"
      onAdd={() => void signIn()}
      addButton={
        <ContinueWithChatGptButton
          onClick={() => void signIn()}
          disabled={actions.busy || refreshing || connect.flow !== null}
          loading={connect.busy}
        />
      }
      onUse={actions.onUse}
      onSignOut={(accountId) =>
        void actions.run(async () => {
          const result = await cloudEnginesApi.disconnect("chatgpt", accountId);
          if (result && !result.revoked) {
            showToast({
              title: "Signed out of ChatGPT here",
              description:
                "ChatGPT didn't confirm the sign-out. You can disconnect Stella in ChatGPT Settings.",
            });
          }
        }, "Signed out.")
      }
      onSignInAgain={(accountId) => void signIn({ accountId })}
      onEnablePlanUsage={(accountId) => void signIn({ accountId, enablePlanUsage: true })}
      onRemove={(accountId) =>
        void actions.run(
          () => cloudEnginesApi.disconnect("chatgpt", accountId, { forget: true }),
          "Removed.",
        )
      }
      onToggleAutoSwitch={actions.onToggleAutoSwitch}
      addFlow={connect.flow ? <EngineConnectPrompt connect={connect} /> : null}
      footer={
        accounts.length > 0 ? (
          <div className="settings-row">
            <div className="settings-row-sublabel">
              Review your ChatGPT usage, or set how much of your plan Stella may
              use, in ChatGPT Settings.
            </div>
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
              model: "stella/anthropic/claude-sonnet-4.6",
              reasoningEffort,
            }
          : engine === "anthropic"
            ? { engine, provider: engine, model: "claude-sonnet-4-6", reasoningEffort }
            : { engine, provider: engine, model: "gpt-6.1-sol", reasoningEffort };
      await cloudEnginesApi.setExecution(execution);
      publishCloudExecutionSelection(execution);
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Claude &amp; ChatGPT accounts</h3>
      <div className="settings-row">
        <div className="settings-row-sublabel">
          Use the Claude or ChatGPT plan you already pay for. Claude accounts
          are shared by all your computers and the cloud. ChatGPT is signed in
          per place: each computer has its own sign-in, and Stella's cloud has
          its own.
        </div>
      </div>
      <ClaudeAccounts settings={connections} refreshing={refreshing} />
      <CloudChatGptAccounts settings={connections} refreshing={refreshing} />
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Cloud chat runs on</div>
          <div className="settings-row-sublabel">
            Stella's built-in engine is metered by your Stella plan; Claude or
            ChatGPT bills that subscription instead.
          </div>
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
            title={usableProviders.has("anthropic") ? undefined : "Connect Claude first"}
          >
            Claude
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`pill-btn${chatEngine === "chatgpt" ? " pill-btn--active" : ""}`}
            onClick={() => void chooseEngine("chatgpt")}
            disabled={switching || !usableProviders.has("chatgpt")}
            title={
              usableProviders.has("chatgpt")
                ? undefined
                : "Continue with ChatGPT for your cloud first"
            }
          >
            ChatGPT
          </Button>
        </div>
      </div>
    </div>
  );
}

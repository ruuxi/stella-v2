import { useCallback, useState } from "react";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import type {
  EngineProvider,
  EngineSettings,
} from "@stella/contracts/backend/engines";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { EngineAccountList, type EngineAccountRow } from "./EngineAccountList";
import { EngineConnectPrompt } from "./EngineConnectPrompt";
import { useEngineConnect } from "./use-engine-connect";
import { publishCloudExecutionSelection } from "./cloud-execution-store";

/**
 * "Claude & ChatGPT accounts": the owner's one list of subscriptions, kept in
 * the Stella account. They power Claude Code and Codex on every one of the
 * owner's computers (even one where the account was never added) and cloud
 * turns, whose engine is chosen here too.
 *
 * The server keeps an encrypted token and is the only party that refreshes
 * it; a computer only ever receives the active account's short-lived access
 * token.
 */

const friendlyError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "That didn't work. Try again.";

type ProviderMeta = {
  provider: EngineProvider;
  name: string;
  autoSwitchDescription: string;
};

const PROVIDERS: ProviderMeta[] = [
  {
    provider: "anthropic",
    name: "Claude (Pro/Max)",
    autoSwitchDescription:
      "When the checked account reaches its 5-hour or weekly limit, move to the next account until it resets.",
  },
  {
    provider: "openai-codex",
    name: "ChatGPT",
    autoSwitchDescription:
      "When the checked account reaches its Codex usage limit, move to the next account until it resets.",
  },
];

function EngineProviderAccounts({
  meta,
  settings,
  refreshing,
}: {
  meta: ProviderMeta;
  settings: EngineSettings | undefined;
  refreshing: boolean;
}) {
  const connect = useEngineConnect();
  const [busy, setBusy] = useState(false);
  const accounts: EngineAccountRow[] = (settings?.connections ?? [])
    .filter((row) => row.provider === meta.provider)
    .map((row) => ({
      id: row.accountId,
      label: row.label,
      ...(row.email ? { email: row.email } : {}),
      ...(row.plan ? { plan: row.plan } : {}),
      active: row.active,
      ...(row.limitedUntil ? { limitedUntil: row.limitedUntil } : {}),
    }));

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

  const { start } = connect;
  const handleStart = useCallback(async () => {
    try {
      if (await start(meta.provider)) {
        showToast({ title: `${meta.name} account connected.` });
      }
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    }
  }, [meta.name, meta.provider, start]);

  return (
    <EngineAccountList
      title={meta.name}
      description={
        accounts.length > 0
          ? "The checked account is used on your computers and in the cloud."
          : "Use your subscription on all your computers and in the cloud. Sign-in stays with the provider; Stella keeps an encrypted token."
      }
      accounts={accounts}
      autoSwitch={settings?.autoSwitch?.[meta.provider] ?? false}
      autoSwitchDescription={meta.autoSwitchDescription}
      busy={busy || refreshing}
      adding={connect.flow !== null}
      addLabel="Add account"
      onAdd={() => void handleStart()}
      onUse={(accountId) =>
        void run(() => cloudEnginesApi.setActiveAccount(meta.provider, accountId))
      }
      onSignOut={(accountId) =>
        void run(
          () => cloudEnginesApi.disconnect(meta.provider, accountId),
          "Signed out.",
        )
      }
      onToggleAutoSwitch={(enabled) =>
        void run(() => cloudEnginesApi.setAutoSwitch(meta.provider, enabled))
      }
      addFlow={connect.flow ? <EngineConnectPrompt connect={connect} /> : null}
    />
  );
}

export function CloudEnginesCard() {
  const { isAuthenticated } = useAuthState();
  const connections = useCloudEngines(isAuthenticated);
  const [switching, setSwitching] = useState(false);

  if (!isAuthenticated) return null;

  const connectedProviders = new Set<string>(
    (connections?.connections ?? []).map((row) => row.provider),
  );
  const chatEngine = connections?.execution.engine ?? "stella";

  const chooseEngine = async (engine: CloudExecutionSelection["engine"]) => {
    if (engine === chatEngine) return;
    setSwitching(true);
    try {
      const reasoningEffort: AgentModelReasoningEffort =
        connections?.execution.reasoningEffort ?? "default";
      const model =
        engine === "stella"
          ? "stella/anthropic/claude-sonnet-4.6"
          : engine === "anthropic"
            ? "claude-sonnet-4-6"
            : "gpt-6.1-sol";
      const execution =
        engine === "stella"
          ? ({
              engine,
              provider: engine,
              model,
              reasoningEffort,
            } satisfies CloudExecutionSelection)
          : engine === "anthropic"
            ? ({
                engine,
                provider: engine,
                model,
                reasoningEffort,
              } satisfies CloudExecutionSelection)
            : ({
                engine,
                provider: engine,
                model,
                reasoningEffort,
              } satisfies CloudExecutionSelection);
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
          These accounts power Claude Code and Codex on all your computers and
          cloud chat. Stella keeps an encrypted token and refreshes it on its
          server; your computers only receive short-lived access.
        </div>
      </div>
      {PROVIDERS.map((meta) => (
        <EngineProviderAccounts
          key={meta.provider}
          meta={meta}
          settings={connections}
          refreshing={connections === undefined}
        />
      ))}
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Cloud chat runs on</div>
          <div className="settings-row-sublabel">
            Stella's built-in engine is metered by your plan; a connected
            subscription bills the provider directly.
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
            disabled={switching || !connectedProviders.has("anthropic")}
            title={
              connectedProviders.has("anthropic")
                ? undefined
                : "Connect Claude first"
            }
          >
            Claude
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={`pill-btn${chatEngine === "openai-codex" ? " pill-btn--active" : ""}`}
            onClick={() => void chooseEngine("openai-codex")}
            disabled={switching || !connectedProviders.has("openai-codex")}
            title={
              connectedProviders.has("openai-codex")
                ? undefined
                : "Connect ChatGPT first"
            }
          >
            ChatGPT
          </Button>
        </div>
      </div>
    </div>
  );
}

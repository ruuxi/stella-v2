import { useCallback, useEffect, useState } from "react";
import type { LocalLlmOAuthProviderAccounts } from "@/shared/types/electron";
import { showToast } from "@/ui/toast";
import {
  EngineAccountList,
  type EngineAccountRow,
} from "@/features/cloud/EngineAccountList";
import { useLlmCredentials } from "./hooks/use-llm-credentials";

/**
 * "Subscriptions on this computer": the Claude and ChatGPT logins local
 * agents run on. Several accounts per provider, one in use, and an option to
 * move on when the one in use hits its limit. A Claude account added here
 * also becomes the login Claude Code runs on; with none, Claude Code keeps
 * its own login.
 */

type LocalProvider = {
  provider: "anthropic" | "openai-codex";
  name: string;
  description: string;
  emptyDescription: string;
  autoSwitchDescription: string;
};

const PROVIDERS: LocalProvider[] = [
  {
    provider: "anthropic",
    name: "Claude (Pro/Max)",
    description:
      "Powers Claude Code on this computer. The checked account is used.",
    emptyDescription:
      "Sign in to switch Claude Code between several Claude accounts. Without one, Claude Code uses its own login.",
    autoSwitchDescription:
      "When the checked account reaches its 5-hour or weekly limit, move to the next account until it resets.",
  },
  {
    provider: "openai-codex",
    name: "ChatGPT",
    description:
      "Powers Codex on this computer. The checked account is used.",
    emptyDescription: "Sign in with your ChatGPT subscription to run Codex here.",
    autoSwitchDescription:
      "When the checked account reaches its Codex usage limit, move to the next account until it resets.",
  },
];

const friendlyError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "That didn't work. Try again.";

export function LocalEngineAccountsCard() {
  const system = window.electronAPI?.system;
  const credentials = useLlmCredentials();
  const [accounts, setAccounts] = useState<LocalLlmOAuthProviderAccounts[] | null>(
    null,
  );
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!system?.listLlmOAuthAccounts) return;
    try {
      setAccounts(await system.listLlmOAuthAccounts());
    } catch {
      setAccounts([]);
    }
  }, [system]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!system?.listLlmOAuthAccounts) return null;

  const run = async (
    provider: string,
    action: () => Promise<unknown>,
    done?: string,
  ) => {
    setBusyProvider(provider);
    try {
      await action();
      if (done) showToast({ title: done });
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusyProvider(null);
      await reload();
      await credentials.reload().catch(() => undefined);
    }
  };

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Subscriptions on this computer</h3>
      {PROVIDERS.map((meta) => {
        const state = accounts?.find((entry) => entry.provider === meta.provider);
        const rows: EngineAccountRow[] = (state?.accounts ?? []).map((row) => ({
          id: row.id,
          label: row.label,
          ...(row.email ? { email: row.email } : {}),
          ...(row.plan ? { plan: row.plan } : {}),
          active: row.active,
          ...(row.limitedUntil ? { limitedUntil: row.limitedUntil } : {}),
        }));
        const busy = accounts === null || busyProvider === meta.provider;
        return (
          <EngineAccountList
            key={meta.provider}
            title={meta.name}
            description={rows.length > 0 ? meta.description : meta.emptyDescription}
            accounts={rows}
            autoSwitch={state?.autoSwitch ?? false}
            autoSwitchDescription={meta.autoSwitchDescription}
            busy={busy}
            adding={busyProvider === meta.provider}
            addLabel="Add account"
            onAdd={() =>
              void run(
                meta.provider,
                () => credentials.loginOAuth(meta.provider),
                `${meta.name} account signed in.`,
              )
            }
            onUse={(accountId) =>
              void run(meta.provider, () =>
                system.setActiveLlmOAuthAccount(meta.provider, accountId),
              )
            }
            onSignOut={(accountId) =>
              void run(
                meta.provider,
                () => system.deleteLlmOAuthAccount(meta.provider, accountId),
                "Signed out.",
              )
            }
            onToggleAutoSwitch={(enabled) =>
              void run(meta.provider, () =>
                system.setLlmOAuthAutoSwitch(meta.provider, enabled),
              )
            }
          />
        );
      })}
    </div>
  );
}

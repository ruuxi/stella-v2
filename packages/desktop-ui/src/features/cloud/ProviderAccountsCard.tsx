import { useState } from "react";
import { useAuthState } from "@/global/auth/BackendAuthProvider";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import { isEngineConnectionUsable } from "@stella/contracts/backend/engines";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";
import { ChatGptAccountsSection } from "@/features/chatgpt/ChatGptAccountsSection";
import { ClaudeAccountsSection } from "@/features/claude/ClaudeAccountsSection";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { publishCloudExecutionSelection } from "./cloud-execution-store";

/**
 * The one place for the owner's Claude and ChatGPT accounts.
 *
 * Both providers sign in per host: a computer's sign-in stays on that
 * computer, and the owner's cloud keeps its own. So each account is one row
 * listing where it is signed in, rather than one card per host. The cloud's
 * engine for its own chat is chosen at the bottom.
 */

const K = "settings.engineAccounts";

export function ProviderAccountsCard() {
  const t = useT();
  const { isAuthenticated } = useAuthState();
  const connections = useCloudEngines(isAuthenticated);
  const [switching, setSwitching] = useState(false);

  const usableProviders = new Set<string>(
    (connections?.connections ?? [])
      .filter(isEngineConnectionUsable)
      .map((row) => row.provider),
  );
  const chatEngine = connections?.execution.engine ?? "stella";
  const refreshing = isAuthenticated && connections === undefined;

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
      <ChatGptAccountsSection
        settings={connections}
        refreshing={refreshing}
        cloudAvailable={isAuthenticated}
      />
      <ClaudeAccountsSection
        settings={connections}
        refreshing={refreshing}
        cloudAvailable={isAuthenticated}
      />
      {isAuthenticated ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">{t(`${K}.runsOnLabel`)}</div>
          </div>
          <div className="settings-row-control engine-account-controls">
            <Button
              type="button"
              variant="ghost"
              className={`pill-btn${chatEngine === "stella" ? " pill-btn--active" : ""}`}
              aria-pressed={chatEngine === "stella"}
              onClick={() => void chooseEngine("stella")}
              disabled={switching}
            >
              Stella
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={`pill-btn${chatEngine === "anthropic" ? " pill-btn--active" : ""}`}
              aria-pressed={chatEngine === "anthropic"}
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
              aria-pressed={chatEngine === "chatgpt"}
              onClick={() => void chooseEngine("chatgpt")}
              disabled={switching || !usableProviders.has("chatgpt")}
              title={usableProviders.has("chatgpt") ? undefined : t(`${K}.needsChatgptCloud`)}
            >
              ChatGPT
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

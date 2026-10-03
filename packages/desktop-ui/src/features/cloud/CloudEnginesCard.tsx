import { useCallback, useState } from "react";
import { useConvexAuth } from "convex/react";
import type {
  AgentModelReasoningEffort,
  CloudExecutionSelection,
} from "@stella/contracts/agent-engine";
import type { EngineProvider } from "@stella/contracts/backend/engines";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import { cloudEnginesApi, useCloudEngines } from "./cloud-engines-api";
import { publishCloudExecutionSelection } from "./cloud-execution-store";

/**
 * "Cloud engines" settings card: connect a Claude (Pro/Max) or ChatGPT
 * subscription for cloud turns, and choose which engine powers them.
 *
 * The OAuth dance is paste-based so it works from any browser (web/mobile
 * interior included): we open the provider's authorize URL, the user pastes
 * back the code (Claude) or the full localhost redirect URL (ChatGPT — the
 * page won't load, but the address bar still carries the code). Tokens are
 * exchanged and stored server-side; the browser never sees them.
 */

const friendlyError = (error: unknown): string =>
  error instanceof Error && error.message
    ? error.message
    : "That didn't work. Try again.";

type ProviderMeta = {
  provider: EngineProvider;
  name: string;
  pasteHint: string;
};

const PROVIDERS: ProviderMeta[] = [
  {
    provider: "anthropic",
    name: "Claude (Pro/Max)",
    pasteHint: "Paste the code shown after you approve access",
  },
  {
    provider: "openai-codex",
    name: "ChatGPT",
    pasteHint:
      "After approving, the browser opens a localhost page that won't load — paste that page's full URL here",
  },
];

function EngineConnectRow({
  meta,
  connected,
  refreshing,
}: {
  meta: ProviderMeta;
  connected: boolean;
  refreshing: boolean;
}) {
  const [connectId, setConnectId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      const result = await cloudEnginesApi.startConnect(meta.provider);
      setConnectId(result.connectId);
      window.open(result.authorizeUrl, "_blank", "noopener");
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [meta.provider]);

  const handleFinish = useCallback(async () => {
    if (!connectId || !pasted.trim()) return;
    setBusy(true);
    try {
      await cloudEnginesApi.finishConnect(connectId, pasted.trim());
      setConnectId(null);
      setPasted("");
      showToast({ title: `${meta.name} connected.` });
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [connectId, meta.name, pasted]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    try {
      await cloudEnginesApi.disconnect(meta.provider);
      showToast({ title: `${meta.name} disconnected.` });
    } catch (error) {
      showToast({ title: friendlyError(error), variant: "error" });
    } finally {
      setBusy(false);
    }
  }, [meta.name, meta.provider]);

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">{meta.name}</div>
          <div className="settings-row-sublabel">
            {connected
              ? "Connected — can power cloud chat and agents."
              : "Use your subscription for cloud turns. Sign-in stays with the provider; Stella stores only an encrypted token."}
          </div>
        </div>
        <div className="settings-row-control">
          {connected ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void handleDisconnect()}
              disabled={busy || refreshing}
            >
              Disconnect
            </Button>
          ) : connectId ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => setConnectId(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void handleStart()}
              disabled={busy || refreshing}
            >
              Connect
            </Button>
          )}
        </div>
      </div>
      {connectId && !connected ? (
        <div className="settings-row">
          <div className="settings-row-info" style={{ flex: 1 }}>
            <div className="settings-row-sublabel">{meta.pasteHint}</div>
            <input
              type="text"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="Paste the authorization code or URL"
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => void handleFinish()}
              disabled={busy || !pasted.trim()}
            >
              {busy ? "Connecting…" : "Finish"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function CloudEnginesCard() {
  const { isAuthenticated } = useConvexAuth();
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
            : "gpt-6-sol";
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
      <h3 className="settings-card-title">Cloud engines</h3>
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
      {PROVIDERS.map((meta) => (
        <EngineConnectRow
          key={meta.provider}
          meta={meta}
          connected={connectedProviders.has(meta.provider)}
          refreshing={connections === undefined}
        />
      ))}
    </div>
  );
}

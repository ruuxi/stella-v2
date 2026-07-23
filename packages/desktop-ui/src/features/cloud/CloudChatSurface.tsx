import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { AppWindowMac, Send } from "@/ui/icons";
import { useAuthBootstrapState } from "@/global/auth/DesktopConvexAuthProvider";
import { cloudAppUrl } from "./cloud-config";
import {
  isMobileShell,
  speakCarPlayReply,
} from "@/platform/mobile/mobile-shell";
import { cloudApi, type CloudTurn } from "./cloud-api";
import "./cloud-chat.css";

const eventLabel = (kind: string): string => {
  switch (kind) {
    case "running":
      return "Choosing the fastest path";
    case "op_selected":
      return "Operating the app";
    case "started":
      return "Starting your cloud turn";
    case "sandbox_ready":
      return "Workspace ready";
    case "model_completed":
      return "Design direction ready";
    case "app_built":
      return "App built";
    case "live_preview":
      return "Live preview ready";
    case "checkpointed":
      return "Saving workspace";
    case "workspace_restored":
      return "Verifying the build";
    case "completed":
      return "Build ready";
    case "failed":
      return "Build failed";
    case "canceled":
      return "Build canceled";
    case "timeout":
      return "Build timed out";
    default:
      return kind.replaceAll("_", " ");
  }
};

const errorText = (value?: string): string => {
  if (!value) return "The build did not finish. Retry with the same request.";
  try {
    const parsed = JSON.parse(value) as { message?: string };
    return parsed.message ?? value;
  } catch {
    return value;
  }
};

export function CloudChatSurface() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const authBootstrap = useAuthBootstrapState();
  const conversations = useQuery(
    cloudApi.listMyConversations,
    isAuthenticated ? {} : "skip",
  );
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const spokenTerminalTurns = useRef(new Set<string>());
  const startTurn = useMutation(cloudApi.startCloudChat);
  const applyBuild = useAction(cloudApi.applyMyBuild);
  const turns = useQuery(
    cloudApi.listMyCloudTurns,
    conversationId ? { conversationId } : "skip",
  ) as CloudTurn[] | undefined;

  useEffect(() => {
    if (!conversationId && conversations?.[0]?.conversationId) {
      setConversationId(conversations[0].conversationId);
    }
  }, [conversationId, conversations]);

  useEffect(() => {
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  const appById = useMemo(
    () => new Map((apps ?? []).map((app) => [app.appId, app])),
    [apps],
  );

  const startMessage = async (message: string) => {
    if (!message || isSending) return;
    setSendError(null);
    setIsSending(true);
    try {
      const result = await startTurn({
        prompt: message,
        ...(conversationId ? { conversationId } : {}),
        ...(selectedAppId ? { appId: selectedAppId } : {}),
      });
      setConversationId(result.conversationId);
      if (!selectedAppId) setSelectedAppId(result.appId);
    } catch (error) {
      setPrompt(message);
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || isSending) return;
    setPrompt("");
    void startMessage(message);
  };

  useEffect(() => {
    const onCarPlayPrompt = (event: Event) => {
      const message = (
        event as CustomEvent<{ prompt?: string }>
      ).detail?.prompt?.trim();
      if (message) void startMessage(message);
    };
    window.addEventListener("stella:carplay-prompt", onCarPlayPrompt);
    return () =>
      window.removeEventListener("stella:carplay-prompt", onCarPlayPrompt);
  });

  useEffect(() => {
    if (!isMobileShell() || !turns) return;
    const terminal = turns.findLast(
      (turn) =>
        turn.status === "completed" &&
        !spokenTerminalTurns.current.has(turn.turnId),
    );
    if (!terminal) return;
    spokenTerminalTurns.current.add(terminal.turnId);
    speakCarPlayReply("Your Stella cloud turn is complete. The app is ready.");
  }, [turns]);

  if (isLoading || !isAuthenticated) {
    return (
      <main className="cloud-chat cloud-chat--centered">
        <p>
          {authBootstrap.status === "failed"
            ? (authBootstrap.error ??
              "Stella could not start a secure session.")
            : "Preparing your secure Stella session…"}
        </p>
      </main>
    );
  }

  return (
    <main className="cloud-chat" aria-label="Stella cloud chat">
      <header className="cloud-chat__header">
        <div>
          <span className="cloud-chat__eyebrow">Cloud workspace</span>
          <h1>Build with Stella</h1>
        </div>
        <select
          aria-label="App to iterate"
          value={selectedAppId}
          onChange={(event) => setSelectedAppId(event.target.value)}
        >
          <option value="">Create a new app</option>
          {(apps ?? [])
            .filter((app) => app.status !== "suspended")
            .map((app) => (
              <option key={app.appId} value={app.appId}>
                {app.title}
              </option>
            ))}
        </select>
      </header>

      <div className="cloud-chat__timeline" ref={timelineRef}>
        {!turns?.length ? (
          <section className="cloud-chat__empty">
            <AppWindowMac size={28} strokeWidth={1.5} aria-hidden="true" />
            <h2>Describe the app you want</h2>
            <p>Stella will build it in the cloud and keep the live app here.</p>
          </section>
        ) : (
          turns.map((turn) => {
            const latest = turn.events.at(-1);
            const completed = turn.events.find(
              (event) => event.kind === "completed",
            );
            const buildId =
              typeof completed?.payload.buildId === "string"
                ? completed.payload.buildId
                : null;
            const previewUrl =
              typeof completed?.payload.previewUrl === "string"
                ? completed.payload.previewUrl
                : null;
            const app = appById.get(turn.appId);
            const needsApply =
              Boolean(buildId) && app?.activeBuildId !== buildId;
            const operation =
              typeof completed?.payload.operation === "string"
                ? completed.payload.operation
                : null;
            return (
              <article className="cloud-turn" key={turn.turnId}>
                <p className="cloud-turn__prompt">{turn.prompt}</p>
                <div className="cloud-turn__result" data-status={turn.status}>
                  <span className="cloud-turn__status">
                    {operation && turn.status === "completed"
                      ? "Done"
                      : eventLabel(latest?.kind ?? turn.status)}
                  </span>
                  {turn.status === "running" ? (
                    <div
                      className="cloud-turn__progress"
                      aria-label="Build in progress"
                    >
                      <i />
                    </div>
                  ) : null}
                  {turn.status === "failed" ||
                  turn.status === "timeout" ||
                  turn.status === "canceled" ? (
                    <p className="cloud-turn__error">
                      {errorText(turn.errorMessage)}
                    </p>
                  ) : null}
                  {turn.status === "completed" && operation ? (
                    <p className="cloud-turn__operation">
                      Ran <code>{operation}</code> on {app?.title ?? "the app"}{" "}
                      — applied instantly, no rebuild.
                    </p>
                  ) : null}
                  {turn.status === "completed" && previewUrl ? (
                    <div className="cloud-turn__actions">
                      <a href={previewUrl} target="_blank" rel="noreferrer">
                        Open preview
                      </a>
                      {needsApply && buildId ? (
                        <button
                          type="button"
                          onClick={() => void applyBuild({ buildId })}
                        >
                          Apply build
                        </button>
                      ) : (
                        <span>Live</span>
                      )}
                      {app ? (
                        <a
                          href={cloudAppUrl(app.slug)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open app
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>

      <form className="cloud-chat__composer" onSubmit={submit}>
        {sendError ? (
          <p className="cloud-chat__error" role="alert">
            {sendError}
          </p>
        ) : null}
        <div className="cloud-chat__composer-row">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              selectedAppId
                ? "What should Stella change?"
                : "Build a calm meal planner for busy weeknights…"
            }
            aria-label="Message Stella"
            rows={2}
            maxLength={4_000}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            type="submit"
            disabled={!prompt.trim() || isSending}
            aria-label={isSending ? "Sending" : "Send message"}
          >
            <Send size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  );
}

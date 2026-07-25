import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { showToast } from "@/ui/toast";
import type { ChatColumnComposer } from "@/features/chat/chat-column-types";
import {
  isMobileShell,
  speakCarPlayReply,
} from "@/platform/mobile/mobile-shell";
import { cloudApi, type CloudApp, type CloudTurn } from "./cloud-api";
import { openCloudAppPanel } from "./open-cloud-app-panel";
import "./cloud-inline.css";

/**
 * Cloud app turns rendered INSIDE the normal chat surface. This file adds
 * exactly one visual element to the product: the inline app card (v1's
 * apply-card pattern — one row, one action per state). Everything else uses
 * the chat's own bubble classes; there is no separate cloud surface.
 */

const RECENT_WINDOW_MS = 15 * 60_000;

const isWebShell = () =>
  typeof window !== "undefined" &&
  !(window as { electronAPI?: unknown }).electronAPI;

// Users see the message we wrote, never Convex's server-error wrapper.
const friendlyError = (error: unknown): string => {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  if (
    error instanceof Error &&
    !/Server Error|ConvexError/.test(error.message)
  ) {
    return error.message;
  }
  return "That didn't work. Try again.";
};

const errorText = (value?: string): string => {
  if (!value) return "That didn't finish. Try again.";
  try {
    const parsed = JSON.parse(value) as { message?: string };
    return parsed.message ?? value;
  } catch {
    return value;
  }
};

// While Stella works, describe progress like a person would.
const workingLabel = (kind?: string): string => {
  switch (kind) {
    case "sandbox_ready":
      return "Getting set up…";
    case "model_completed":
      return "Designing…";
    case "app_built":
      return "Putting it together…";
    case "live_preview":
      return "Almost there…";
    case "checkpointed":
    case "workspace_restored":
      return "Finishing up…";
    case "op_selected":
      return "Making the change…";
    case "tool_call":
      return "Working on it…";
    default:
      return "Thinking…";
  }
};

type OperationPayload = {
  operation: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
};

const operationOutcome = (payload: OperationPayload): string => {
  const args = payload.args ?? {};
  const result = (payload.result ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (payload.operation) {
    case "complete-habit":
      return `Done — marked ${text(args.habit)} complete.`;
    case "set-habit-progress":
      return `Done — set ${text(args.habit)} to ${text(
        result.progress ?? args.progress,
      )}%.`;
    case "set-focus":
      return `Done — the focus is now “${text(result.focus ?? args.focus)}”.`;
    case "reset-day":
      return "Done — reset today's habits.";
    default: {
      const detail = Object.values(args)
        .filter(
          (value) => typeof value === "string" || typeof value === "number",
        )
        .join(", ");
      return `Done — ${payload.operation.replaceAll("-", " ")}${
        detail ? `: ${detail}` : ""
      }.`;
    }
  }
};

// How long the applied card's "Rollback" stays armed before disarming.
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * The inline card for a finished app build. Mirrors v1's apply card exactly:
 * one row, one primary action per state — Apply, then a quiet Rollback on
 * the same card once applied; a brand-new app gets a single Open.
 */
function CloudBuildCard({
  app,
  buildId,
}: {
  app: CloudApp | undefined;
  buildId: string;
}) {
  const applyBuild = useAction(cloudApi.applyMyBuild);
  const builds = useQuery(
    cloudApi.listMyAppBuilds,
    app ? { appId: app.appId } : "skip",
  );
  const [state, setState] = useState<
    "idle" | "applying" | "confirming" | "reverting" | "reverted"
  >("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

  if (!app) return null;
  const thisBuild = builds?.find((build) => build.buildId === buildId);
  const isActive = app.activeBuildId === buildId;
  const previousBuild = builds?.find(
    (build) =>
      build.buildId !== buildId &&
      build.artifactPrefix &&
      build.createdAt < (thisBuild?.createdAt ?? Number.POSITIVE_INFINITY),
  );
  const isFirstVersion = !previousBuild;

  const run = async (
    nextState: "applying" | "reverting",
    targetBuildId: string,
    doneState: "idle" | "reverted",
  ) => {
    setActionError(null);
    setState(nextState);
    try {
      await applyBuild({ buildId: targetBuildId });
      setState(doneState);
    } catch (error) {
      setActionError(friendlyError(error));
      setState("idle");
    }
  };

  const label =
    state === "reverted"
      ? "Change rolled back"
      : state === "applying"
        ? `Updating ${app.title}…`
        : state === "reverting"
          ? "Rolling back…"
          : state === "confirming"
            ? "Roll this back?"
            : isActive && isFirstVersion
              ? `${app.title} is ready`
              : isActive
                ? `${app.title} was updated`
                : `${app.title} has an update ready`;

  return (
    <div className="cloud-build-card" data-state={state}>
      <span className="cloud-build-card__icon">
        <StellaLogoIcon size={20} />
      </span>
      <span className="cloud-build-card__label">{label}</span>
      {actionError ? (
        <span className="cloud-build-card__error">{actionError}</span>
      ) : null}
      {state === "applying" || state === "reverting" ? (
        <button type="button" className="cloud-build-card__action" disabled>
          <span className="cloud-build-card__spinner" />
        </button>
      ) : state === "reverted" ? null : isActive && isFirstVersion ? (
        <button
          type="button"
          className="cloud-build-card__action"
          onClick={() => openCloudAppPanel(app)}
        >
          Open
        </button>
      ) : isActive ? (
        <button
          type="button"
          className={`cloud-build-card__action${
            state === "confirming" ? " cloud-build-card__action--confirm" : ""
          }`}
          onClick={() => {
            if (state === "idle") {
              setState("confirming");
              clearConfirmTimer();
              confirmTimerRef.current = setTimeout(() => {
                confirmTimerRef.current = null;
                setState((current) =>
                  current === "confirming" ? "idle" : current,
                );
              }, CONFIRM_TIMEOUT_MS);
              return;
            }
            if (state !== "confirming" || !previousBuild) return;
            clearConfirmTimer();
            void run("reverting", previousBuild.buildId, "reverted");
          }}
        >
          {state === "confirming" ? "Confirm" : "Rollback"}
        </button>
      ) : (
        <button
          type="button"
          className="cloud-build-card__action"
          onClick={() => void run("applying", buildId, "idle")}
        >
          Apply
        </button>
      )}
    </div>
  );
}

function CloudTurnRows({ turns, apps }: { turns: CloudTurn[]; apps: CloudApp[] }) {
  const appById = useMemo(
    () => new Map(apps.map((app) => [app.appId, app])),
    [apps],
  );
  if (!turns.length) return null;
  return (
    <div className="cloud-tail">
      {turns.map((turn) => {
        const latest = turn.events.at(-1);
        const completed = turn.events.find(
          (event) => event.kind === "completed",
        );
        const operation =
          typeof completed?.payload.operation === "string"
            ? (completed.payload as OperationPayload)
            : null;
        const buildId =
          typeof completed?.payload.buildId === "string"
            ? completed.payload.buildId
            : null;
        const app = turn.appId ? appById.get(turn.appId) : undefined;
        // Chat-lane turns stream assistant text as events and finish with the
        // final reply in the completed payload.
        const latestAssistantText = [...turn.events]
          .reverse()
          .find(
            (event) =>
              event.kind === "assistant_message" &&
              typeof event.payload.text === "string",
          )?.payload.text as string | undefined;
        const chatReply =
          typeof completed?.payload.text === "string"
            ? (completed.payload.text as string)
            : latestAssistantText;
        // Wake turns carry the orchestrator's relay of a finished agent's
        // report; their prompt is the lifecycle message, not something the
        // user typed — render the assistant side only.
        const isWake = turn.lane === "wake";
        return (
          <div className="cloud-tail__turn" key={turn.turnId}>
            {isWake ? null : (
              <div className="event-row">
                <div className="event-item user">
                  <span className="cloud-tail__text">{turn.prompt}</span>
                </div>
              </div>
            )}
            <div className="event-row">
              <div className="event-item assistant">
                {turn.status === "running" ? (
                  latestAssistantText ? (
                    <span className="cloud-tail__text">
                      {latestAssistantText}
                    </span>
                  ) : (
                    <span className="cloud-tail__working">
                      {workingLabel(latest?.kind)}
                    </span>
                  )
                ) : turn.status === "completed" && chatReply ? (
                  <span className="cloud-tail__text">{chatReply}</span>
                ) : operation ? (
                  <div className="cloud-tail__outcome">
                    <span>{operationOutcome(operation)}</span>
                    <details className="cloud-tail__details">
                      <summary>Details</summary>
                      <pre>{JSON.stringify(operation, null, 2)}</pre>
                    </details>
                  </div>
                ) : turn.status === "completed" && buildId ? (
                  <CloudBuildCard app={app} buildId={buildId} />
                ) : (
                  <span className="cloud-tail__problem">
                    {errorText(turn.errorMessage)}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Bridges cloud app turns into the normal chat surface without changing it:
 *  - renders recent cloud turns as ordinary chat rows via `extraTail`;
 *  - in the web/mobile interior (no local runtime), routes composer sends to
 *    the cloud chat mutation. On desktop the composer is untouched.
 */
export function useCloudChat(base: ChatColumnComposer): {
  composer: ChatColumnComposer;
  extraTail: ReactNode;
} {
  const { isAuthenticated } = useConvexAuth();
  const startTurn = useMutation(cloudApi.startCloudChat);
  const conversations = useQuery(
    cloudApi.listMyConversations,
    isAuthenticated ? {} : "skip",
  );
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const conversationId = conversations?.[0]?.conversationId ?? null;
  const turns = useQuery(
    cloudApi.listMyCloudTurns,
    conversationId ? { conversationId } : "skip",
  ) as CloudTurn[] | undefined;
  const [isSending, setIsSending] = useState(false);
  const spokenTerminalTurns = useRef(new Set<string>());
  const cloudComposer = isWebShell();

  const submitCloud = useCallback(
    async (message: string) => {
      setIsSending(true);
      try {
        await startTurn({
          prompt: message,
          ...(conversationId ? { conversationId } : {}),
        });
      } catch (error) {
        showToast({ title: friendlyError(error), variant: "error" });
        base.setMessage((current) => (current ? current : message));
      } finally {
        setIsSending(false);
      }
    },
    [startTurn, conversationId, base.setMessage],
  );

  // CarPlay dictation lands in the same cloud path.
  useEffect(() => {
    const onCarPlayPrompt = (event: Event) => {
      const message = (
        event as CustomEvent<{ prompt?: string }>
      ).detail?.prompt?.trim();
      if (message) void submitCloud(message);
    };
    window.addEventListener("stella:carplay-prompt", onCarPlayPrompt);
    return () =>
      window.removeEventListener("stella:carplay-prompt", onCarPlayPrompt);
  }, [submitCloud]);

  useEffect(() => {
    if (!isMobileShell() || !turns) return;
    const terminal = turns.findLast(
      (turn) =>
        turn.status === "completed" &&
        turn.hidden !== true &&
        !spokenTerminalTurns.current.has(turn.turnId),
    );
    if (!terminal) return;
    spokenTerminalTurns.current.add(terminal.turnId);
    const completedEvent = terminal.events.find(
      (event) => event.kind === "completed",
    );
    const reply =
      terminal.kind === "chat" &&
      typeof completedEvent?.payload.text === "string"
        ? (completedEvent.payload.text as string).slice(0, 400)
        : "All set. Your app is ready.";
    speakCarPlayReply(reply);
  }, [turns]);

  const composer = useMemo<ChatColumnComposer>(() => {
    if (!cloudComposer) return base;
    return {
      ...base,
      canSubmit: base.message.trim().length > 0 && !isSending,
      onSend: () => {
        const message = base.message.trim();
        if (!message || isSending) return;
        base.setMessage("");
        void submitCloud(message);
      },
    };
  }, [base, cloudComposer, isSending, submitCloud]);

  const visibleTurns = useMemo(() => {
    if (!turns?.length) return [] as CloudTurn[];
    // Spawned-agent turns are context, not chat; wake turns stay visible —
    // they are the only turns carrying a finished agent's report.
    const visible = turns.filter((turn) => turn.hidden !== true);
    if (cloudComposer) return visible.slice(-10);
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return visible
      .filter((turn) => turn.status === "running" || turn.updatedAt >= cutoff)
      .slice(-10);
  }, [turns, cloudComposer]);

  const extraTail = useMemo<ReactNode>(
    () =>
      visibleTurns.length ? (
        <CloudTurnRows turns={visibleTurns} apps={apps ?? []} />
      ) : null,
    [visibleTurns, apps],
  );

  return { composer, extraTail };
}

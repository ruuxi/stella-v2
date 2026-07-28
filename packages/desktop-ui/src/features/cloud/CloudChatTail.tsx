import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import { showToast } from "@/ui/toast";
import type { ChatColumnComposer } from "@/features/chat/chat-column-types";
import {
  isMobileShell,
  speakCarPlayReply,
} from "@/platform/mobile/mobile-shell";
import { cloudApi, type CloudApp } from "./cloud-api";
import { openCloudAppPanel } from "./open-cloud-app-panel";
import {
  cloudAttachmentsStore,
  isWebShell,
  useCloudAttachments,
  withAttachmentPreamble,
} from "./cloud-composer-store";
import {
  useActiveCloudConversationId,
  useCloudActivity,
} from "./use-cloud-activity";
import { useConversation } from "./use-conversation";
import type { LiveStream, PendingPrompt } from "./conversation-store";
import {
  messageText,
  type JournalCard,
  type JournalFile,
  type JournalRecord,
  type TurnPhase,
} from "./conversation-protocol";
import { DriveFileCard } from "@/features/drive/DriveFileCard";
import { useDriveFileActions } from "@/features/drive/drive-files";
import "./cloud-inline.css";

/**
 * Cloud turns rendered INSIDE the normal chat surface. This file adds exactly
 * one visual element to the product: the inline app card (v1's apply-card
 * pattern — one row, one action per state). Everything else uses the chat's
 * own bubble classes; there is no separate cloud surface.
 *
 * The rows come from the conversation's Durable Object over a WebSocket, not
 * from a Convex subscription: the DO owns the transcript. What arrives is a
 * gapless stream of journal records, which this file groups back into turns
 * for rendering. Nothing here is persisted — on desktop in particular, the
 * local SQLite store never sees a cloud conversation.
 */

const RECENT_WINDOW_MS = 15 * 60_000;

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

/** What the orchestrator is doing, described the way a person would say it. */
const TOOL_LABELS: Record<string, string> = {
  spawn_agent: "Getting an agent on it…",
  send_input: "Passing that along…",
  pause_agent: "Pausing that agent…",
  web: "Looking it up…",
  Recall: "Checking what I know…",
  Remember: "Making a note…",
  Schedule: "Setting that up…",
};

const workingLabel = (live: LiveStream | null): string => {
  if (!live?.toolName) return "Thinking…";
  return TOOL_LABELS[live.toolName] ?? live.toolLabel ?? "Working on it…";
};

type OperationCard = Extract<JournalCard, { type: "operation" }>;

const operationOutcome = (card: OperationCard): string => {
  const args = card.args ?? {};
  const result = card.result ?? {};
  const text = (value: unknown): string =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (card.operation) {
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
      return `Done — ${card.operation.replaceAll("-", " ")}${
        detail ? `: ${detail}` : ""
      }.`;
    }
  }
};

// How long the applied card's "Rollback" stays armed before disarming.
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * The inline card for a finished app build.
 *
 * An app is live the moment its build finishes, so this card never asks for
 * approval — the work is done and hosted, and the card's job is to take you
 * to it. (v1's Apply existed because a change could not take effect until
 * something was triggered; that was a mechanical necessity, not a review
 * step, and it does not apply to a hosted artifact.) Rollback stays as the
 * quiet second action, for the times a change was not what you wanted.
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
    "idle" | "confirming" | "reverting" | "reverted"
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
  const previousBuild = builds?.find(
    (build) =>
      build.buildId !== buildId &&
      build.artifactPrefix &&
      build.createdAt < (thisBuild?.createdAt ?? Number.POSITIVE_INFINITY),
  );
  const isFirstVersion = !previousBuild;

  const rollback = async (targetBuildId: string) => {
    setActionError(null);
    setState("reverting");
    try {
      await applyBuild({ buildId: targetBuildId });
      setState("reverted");
    } catch (error) {
      setActionError(friendlyError(error));
      setState("idle");
    }
  };

  const label =
    state === "reverted"
      ? "Change rolled back"
      : state === "reverting"
        ? "Rolling back…"
        : state === "confirming"
          ? "Roll this back?"
          : isFirstVersion
            ? `${app.title} is ready`
            : `${app.title} was updated`;

  return (
    <div className="cloud-build-card" data-state={state}>
      <span className="cloud-build-card__icon">
        <StellaLogoIcon size={20} />
      </span>
      <span className="cloud-build-card__label">{label}</span>
      {actionError ? (
        <span className="cloud-build-card__error">{actionError}</span>
      ) : null}
      {state === "reverting" ? (
        <button type="button" className="cloud-build-card__action" disabled>
          <span className="cloud-build-card__spinner" />
        </button>
      ) : state === "reverted" ? null : (
        <>
          {previousBuild ? (
            <button
              type="button"
              className={`cloud-build-card__action cloud-build-card__action--quiet${
                state === "confirming"
                  ? " cloud-build-card__action--confirm"
                  : ""
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
                if (state !== "confirming") return;
                clearConfirmTimer();
                void rollback(previousBuild.buildId);
              }}
            >
              {state === "confirming" ? "Confirm" : "Rollback"}
            </button>
          ) : null}
          <button
            type="button"
            className="cloud-build-card__action"
            onClick={() => openCloudAppPanel(app)}
          >
            Open app
          </button>
        </>
      )}
    </div>
  );
}

/** Files a cloud turn produced, as drive cards under the assistant's reply. */
function CloudOutputFiles({ files }: { files: JournalFile[] }) {
  const notify = useCallback((message: string) => {
    showToast({ title: message, variant: "error" });
  }, []);
  const actions = useDriveFileActions(notify);
  if (!files.length) return null;
  return (
    <div className="cloud-output-files">
      {files.map((file) => (
        <DriveFileCard
          key={file.path}
          path={file.path}
          name={file.name}
          sizeBytes={file.sizeBytes}
          actions={actions}
          stored={file.stored !== false}
        />
      ))}
    </div>
  );
}

/**
 * One turn, rebuilt from its journal records.
 *
 * The journal is a flat ordered stream; turns are how a person reads it. The
 * grouping is by `turnId` in first-seen order, which is the same order the
 * seq counter produced — there is no sorting and no ambiguity.
 */
type TurnGroup = {
  turnId: string;
  firstSeq: number;
  lane: string | null;
  source: string | null;
  phase: TurnPhase | null;
  notice: string | null;
  promptText: string | null;
  promptHidden: boolean;
  assistantTexts: string[];
  cards: JournalCard[];
  updatedAtMs: number;
};

const groupRecords = (records: readonly JournalRecord[]): TurnGroup[] => {
  const groups = new Map<string, TurnGroup>();
  for (const record of records) {
    let group = groups.get(record.turnId);
    if (!group) {
      group = {
        turnId: record.turnId,
        firstSeq: record.seq,
        lane: null,
        source: null,
        phase: null,
        notice: null,
        promptText: null,
        promptHidden: false,
        assistantTexts: [],
        cards: [],
        updatedAtMs: record.createdAtMs,
      };
      groups.set(record.turnId, group);
    }
    group.updatedAtMs = Math.max(group.updatedAtMs, record.createdAtMs);
    if (record.kind === "turn") {
      group.phase = record.phase;
      group.lane = record.lane ?? group.lane;
      group.source = record.source ?? group.source;
      group.notice = record.notice ?? group.notice;
      continue;
    }
    if (record.kind === "card") {
      group.cards.push(record.card);
      continue;
    }
    if (record.role === "user" && group.promptText === null) {
      group.promptText = messageText(record.payload);
      group.promptHidden = record.hidden;
      continue;
    }
    if (record.role === "assistant" && !record.hidden) {
      const text = messageText(record.payload);
      if (text) group.assistantTexts.push(text);
    }
    // `toolResult` rows are model context; they never render.
  }
  return [...groups.values()];
};

/** The prompt side of a turn: a bubble, a scheduled announcement, or nothing. */
function TurnPrompt({ group }: { group: TurnGroup }) {
  if (!group.promptText) return null;
  if (!group.promptHidden) {
    return (
      <div className="event-row">
        <div className="event-item user">
          <span className="cloud-tail__text">{group.promptText}</span>
        </div>
      </div>
    );
  }
  // A scheduled fire's prompt was written by the model when the schedule was
  // created, so a user bubble would put words in the user's mouth every time
  // it runs. The run is announced instead, with the instruction shown as what
  // fired. Every other hidden prompt (wake turns, lifecycle relays) is pure
  // plumbing and renders nothing at all.
  if (group.source !== "schedule") return null;
  return (
    <div className="event-row">
      <div className="cloud-tail__scheduled">
        <span className="cloud-tail__scheduled-label">Scheduled run</span>
        <span className="cloud-tail__scheduled-prompt">{group.promptText}</span>
      </div>
    </div>
  );
}

function TurnCard({
  card,
  appById,
}: {
  card: JournalCard;
  appById: ReadonlyMap<string, CloudApp>;
}) {
  if (card.type === "build") {
    return (
      <CloudBuildCard
        app={card.appId ? appById.get(card.appId) : undefined}
        buildId={card.buildId}
      />
    );
  }
  if (card.type === "files") return <CloudOutputFiles files={card.files} />;
  return (
    <div className="cloud-tail__outcome">
      <span>{operationOutcome(card)}</span>
      <details className="cloud-tail__details">
        <summary>Details</summary>
        <pre>
          {JSON.stringify(
            { operation: card.operation, args: card.args, result: card.result },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}

function CloudTurnRows({
  groups,
  apps,
  live,
  onCancel,
}: {
  groups: TurnGroup[];
  apps: CloudApp[];
  live: LiveStream | null;
  onCancel: (turnId: string) => boolean;
}) {
  const appById = useMemo(
    () => new Map(apps.map((app) => [app.appId, app])),
    [apps],
  );
  return (
    <>
      {groups.map((group) => {
        // Only a `started` record makes a turn running. A group assembled from
        // a card alone — Convex posts build and files cards under the turn that
        // produced them, which may have no lifecycle rows in this journal —
        // must not render a working line that never resolves.
        const running = group.phase === "started";
        const liveHere = live && live.turnId === group.turnId ? live : null;
        const failed =
          group.phase !== null &&
          group.phase !== "started" &&
          group.phase !== "completed";
        return (
          <div className="cloud-tail__turn" key={group.turnId}>
            <TurnPrompt group={group} />
            {group.assistantTexts.map((text, index) => (
              <div className="event-row" key={`${group.turnId}:t${index}`}>
                <div className="event-item assistant">
                  <span className="cloud-tail__text">{text}</span>
                </div>
              </div>
            ))}
            {running ? (
              <div className="event-row">
                <div className="event-item assistant">
                  {liveHere?.text ? (
                    <span className="cloud-tail__text">{liveHere.text}</span>
                  ) : (
                    <span className="cloud-tail__working">
                      {workingLabel(liveHere)}
                    </span>
                  )}
                  {liveHere?.dropped ? (
                    // The server stopped streaming this reply to stay inside
                    // its per-turn delta budget. The committed row still
                    // carries the whole thing.
                    <span className="cloud-tail__working">
                      Still writing — the rest lands when it's done.
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="cloud-tail__stop"
                    onClick={() => {
                      if (onCancel(group.turnId)) return;
                      showToast({
                        title:
                          "Couldn't reach Stella to stop this. Try again once you're back online.",
                        variant: "error",
                      });
                    }}
                  >
                    Stop
                  </button>
                </div>
              </div>
            ) : null}
            {group.cards.length ? (
              <div className="event-row">
                <div className="event-item assistant">
                  {group.cards.map((card, index) => (
                    <TurnCard
                      key={`${group.turnId}:c${index}`}
                      card={card}
                      appById={appById}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {failed ? (
              <div className="event-row">
                <div className="event-item assistant">
                  <span className="cloud-tail__problem">
                    {group.notice ?? "That didn't finish. Try again."}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** Prompts this client has sent that the journal has not echoed back yet. */
function PendingRows({
  pending,
  onRetry,
  onDismiss,
}: {
  pending: readonly PendingPrompt[];
  onRetry: (clientMsgId: string) => void;
  onDismiss: (clientMsgId: string) => void;
}) {
  if (!pending.length) return null;
  return (
    <>
      {pending.map((entry) => (
        <div className="cloud-tail__turn" key={entry.clientMsgId}>
          <div className="event-row">
            <div
              className="event-item user"
              data-pending={entry.error ? "failed" : "true"}
            >
              <span className="cloud-tail__text">{entry.text}</span>
            </div>
          </div>
          {entry.error ? (
            <div className="event-row">
              <div className="cloud-tail__send-error">
                <span className="cloud-tail__problem">{entry.error}</span>
                <span className="cloud-tail__send-error-actions">
                  <button
                    type="button"
                    className="cloud-tail__link-button"
                    onClick={() => onRetry(entry.clientMsgId)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="cloud-tail__link-button"
                    onClick={() => onDismiss(entry.clientMsgId)}
                  >
                    Discard
                  </button>
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * Bridges cloud turns into the normal chat surface without changing it:
 *  - renders recent cloud turns as ordinary chat rows via `extraTail`;
 *  - in the web/mobile interior (no local runtime), routes composer sends to
 *    the cloud chat mutation. On desktop the composer is untouched.
 */
export function useCloudChat(base: ChatColumnComposer): {
  composer: ChatColumnComposer;
  extraTail: ReactNode;
  /** True while the owner has cloud agent threads worth a sidebar. */
  hasCloudActivity: boolean;
} {
  const { isAuthenticated } = useConvexAuth();
  const apps = useQuery(cloudApi.listMyApps, isAuthenticated ? {} : "skip");
  const conversationId = useActiveCloudConversationId();
  const cloudActivity = useCloudActivity();
  const attachments = useCloudAttachments();
  // The web/mobile interior has no local runtime, so its composer sends to
  // the cloud. Desktop keeps its local runtime and reaches cloud workspaces
  // through spawn placement, not through a composer setting.
  const webShell = isWebShell();

  const decoratePrompt = useCallback(
    (prompt: string) => withAttachmentPreamble(prompt, attachments),
    [attachments],
  );
  const onSent = useCallback(() => cloudAttachmentsStore.clear(), []);
  const conversation = useConversation(conversationId, decoratePrompt, onSent);
  const {
    state,
    pending,
    send,
    retrySend,
    dismissSend,
    cancelTurn,
    loadOlder,
    retryConnection,
  } = conversation;

  // CarPlay dictation lands in the same cloud path.
  useEffect(() => {
    const onCarPlayPrompt = (event: Event) => {
      const message = (
        event as CustomEvent<{ prompt?: string }>
      ).detail?.prompt?.trim();
      if (message) void send(message);
    };
    window.addEventListener("stella:carplay-prompt", onCarPlayPrompt);
    return () =>
      window.removeEventListener("stella:carplay-prompt", onCarPlayPrompt);
  }, [send]);

  const groups = useMemo(() => groupRecords(state.records), [state.records]);

  const spokenTurns = useRef(new Set<string>());
  useEffect(() => {
    if (!isMobileShell()) return;
    const finished = groups.findLast(
      (group) =>
        group.phase === "completed" && !spokenTurns.current.has(group.turnId),
    );
    if (!finished) return;
    spokenTurns.current.add(finished.turnId);
    const reply = finished.assistantTexts.at(-1);
    speakCarPlayReply(
      reply ? reply.slice(0, 400) : "All set. Your app is ready.",
    );
  }, [groups]);

  // One send at a time: the composer unlocks as soon as the mutation answers,
  // not when the turn finishes. Queued turns are durable in the DO, but a
  // double-tap should still not fire the same prompt twice.
  const isSending = pending.some((entry) => entry.turnId === null && !entry.error);

  const composer = useMemo<ChatColumnComposer>(() => {
    if (!webShell) return base;
    return {
      ...base,
      canSubmit: base.message.trim().length > 0 && !isSending,
      onSend: () => {
        const message = base.message.trim();
        if (!message || isSending) return;
        base.setMessage("");
        void send(message);
      },
    };
  }, [base, webShell, isSending, send]);

  const visibleGroups = useMemo(() => {
    if (!groups.length) return groups;
    // Only the web interior is a pure cloud chat. On desktop the cloud tail
    // trails the local timeline, so it stays a recency window even while the
    // composer is pointed at the cloud — picking the destination must not
    // dump old cloud turns into the local conversation.
    if (webShell) return groups;
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return groups
      .filter(
        (group) =>
          group.phase === null ||
          group.phase === "started" ||
          group.updatedAtMs >= cutoff,
      )
      .slice(-10);
  }, [groups, webShell]);

  const hasRows = visibleGroups.length > 0 || pending.length > 0;
  const showStatus =
    state.status === "blocked" ||
    (state.status === "offline" && state.statusMessage !== null);

  const extraTail = useMemo<ReactNode>(() => {
    if (!hasRows && !showStatus) return null;
    return (
      <div className="cloud-tail">
        {showStatus ? (
          <div className="cloud-tail__status" data-status={state.status}>
            <span>
              {state.statusMessage ?? "Reconnecting to Stella's cloud…"}
            </span>
            {state.statusRetryable && state.status === "blocked" ? (
              <button
                type="button"
                className="cloud-tail__link-button"
                onClick={retryConnection}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
        {webShell && state.hasOlder ? (
          <button
            type="button"
            className="cloud-tail__load-older"
            onClick={loadOlder}
            disabled={state.loadingOlder}
          >
            {state.loadingOlder ? "Loading…" : "Show earlier messages"}
          </button>
        ) : webShell && state.olderNotice ? (
          <span className="cloud-tail__older-notice">{state.olderNotice}</span>
        ) : null}
        <CloudTurnRows
          groups={visibleGroups}
          apps={apps ?? []}
          live={state.live}
          onCancel={cancelTurn}
        />
        <PendingRows
          pending={pending}
          onRetry={(id) => void retrySend(id)}
          onDismiss={dismissSend}
        />
      </div>
    );
  }, [
    hasRows,
    showStatus,
    state.status,
    state.statusMessage,
    state.statusRetryable,
    state.hasOlder,
    state.loadingOlder,
    state.olderNotice,
    state.live,
    visibleGroups,
    apps,
    pending,
    webShell,
    cancelTurn,
    loadOlder,
    retryConnection,
    retrySend,
    dismissSend,
  ]);

  return {
    composer,
    extraTail,
    hasCloudActivity: cloudActivity.tasks.length > 0,
  };
}

import { useAction } from "convex/react";
import { useEffect, useMemo, useRef } from "react";
import { api } from "@/convex/api";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
const MOUNT_GRACE_MS = 2_000;
const isWellFormedThreadId = (value) => value.length > 0 && value.trim() === value;
/**
 * Select the durable Activity rows that own mobile lifecycle notifications.
 *
 * Only top-level work notifies the user. A subagent belongs to the agent that
 * spawned it, and its completion is that parent's business — it is delivered
 * into the parent's thread instead, so it must never surface as a user-facing
 * notification. The Activity feed intentionally omits the Orchestrator, so an
 * agent with no parent is exactly a root-spawned one.
 */
export function selectActivityNotificationTasks(tasks) {
    const seenIds = new Set();
    const duplicateIds = new Set();
    for (const task of tasks) {
        if (seenIds.has(task.id))
            duplicateIds.add(task.id);
        else
            seenIds.add(task.id);
    }
    return tasks.filter((task) => {
        if (!isWellFormedThreadId(task.id) || duplicateIds.has(task.id)) {
            return false;
        }
        if (task.source !== "stella")
            return false;
        if (task.agentType !== AGENT_IDS.GENERAL)
            return false;
        return task.parentAgentId === undefined;
    });
}
export function collectActivityNotificationKinds(tasks, records, mountedAtMs) {
    const kinds = [];
    const seenTaskIds = new Set();
    for (const task of tasks) {
        seenTaskIds.add(task.id);
        let record = records.get(task.id);
        if (!record) {
            record = {
                attemptGeneration: task.attemptGeneration,
                observedRunning: task.status === "running",
                eligibleForStartedNotification: task.startedAtMs >= mountedAtMs - MOUNT_GRACE_MS,
                startedNotified: false,
                terminalNotified: false,
            };
            records.set(task.id, record);
        }
        else {
            const recordedGeneration = record.attemptGeneration;
            const observedGeneration = task.attemptGeneration;
            if (recordedGeneration !== undefined &&
                (observedGeneration === undefined ||
                    observedGeneration < recordedGeneration)) {
                continue;
            }
            if (recordedGeneration !== undefined &&
                observedGeneration !== undefined &&
                observedGeneration > recordedGeneration) {
                record = {
                    attemptGeneration: observedGeneration,
                    observedRunning: task.status === "running",
                    // The mounted bridge observed this generation advance, so it owns
                    // the new attempt's start even though the thread's durable
                    // startedAtMs still describes its first-ever attempt.
                    eligibleForStartedNotification: true,
                    startedNotified: false,
                    terminalNotified: false,
                };
                records.set(task.id, record);
            }
            else if (recordedGeneration === undefined &&
                observedGeneration !== undefined) {
                // Attaching a generation to an already-observed legacy snapshot does
                // not by itself prove that a new attempt began.
                record.attemptGeneration = observedGeneration;
            }
        }
        if (task.status === "running") {
            record.observedRunning = true;
            if (record.eligibleForStartedNotification && !record.startedNotified) {
                record.startedNotified = true;
                kinds.push("started");
            }
            continue;
        }
        const terminalAtMs = task.completedAtMs ?? task.lastUpdatedAtMs ?? task.startedAtMs;
        const eligibleForTerminalNotification = record.observedRunning || terminalAtMs >= mountedAtMs - MOUNT_GRACE_MS;
        if (!record.terminalNotified &&
            eligibleForTerminalNotification &&
            task.status !== "canceled") {
            record.terminalNotified = true;
            kinds.push(task.status === "completed" ? "completed" : "failed");
        }
    }
    for (const taskId of records.keys()) {
        if (seenTaskIds.has(taskId))
            continue;
        records.delete(taskId);
    }
    return kinds;
}
export function MobileActivityNotificationsBridge() {
    const { hasConnectedAccount } = useAuthSessionState();
    const chat = useChatRuntime();
    const sendActivityNotification = useAction(api.mobile_push.sendActivityNotification);
    const mountedAtMsRef = useRef(Date.now());
    const recordsRef = useRef(new Map());
    const allTasks = useMemo(() => selectActivityNotificationTasks(chat.conversation.tasks), [chat.conversation.tasks]);
    useEffect(() => {
        const send = (kind) => {
            void sendActivityNotification({ kind }).catch((error) => {
                console.warn("[mobile-activity] Failed to send notification:", error);
            });
        };
        if (!hasConnectedAccount) {
            recordsRef.current.clear();
            return;
        }
        const kinds = collectActivityNotificationKinds(allTasks, recordsRef.current, mountedAtMsRef.current);
        for (const kind of kinds) {
            send(kind);
        }
    }, [allTasks, hasConnectedAccount, sendActivityNotification]);
    return null;
}

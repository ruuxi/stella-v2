import { useEffect, useMemo, useReducer, useRef } from "react";
import { getEventText, selectFreshActivityTasks, TASK_COMPLETION_INDICATOR_MS, } from "@/features/chat/lib/event-transforms";
import { filterMessagesForUiDisplay } from "@/features/chat/lib/message-display";
import { getWorkingIndicatorDisplayStatus } from "@/features/chat/working-indicator-state";
import { readLastSeenPetAssistantMessageId, writeLastSeenPetAssistantMessageId, } from "./pet-preferences";
const IDLE_STATUS = {
    state: "idle",
    title: "",
    message: "",
    isLoading: false,
};
const WORKING_PHRASES = [
    "Scheming",
    "Cooking",
    "Pondering",
    "Thinking",
    "Tinkering",
    "Investigating",
    "Exploring",
    "Untangling",
    "Polishing",
    "Composing",
    "Drafting",
    "Inspecting",
    "Tracing",
    "Scanning",
    "Crunching",
    "Stitching",
    "Weaving",
    "Sharpening",
    "Assembling",
    "Calibrating",
    "Brewing",
    "Mulling",
    "Plotting",
    "Refining",
    "Chiseling",
    "Sorting",
    "Mapping",
    "Navigating",
    "Sleuthing",
    "Experimenting",
    "Debugging",
    "Reworking",
    "Balancing",
    "Sifting",
    "Loading thoughts",
    "Following clues",
    "Making sparks",
    "Herding bits",
    "Checking corners",
    "Connecting dots",
];
const deriveState = ({ liveTasks, isStreaming, pendingUserMessageId, }) => {
    const tasks = (liveTasks ?? []);
    if (tasks.some((task) => task.status === "error"))
        return "failed";
    if (tasks.some((task) => task.requiresUserInput))
        return "waiting";
    if (isStreaming ||
        Boolean(pendingUserMessageId) ||
        tasks.some((task) => task.status === "running")) {
        return "running";
    }
    if (tasks.some((task) => task.status === "completed"))
        return "review";
    return "idle";
};
const latestAssistantMessage = (messages) => {
    const displayMessages = filterMessagesForUiDisplay(messages ?? []);
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
        const message = displayMessages[index];
        if (!message || message.type !== "assistant_message")
            continue;
        const text = getEventText(message).replace(/\s+/g, " ").trim();
        if (text.length > 0)
            return { id: message._id, text };
    }
    return null;
};
const getWorkingPhrase = (seed) => {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return WORKING_PHRASES[hash % WORKING_PHRASES.length];
};
/**
 * Derive a `PetOverlayStatus` from the full-shell chat surface and push
 * it to every renderer (the pet window subscribes via
 * `electronAPI.pet.onStatus`).
 *
 * The chat surface already runs once per app via `ChatRuntimeProvider`,
 * so we don't pay any extra subscription cost here — we just pluck the
 * fields the pet cares about, debounce-by-equality, and fan out.
 */
export const usePetStatusBroadcast = ({ messages, tasks, runtimeStatusText, isStreaming, pendingUserMessageId, }) => {
    const lastSeenAssistantMessageIdRef = useRef(readLastSeenPetAssistantMessageId());
    // Rows are durable history now, so "just finished" is a time window, not
    // a presence signal. Re-derive after the completion beat elapses so the
    // pet settles back to idle without waiting for the next unrelated render.
    const [freshTick, bumpFreshTick] = useReducer((n) => n + 1, 0);
    const liveTasks = useMemo(() => selectFreshActivityTasks(tasks ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freshTick re-runs the time-window filter.
    [tasks, freshTick]);
    useEffect(() => {
        if (!liveTasks.some((task) => task.status !== "running"))
            return;
        const timer = window.setTimeout(bumpFreshTick, TASK_COMPLETION_INDICATOR_MS + 50);
        return () => window.clearTimeout(timer);
    }, [liveTasks]);
    const latestAssistant = useMemo(() => (isStreaming ? null : latestAssistantMessage(messages)), [isStreaming, messages]);
    const status = useMemo(() => {
        const state = deriveState({
            liveTasks,
            isStreaming,
            pendingUserMessageId: pendingUserMessageId ?? null,
        });
        const assistantMessage = latestAssistant?.text ?? "";
        if (state === "idle") {
            return assistantMessage &&
                latestAssistant?.id !== lastSeenAssistantMessageIdRef.current
                ? {
                    state,
                    title: "",
                    message: assistantMessage,
                    isLoading: false,
                }
                : IDLE_STATUS;
        }
        const statusMessage = getWorkingIndicatorDisplayStatus({
            status: runtimeStatusText,
            tasks: liveTasks ?? undefined,
        });
        return {
            state,
            title: "",
            message: state === "running"
                ? getWorkingPhrase(`${statusMessage}|${runtimeStatusText}|${pendingUserMessageId ?? ""}|${liveTasks?.[0]?.id ?? ""}`)
                : assistantMessage || statusMessage,
            isLoading: false,
        };
    }, [
        liveTasks,
        runtimeStatusText,
        isStreaming,
        pendingUserMessageId,
        latestAssistant,
    ]);
    const lastSentRef = useRef("");
    useEffect(() => {
        const fingerprint = `${status.state}|${status.title}|${status.message}|${status.isLoading ? 1 : 0}`;
        if (fingerprint === lastSentRef.current)
            return;
        lastSentRef.current = fingerprint;
        window.electronAPI?.pet?.pushStatus?.(status);
    }, [status]);
    useEffect(() => {
        if (status.state !== "idle" || !status.message.trim())
            return;
        const id = latestAssistant?.id;
        if (!id || id === lastSeenAssistantMessageIdRef.current)
            return;
        writeLastSeenPetAssistantMessageId(id);
        lastSeenAssistantMessageIdRef.current = id;
    }, [latestAssistant, status.message, status.state]);
    // Subscribe to inbound `pet:sendMessage` from the overlay popover and
    // re-emit it as a Stella send-message custom event so the existing
    // chat surface ingests it. We mount this in the chat runtime provider,
    // which is the only React
    // tree that listens for `STELLA_SEND_MESSAGE_EVENT`.
    useEffect(() => {
        const cleanup = window.electronAPI?.pet?.onSendMessage?.((text) => {
            if (typeof text !== "string" || text.trim().length === 0)
                return;
            window.dispatchEvent(new CustomEvent("stella:send-message", {
                detail: { text, source: "pet" },
            }));
        });
        return () => cleanup?.();
    }, []);
};

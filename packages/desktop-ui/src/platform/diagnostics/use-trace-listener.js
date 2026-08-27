import { useEffect, useRef } from "react";
import { AGENT_IDS, AGENT_STREAM_EVENT_TYPES, } from "@stella/contracts/agent-runtime";
import { isAgentStartedEvent, isAgentCompletedEvent, isAgentCanceledEvent, isAgentFailedEvent, isAgentProgressEvent, isToolRequest, isToolResult, isUserMessage, isAssistantMessage, getEventText, } from "@/features/chat/lib/event-transforms";
import { traceToolStart, traceToolEnd, traceAgentError, traceStreamEnd, traceTaskStarted, traceTaskCompleted, traceTaskCanceled, traceTaskFailed, traceTaskProgress, traceUserMessage, traceAssistantMessage, registerRunAgent, unregisterRunAgent, clearRunToolStarts, addTrace, formatTraceSnippet, } from "@/platform/diagnostics/trace-store";

export function useTraceIpcListener(enabled) {
    useEffect(() => {
        if (!enabled || !window.electronAPI?.agent?.onStream)
            return;
        const cleanup = window.electronAPI.agent.onStream((event) => {
            if (event.agentType) {
                registerRunAgent(event.runId, event.agentType);
            }
            switch (event.type) {
                case AGENT_STREAM_EVENT_TYPES.TOOL_START:
                    traceToolStart(event.toolName ?? "unknown", event.toolCallId, event.runId, event.args);
                    break;
                case AGENT_STREAM_EVENT_TYPES.TOOL_END:
                    traceToolEnd(event.toolName ?? "unknown", event.toolCallId, event.resultPreview, event.runId);
                    break;
                case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
                    if (event.outcome === "error") {
                        traceAgentError(event.error ?? event.reason ?? "unknown error", true, event.runId);
                    }
                    else {
                        traceStreamEnd(event.runId, `${event.outcome ?? "completed"} ${(event.finalText ?? "").slice(0, 160)}`.trim());
                    }

                    unregisterRunAgent(event.runId);
                    clearRunToolStarts(event.runId);
                    break;
                case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
                    traceTaskStarted(event.agentId ?? "unknown", event.agentType ?? "unknown", event.description ?? "", event.parentAgentId);
                    break;
                case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
                    traceTaskCompleted(event.agentId ?? "unknown", event.result);
                    break;
                case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED:
                    traceTaskCanceled(event.agentId ?? "unknown", event.error);
                    break;
                case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
                    traceTaskFailed(event.agentId ?? "unknown", event.error);
                    break;
                case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
                    traceTaskProgress(event.agentId ?? "unknown", event.statusText ?? "");
                    break;

            }
        });
        addTrace("system", "trace-listener-attached", "IPC trace listener started");
        return () => {
            cleanup();
        };
    }, [enabled]);
}

const MAX_SEEN_IDS = 5000;

export function useTraceEventMonitor(enabled, events) {
    const seenIdsRef = useRef(new Set());
    useEffect(() => {
        const seen = seenIdsRef.current;
        if (events.length === 0)
            seen.clear();
        if (!enabled)
            return;
        for (const event of events) {
            if (seen.has(event._id))
                continue;
            seen.add(event._id);

            if (seen.size > MAX_SEEN_IDS) {
                const oldest = seen.values().next().value;
                if (oldest !== undefined)
                    seen.delete(oldest);
            }
            if (isAgentStartedEvent(event)) {
                const p = event.payload;
                traceTaskStarted(p.agentId, p.agentType, p.description, p.parentAgentId);
                continue;
            }
            if (isAgentCompletedEvent(event)) {
                traceTaskCompleted(event.payload.agentId, event.payload.result);
                continue;
            }
            if (isAgentFailedEvent(event)) {
                traceTaskFailed(event.payload.agentId, event.payload.error);
                continue;
            }
            if (isAgentCanceledEvent(event)) {
                traceTaskCanceled(event.payload.agentId, event.payload.error);
                continue;
            }
            if (isAgentProgressEvent(event)) {
                traceTaskProgress(event.payload.agentId, event.payload.statusText);
                continue;
            }
            if (isToolRequest(event)) {
                const p = event.payload;

                if (p.agentType && p.agentType !== AGENT_IDS.ORCHESTRATOR) {
                    addTrace("tool", "tool-request", `[${p.agentType}] ${p.toolName}`, {
                        toolName: p.toolName,
                        agent: p.agentType,
                        data: p.args ? { args: p.args } : undefined,
                    });
                }
                continue;
            }
            if (isToolResult(event)) {
                const p = event.payload;
                if (p.error) {
                    addTrace("error", "tool-error", `${p.toolName}: ${formatTraceSnippet(p.error, 200)}`, {
                        toolName: p.toolName,
                        agent: p.agentType,
                        data: { error: p.error },
                    });
                }
                continue;
            }
            if (isUserMessage(event)) {
                traceUserMessage(getEventText(event), event._id);
                continue;
            }
            if (isAssistantMessage(event)) {
                traceAssistantMessage(getEventText(event), event._id);
                continue;
            }
        }
    }, [enabled, events]);
}

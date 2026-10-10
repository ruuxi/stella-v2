import { waitForConnectedRunner } from "./runtime-availability.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";
import {
  IPC_SCHEDULE_LIST_CRON_JOBS,
  IPC_SCHEDULE_LIST_HEARTBEATS,
  IPC_SCHEDULE_LIST_CONVERSATION_EVENTS,
  IPC_SCHEDULE_GET_EVENT_COUNT,
  IPC_SCHEDULE_RUN_CRON_JOB,
  IPC_SCHEDULE_REMOVE_CRON_JOB,
  IPC_SCHEDULE_UPDATE_CRON_JOB,
  IPC_SCHEDULE_UPSERT_HEARTBEAT,
  IPC_SCHEDULE_RUN_HEARTBEAT,
} from "@stella/contracts/desktop/ipc-channels";
export const registerScheduleHandlers = (options) => {
    const waitForRunner = (timeoutMs = 10_000) => waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs,
        unavailableMessage: "Runtime not available.",
        onRunnerChanged: options.onStellaHostRunnerChanged,
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_LIST_CRON_JOBS, async () => {
        return await (await waitForRunner()).listCronJobs();
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_LIST_HEARTBEATS, async () => {
        return await (await waitForRunner()).listHeartbeats();
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_LIST_CONVERSATION_EVENTS, async (_event, payload) => {
        const conversationId = typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId) {
            return [];
        }
        const maxItems = Number(payload?.maxItems);
        return await (await waitForRunner()).listConversationEvents({
            conversationId,
            maxItems: Number.isFinite(maxItems) ? maxItems : undefined,
        });
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_GET_EVENT_COUNT, async (_event, payload) => {
        const conversationId = typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId) {
            return 0;
        }
        return await (await waitForRunner()).getConversationEventCount({ conversationId });
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_RUN_CRON_JOB, async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId)
            return null;
        return await (await waitForRunner()).runCronJob(jobId);
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_REMOVE_CRON_JOB, async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId)
            return false;
        return await (await waitForRunner()).removeCronJob(jobId);
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_UPDATE_CRON_JOB, async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId || !payload?.patch || typeof payload.patch !== "object") {
            return null;
        }
        return await (await waitForRunner()).updateCronJob(jobId, payload.patch);
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_UPSERT_HEARTBEAT, async (_event, payload) => {
        return await (await waitForRunner()).upsertHeartbeat(payload);
    });
    registerPrivilegedHandle(options, IPC_SCHEDULE_RUN_HEARTBEAT, async (_event, payload) => {
        const conversationId = typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId)
            return null;
        return await (await waitForRunner()).runHeartbeat(conversationId);
    });
};

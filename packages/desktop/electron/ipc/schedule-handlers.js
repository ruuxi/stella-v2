import { waitForConnectedRunner } from "./runtime-availability.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";
export const registerScheduleHandlers = (options) => {
    const waitForRunner = (timeoutMs = 10_000) => waitForConnectedRunner(options.getStellaHostRunner, {
        timeoutMs,
        unavailableMessage: "Runtime not available.",
        onRunnerChanged: options.onStellaHostRunnerChanged,
    });
    registerPrivilegedHandle(options, "schedule:listCronJobs", async () => {
        return await (await waitForRunner()).listCronJobs();
    });
    registerPrivilegedHandle(options, "schedule:listHeartbeats", async () => {
        return await (await waitForRunner()).listHeartbeats();
    });
    registerPrivilegedHandle(options, "schedule:listConversationEvents", async (_event, payload) => {
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
    registerPrivilegedHandle(options, "schedule:getConversationEventCount", async (_event, payload) => {
        const conversationId = typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId) {
            return 0;
        }
        return await (await waitForRunner()).getConversationEventCount({ conversationId });
    });
    registerPrivilegedHandle(options, "schedule:runCronJob", async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId)
            return null;
        return await (await waitForRunner()).runCronJob(jobId);
    });
    registerPrivilegedHandle(options, "schedule:removeCronJob", async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId)
            return false;
        return await (await waitForRunner()).removeCronJob(jobId);
    });
    registerPrivilegedHandle(options, "schedule:updateCronJob", async (_event, payload) => {
        const jobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
        if (!jobId || !payload?.patch || typeof payload.patch !== "object") {
            return null;
        }
        return await (await waitForRunner()).updateCronJob(jobId, payload.patch);
    });
    registerPrivilegedHandle(options, "schedule:upsertHeartbeat", async (_event, payload) => {
        return await (await waitForRunner()).upsertHeartbeat(payload);
    });
    registerPrivilegedHandle(options, "schedule:runHeartbeat", async (_event, payload) => {
        const conversationId = typeof payload?.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        if (!conversationId)
            return null;
        return await (await waitForRunner()).runHeartbeat(conversationId);
    });
};

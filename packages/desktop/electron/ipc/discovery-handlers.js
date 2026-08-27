import { ipcMain } from "electron";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { IPC_DISCOVERY_COLLECT_ALL_SIGNALS, IPC_DISCOVERY_COLLECT_BROWSER_DATA, IPC_DISCOVERY_CORE_MEMORY_EXISTS, IPC_DISCOVERY_DETECT_PREFERRED_BROWSER, IPC_DISCOVERY_KNOWLEDGE_EXISTS, IPC_DISCOVERY_LIST_BROWSER_PROFILES, IPC_DISCOVERY_WRITE_CORE_MEMORY, IPC_DISCOVERY_WRITE_KNOWLEDGE, } from "@stella/contracts/desktop/ipc-channels";
const DISCOVERY_RUNNER_TIMEOUT_MS = 30_000;
const waitForDiscoveryRunner = async (options) => await waitForConnectedRunner(options.getStellaHostRunner, {
    timeoutMs: DISCOVERY_RUNNER_TIMEOUT_MS,
    unavailableMessage: "Runtime not available.",
    onRunnerChanged: options.onStellaHostRunnerChanged,
});
const collectWithRunnerEnvelope = async (options, event, channel, action) => {
    if (!options.assertPrivilegedSender(event, channel)) {
        throw new Error("Blocked untrusted request.");
    }
    try {
        const runner = await waitForDiscoveryRunner(options);
        return await action(runner);
    }
    catch (error) {
        return {
            data: null,
            formatted: null,
            error: error.message,
        };
    }
};
export const registerDiscoveryHandlers = (options) => {
    const requirePrivileged = (event, channel) => {
        if (!options.assertPrivilegedSender(event, channel)) {
            throw new Error("Blocked untrusted request.");
        }
    };
    ipcMain.handle(IPC_DISCOVERY_CORE_MEMORY_EXISTS, async (event) => {
        requirePrivileged(event, IPC_DISCOVERY_CORE_MEMORY_EXISTS);
        const runner = options.getStellaHostRunner();
        if (!runner)
            return false;
        try {
            return await runner.coreMemoryExists();
        }
        catch {
            return false;
        }
    });
    ipcMain.handle(IPC_DISCOVERY_KNOWLEDGE_EXISTS, async (event) => {
        requirePrivileged(event, IPC_DISCOVERY_KNOWLEDGE_EXISTS);
        const runner = options.getStellaHostRunner();
        if (!runner)
            return false;
        try {
            return await runner.discoveryKnowledgeExists();
        }
        catch {
            return false;
        }
    });
    ipcMain.handle(IPC_DISCOVERY_COLLECT_BROWSER_DATA, async (event, collectOptions) => await collectWithRunnerEnvelope(options, event, IPC_DISCOVERY_COLLECT_BROWSER_DATA, async (runner) => {
        const result = await runner.collectBrowserData(collectOptions);
        return {
            data: result.data,
            formatted: result.formatted,
        };
    }));
    ipcMain.handle(IPC_DISCOVERY_WRITE_CORE_MEMORY, async (event, payload) => {
        if (!options.assertPrivilegedSender(event, IPC_DISCOVERY_WRITE_CORE_MEMORY)) {
            throw new Error("Blocked untrusted request.");
        }
        const content = typeof payload === "string" ? payload : payload.content;
        const includeLocation = typeof payload === "string" ? false : payload.includeLocation === true;
        try {
            const runner = await waitForDiscoveryRunner(options);
            await runner.writeCoreMemory(content, { includeLocation });
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    });
    ipcMain.handle(IPC_DISCOVERY_WRITE_KNOWLEDGE, async (event, payload) => {
        if (!options.assertPrivilegedSender(event, IPC_DISCOVERY_WRITE_KNOWLEDGE)) {
            throw new Error("Blocked untrusted request.");
        }
        try {
            const runner = await waitForDiscoveryRunner(options);
            await runner.writeDiscoveryKnowledge(payload);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    });
    ipcMain.handle(IPC_DISCOVERY_DETECT_PREFERRED_BROWSER, async (event) => {
        requirePrivileged(event, IPC_DISCOVERY_DETECT_PREFERRED_BROWSER);
        try {
            const runner = await waitForDiscoveryRunner(options);
            return await runner.detectPreferredBrowserProfile();
        }
        catch {
            return null;
        }
    });
    ipcMain.handle(IPC_DISCOVERY_LIST_BROWSER_PROFILES, async (event, browserType) => {
        requirePrivileged(event, IPC_DISCOVERY_LIST_BROWSER_PROFILES);
        try {
            const runner = await waitForDiscoveryRunner(options);
            return await runner.listBrowserProfiles(browserType);
        }
        catch {
            return [];
        }
    });
    ipcMain.handle(IPC_DISCOVERY_COLLECT_ALL_SIGNALS, async (event, ipcOptions) => await collectWithRunnerEnvelope(options, event, IPC_DISCOVERY_COLLECT_ALL_SIGNALS, async (runner) => await runner.collectAllSignals(ipcOptions)));
};

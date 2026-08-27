import { randomUUID } from "crypto";
import { BrowserWindow, shell } from "electron";
import { enableNativeConnector, getNativeConnectorTools, } from "@stella/runtime/kernel/connectors/native-integrations";
import { STELLA_BROWSER_EXTENSION_ID } from "@stella/runtime/kernel/tools/stella-browser-bridge-config";
import { isStellaExtensionInstalled } from "./stella-browser-bridge-service.js";
import { ensureNativeCredential, loadConfiguredOAuthProviders, resolveDesktopNativeConnectorEntry, } from "../ipc/native-integration-handlers.js";
import { PendingRequestStore } from "./pending-request-store.js";

const CARD_TIMEOUT_MS = 9.5 * 60 * 1000;

const BROWSER_EXTENSION_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${STELLA_BROWSER_EXTENSION_ID}`;
const EXTENSION_POLL_INTERVAL_MS = 2_000;
const EXTENSION_CONNECT_GRACE_MS = 6_000;
const EXTENSION_ALREADY_INSTALLED_GRACE_MS = 8_000;
const EXTENSION_FLOW_TIMEOUT_MS = 4 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isCanonicalConnectorConnectable = (entry) => Boolean(entry &&
    entry.connectable &&
    getNativeConnectorTools(entry).length > 0 &&
    (entry.provider === "backend-composio" ||
        entry.localExecution === "production-ready"));
const connectorIdentityFingerprint = (target) => {
    const { entry, catalog } = target;
    return JSON.stringify({
        id: entry.id,
        catalogSource: catalog.sources[entry.id] ?? catalog.source,
        provider: entry.provider,
        backendToolkit: entry.backendConnector?.toolkit ?? null,
        localExecution: entry.localExecution ?? null,
        toolPrefix: entry.toolPrefix ?? null,
        tools: getNativeConnectorTools(entry).map((tool) => tool.name),
        connectable: entry.connectable,
        auth: [...entry.auth],
        catalogToolCount: entry.catalogToolCount,
        oauthConfig: entry.oauthConfig ?? null,
    });
};
export class ConnectorConnectService {
    options;
    pending = new PendingRequestStore();
    meta = new Map();
    constructor(options) {
        this.options = options;
    }
    async requestConnection(payload) {
        const stellaAppDir = this.options.getStellaAppDir();
        if (!stellaAppDir) {
            return { ok: false, reason: "unsupported" };
        }
        const target = await resolveDesktopNativeConnectorEntry({
            getConvexAuthToken: this.options.getConvexAuthToken,
            getConvexSiteUrl: this.options.getConvexSiteUrl,
        }, stellaAppDir, payload.id.trim().toLowerCase());
        const { entry } = target;
        if (!isCanonicalConnectorConnectable(entry)) {
            return { ok: false, reason: "connector_unavailable" };
        }
        const windowManager = this.options.windowManagerTarget.getWindowManager();
        const fullWindow = windowManager?.getFullWindow() ?? null;
        const targetWindows = fullWindow
            ? [fullWindow]
            : BrowserWindow.getAllWindows();
        if (targetWindows.length === 0) {
            return { ok: false, reason: "unsupported" };
        }
        const requestId = randomUUID();
        this.meta.set(requestId, {
            id: entry.id,
            name: entry.name,
            kind: "integration",
            state: "pending",
            ...(payload.offerId ? { offerId: payload.offerId } : {}),
            canonicalFingerprint: connectorIdentityFingerprint({
                catalog: target.catalog,
                entry: entry,
            }),
            oauthAbort: new AbortController(),
            windows: targetWindows,
        });
        const request = {
            requestId,
            id: entry.id,
            name: entry.name,
            description: entry.description,
            iconUrl: entry.iconUrl,
            category: entry.category,
            reason: payload.reason,
            kind: "integration",
            ...(payload.conversationId
                ? { conversationId: payload.conversationId }
                : {}),
        };
        const settled = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                const meta = this.meta.get(requestId);
                if (!this.pending.has(requestId))
                    return;

                if (meta?.state === "connecting") {
                    meta.oauthAbort.abort(new Error("Connection timed out."));
                }
                this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
            }, CARD_TIMEOUT_MS);
            this.pending.set(requestId, {
                resolve,
                reject: () => undefined,
                timeout,
            });
        });
        for (const window of targetWindows) {
            if (window.isDestroyed())
                continue;
            window.webContents.send("connector-connect:request", request);
        }
        return settled;
    }

    async requestBrowserExtensionConnect(payload) {
        for (const meta of this.meta.values()) {
            if (meta.kind === "browser-extension") {

                return { ok: false, reason: "already_pending" };
            }
        }
        const windowManager = this.options.windowManagerTarget.getWindowManager();
        const fullWindow = windowManager?.getFullWindow() ?? null;
        const targetWindows = fullWindow
            ? [fullWindow]
            : BrowserWindow.getAllWindows();
        if (targetWindows.length === 0) {
            return { ok: false, reason: "unsupported" };
        }
        const requestId = randomUUID();
        this.meta.set(requestId, {
            id: "stella-browser-extension",
            name: "the Stella browser extension",
            kind: "browser-extension",
            state: "pending",
            ...(payload.offerId ? { offerId: payload.offerId } : {}),
            oauthAbort: new AbortController(),
            windows: targetWindows,
        });
        const request = {
            requestId,
            id: "stella-browser-extension",
            name: "Stella browser extension",
            description: "Lets Stella work inside your real browser — your logged-in sites, tabs, and pages.",
            reason: "Stella needs your browser to continue this task, but the extension isn't connected yet.",
            kind: "browser-extension",
            ...(payload.conversationId
                ? { conversationId: payload.conversationId }
                : {}),
        };
        const settled = new Promise((resolve) => {
            const timeout = setTimeout(() => {
                const meta = this.meta.get(requestId);
                if (!this.pending.has(requestId))
                    return;

                if (meta?.state === "connecting") {
                    meta.oauthAbort.abort(new Error("Connection timed out."));
                }
                this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
            }, CARD_TIMEOUT_MS);
            this.pending.set(requestId, {
                resolve,
                reject: () => undefined,
                timeout,
            });
        });
        for (const window of targetWindows) {
            if (window.isDestroyed())
                continue;
            window.webContents.send("connector-connect:request", request);
        }
        return settled;
    }
    respond(payload) {
        const meta = this.meta.get(payload.requestId);
        if (!meta || !this.pending.has(payload.requestId)) {
            return { ok: false, error: "Connect request not found." };
        }
        if (payload.action === "decline") {
            meta.oauthAbort.abort(new Error("Connection declined."));
            this.settle(payload.requestId, { ok: false, reason: "declined" }, "declined");
            return { ok: true };
        }
        if (payload.action === "cancel") {

            meta.oauthAbort.abort(new Error("Connection cancelled."));
            if (meta.state === "pending") {
                this.settle(payload.requestId, { ok: false, reason: "cancelled" }, "cancelled");
            }
            return { ok: true };
        }
        if (meta.state !== "pending") {
            return { ok: false, error: "Connect flow already started." };
        }
        meta.state = "connecting";
        this.broadcastUpdate(meta.windows, payload.requestId, "connecting");
        if (meta.kind === "browser-extension") {
            void this.runBrowserExtensionFlow(payload.requestId, meta);
        }
        else {
            void this.runConnectFlow(payload.requestId, meta);
        }
        return { ok: true };
    }
    cancelAll() {
        for (const [requestId, meta] of this.meta) {
            meta.oauthAbort.abort(new Error("Connection cancelled."));
            this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
        }
    }

    cancelByOfferId(offerId) {
        for (const [requestId, meta] of this.meta) {
            if (meta.offerId !== offerId)
                continue;
            meta.oauthAbort.abort(new Error("Connection cancelled."));
            if (meta.state === "pending") {
                this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
            }
            return { ok: true };
        }
        return { ok: false };
    }
    async runConnectFlow(requestId, meta) {
        const stellaAppDir = this.options.getStellaAppDir();
        if (!stellaAppDir) {
            this.settle(requestId, { ok: false, reason: "unsupported" }, "error", "Stella root is unavailable.");
            return;
        }
        const credentialService = this.options.connectorCredentialService;
        const flowOptions = {
            getConvexAuthToken: this.options.getConvexAuthToken,
            getConvexSiteUrl: this.options.getConvexSiteUrl,

            abortSignal: meta.oauthAbort.signal,

            requestPreregisteredOAuth: (payload) => credentialService.requestPreregisteredOAuth({
                ...payload,
                presentation: "headless",
                oauthAbort: meta.oauthAbort,
            }),
            requestExternalOAuthApproval: (payload) => credentialService.requestExternalOAuthApproval({
                ...payload,
                presentation: "headless",
            }),

            requestDeviceOAuth: (payload) => credentialService.requestDeviceOAuth(payload),
        };
        try {
            const target = await resolveDesktopNativeConnectorEntry(flowOptions, stellaAppDir, meta.id);
            const { catalog, entry } = target;
            if (!isCanonicalConnectorConnectable(entry)) {
                throw new Error(`${meta.name} is no longer available through an executable native integration.`);
            }
            const acceptedTarget = { catalog, entry: entry };
            if (!meta.canonicalFingerprint ||
                connectorIdentityFingerprint(acceptedTarget) !==
                    meta.canonicalFingerprint) {
                throw new Error(`${meta.name} connector changed while the card was open. Retry the connection.`);
            }
            await ensureNativeCredential(flowOptions, stellaAppDir, entry.id, acceptedTarget);
            const configuredOAuthProviders = await loadConfiguredOAuthProviders(flowOptions);
            await enableNativeConnector(stellaAppDir, entry.id, "desktop", {
                configuredBackendProviders: configuredOAuthProviders.backend,
                configuredExternalCallbackProviders: configuredOAuthProviders.externalCallback,
            }, catalog.entries);
            this.settle(requestId, { ok: true, status: "connected" }, "connected");
        }
        catch (error) {
            if (!this.pending.has(requestId))
                return;
            const cancelled = meta.oauthAbort.signal.aborted;
            const message = error instanceof Error ? error.message : "Connection failed.";
            this.settle(requestId, { ok: false, reason: cancelled ? "cancelled" : message }, cancelled ? "cancelled" : "error", cancelled ? undefined : message);
        }
    }
    async runBrowserExtensionFlow(requestId, meta) {
        const signal = meta.oauthAbort.signal;
        const settleCancelled = () => this.settle(requestId, { ok: false, reason: "cancelled" }, "cancelled");
        const alreadyInstalled = isStellaExtensionInstalled();
        void shell
            .openExternal(BROWSER_EXTENSION_WEB_STORE_URL)
            .catch(() => undefined);
        if (alreadyInstalled) {

            await sleep(EXTENSION_ALREADY_INSTALLED_GRACE_MS);
            if (!this.pending.has(requestId))
                return;
            if (signal.aborted) {
                settleCancelled();
                return;
            }
            this.settle(requestId, { ok: true, status: "already_connected" }, "connected");
            return;
        }
        const deadline = Date.now() + EXTENSION_FLOW_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (!this.pending.has(requestId))
                return;
            if (signal.aborted) {
                settleCancelled();
                return;
            }
            if (isStellaExtensionInstalled()) {

                await sleep(EXTENSION_CONNECT_GRACE_MS);
                if (!this.pending.has(requestId))
                    return;
                if (signal.aborted) {
                    settleCancelled();
                    return;
                }
                this.settle(requestId, { ok: true, status: "connected" }, "connected");
                return;
            }
            await sleep(EXTENSION_POLL_INTERVAL_MS);
        }
        if (this.pending.has(requestId)) {
            this.settle(requestId, { ok: false, reason: "timeout" }, "timeout");
        }
    }
    settle(requestId, outcome, phase, message) {
        const meta = this.meta.get(requestId);
        if (!this.pending.resolve(requestId, outcome))
            return;
        this.meta.delete(requestId);
        this.broadcastUpdate(meta?.windows ?? BrowserWindow.getAllWindows(), requestId, phase, message);
    }
    broadcastUpdate(windows, requestId, phase, message) {
        for (const window of windows) {
            if (window.isDestroyed())
                continue;
            window.webContents.send("connector-connect:update", {
                requestId,
                phase,
                ...(message ? { message } : {}),
            });
        }
    }
}

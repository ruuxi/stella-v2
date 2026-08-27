import crypto from "crypto";
import fs from "fs";
import http, {} from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "@stella/contracts/convex-urls";
import { isMobileBridgeEventChannel, isMobileBridgeRequestChannel, } from "./bridge-policy.js";
import { encodeBridgeBinaryValues } from "./binary-codec.js";
import { BRIDGE_CRYPTO_PROTOCOL, BRIDGE_FEATURE_DEFLATE, createBridgeKeyPair, createBridgeReplayGuard, decryptBridgeBytes, decryptBridgePayload, deriveBridgeCryptoSession, encryptBridgeBytes, encryptBridgePayload, isBridgeEncryptedEnvelope, } from "./crypto.js";
import { getHandler, getOnHandlers } from "./handler-registry.js";
import { guardMobileBridgeInvokeArgs } from "./invoke-guards.js";
import { adaptLegacyMobileArgs } from "./legacy-args.js";
import { probeBridgePublicHealth } from "./public-health.js";
import { resolveRendererRoot } from "../../renderer-location.js";
export const MOBILE_BRIDGE_REGISTRATION_REFRESH_MS = 5 * 60_000;
const REGISTER_DESKTOP_BRIDGE_MUTATION = anyApi.mobile_bridge.registerDesktopBridge;

const REGISTRATION_SYNC_DEBOUNCE_MS = 750;

const SESSION_TTL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 60_000;
const COOKIE_NAME = "stella_mobile_bridge";
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS = "Content-Type, X-Stella-Bridge-Session-Id, X-Stella-Bridge-Session-Secret, X-Stella-Bridge-Challenge-Id, X-Stella-Bridge-Encrypted, X-Stella-Bridge-Features, X-Stella-Bridge-Bin-Seq, X-Stella-Bridge-Bin-Iv, X-Stella-Bridge-Bin-Mime";

const BARE_CHALLENGE_LIMIT = 30;
const BARE_CHALLENGE_WINDOW_MS = 60_000;

const UPLOAD_TTL_MS = 10 * 60_000;
const UPLOAD_TOTAL_BYTE_CAP = 64 * 1024 * 1024;
const parseBridgeFeaturesHeader = (value) => {
    if (typeof value !== "string")
        return new Set();
    return new Set(value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean));
};
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const MOBILE_BRIDGE_SENDER_URL = "stella-mobile-bridge://mobile";
const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";

const BRIDGE_PUBLIC_HEALTH_TIMEOUT_MS = 2_000;

const BRIDGE_PUBLIC_HEALTH_FAILURE_THRESHOLD = 3;

const BRIDGE_PUBLIC_HEALTH_CACHE_MS = 3_000;
const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
};
const trimTrailingSlash = (value) => value.replace(/\/+$/, "");
const parseCookies = (cookieHeader) => Object.fromEntries((cookieHeader ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
    const [key, ...rest] = entry.split("=");
    return [key, rest.join("=")];
}));
const getDesktopPlatformLabel = () => {
    if (process.platform === "darwin") {
        return "Mac";
    }
    if (process.platform === "win32") {
        return "Windows";
    }
    return os.type();
};
const dispatchCapturedIpc = async (channel, args, broadcastToMobile, options) => {
    const handleHandler = getHandler(channel);
    const onHandlerList = !handleHandler ? getOnHandlers(channel) : undefined;
    if (!handleHandler && (!onHandlerList || onHandlerList.length === 0)) {
        throw new Error(`Unknown IPC channel: ${channel}`);
    }
    const fakeEvent = createFakeIpcEvent(broadcastToMobile);

    const spreadArgs = guardMobileBridgeInvokeArgs(channel, Array.isArray(args) ? args : [args]);
    if (handleHandler) {
        return {
            kind: "handle",
            result: await handleHandler(fakeEvent, ...spreadArgs),
        };
    }
    for (const handler of onHandlerList) {
        try {
            handler(fakeEvent, ...spreadArgs);
        }
        catch (error) {
            if (!options?.swallowEventHandlerErrors) {
                throw error;
            }
            console.warn(`[mobile-bridge] on-handler error for ${channel}:`, error instanceof Error ? error.message : String(error));
        }
    }
    return { kind: "event" };
};
const readBodyBuffer = (req) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("Body read timeout"));
                req.destroy();
            }
        }, BODY_TIMEOUT_MS);
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error("Body too large"));
                    req.destroy();
                }
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(Buffer.concat(chunks));
            }
        });
        req.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        });
    });
};
const readBody = (req) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error("Body read timeout"));
                req.destroy();
            }
        }, BODY_TIMEOUT_MS);
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error("Body too large"));
                    req.destroy();
                }
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(Buffer.concat(chunks).toString("utf-8"));
            }
        });
        req.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        });
    });
};
const getCorsHeaders = (origin) => origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
    }
    : {};
const sendJson = (res, status, data, origin) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json",
        ...getCorsHeaders(origin),
        ...NO_STORE_HEADERS,
    });
    res.end(body);
};
const sendNoContent = (res, origin) => {
    res.writeHead(204, {
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        ...getCorsHeaders(origin),
        ...NO_STORE_HEADERS,
    });
    res.end();
};

const createFakeIpcEvent = (broadcastFn) => {
    return {
        sender: {
            id: -1,
            send: (channel, ...args) => {
                broadcastFn(channel, args.length === 1 ? args[0] : args);
            },
            getURL: () => MOBILE_BRIDGE_SENDER_URL,
            isDestroyed: () => false,
        },
        senderFrame: { url: MOBILE_BRIDGE_SENDER_URL },
        processId: process.pid,
        frameId: 0,
        returnValue: undefined,
        reply: (channel, ...args) => {
            broadcastFn(channel, args.length === 1 ? args[0] : args);
        },
        ports: [],
    };
};
export class MobileBridgeService {
    options;
    bridgeKeyPair = createBridgeKeyPair();
    sessions = new Map();
    challenges = new Map();
    wsClients = new Map();
    server = null;
    wss = null;
    refreshTimer = null;
    registrationLeaseTimer = null;
    port = null;
    registrationLeaseExpiresAt = null;
    registrationState = "inactive";

    hasRegisteredBridge = false;
    deviceId = null;
    hostAuthToken = null;
    convexDeploymentUrl = null;
    convexSiteUrl = null;
    convexHttpClient = null;
    convexHttpClientUrl = null;
    convexHttpClientAuthToken = null;
    tunnelUrl = null;
    registerUnverifiedTunnelFallback = false;
    refreshUnverifiedTunnelRegistration = false;
    tunnelEverVerified = false;
    healthFailureStreak = 0;
    lastHealthyProbeAt = 0;
    syncInFlight = false;
    syncQueued = false;
    syncDebounceTimer = null;
    getBootstrapPayload = null;
    lastBootstrapPayload = null;
    bareChallengeWindowStart = 0;
    bareChallengeCount = 0;

    uploads = new Map();
    uploadTotalBytes = 0;
    constructor(options) {
        this.options = options;
    }

    setBootstrapPayloadGetter(getter) {
        this.getBootstrapPayload = getter;
    }
    markClientActivity() {
        this.options.onClientActivity?.();
    }

    setDeviceId(value) {
        const next = value?.trim() || null;
        if (next === this.deviceId)
            return;
        this.deviceId = next;
        this.scheduleRegistrationSync();
    }
    setHostAuthToken(value) {
        const previousToken = this.hostAuthToken;
        const nextToken = value?.trim() || null;
        if (nextToken === previousToken)
            return;
        this.hostAuthToken = nextToken;
        if (this.convexHttpClient) {
            if (nextToken) {
                this.convexHttpClient.setAuth(nextToken);
            }
            else {
                this.convexHttpClient.clearAuth();
            }
            this.convexHttpClientAuthToken = nextToken;
        }
        if (!this.hostAuthToken && previousToken) {
            this.invalidateBridgeAccess("Desktop signed out");
            void this.clearRegistrationWithToken(previousToken);
            return;
        }
        if (!previousToken || !this.hasRegisteredBridge) {
            this.scheduleRegistrationSync();
        }
    }
    setConvexDeploymentUrl(value) {
        const next = readConfiguredConvexUrl(value);
        if (next === this.convexDeploymentUrl)
            return;
        this.convexDeploymentUrl = next;
        this.convexHttpClient = null;
        this.convexHttpClientUrl = null;
        this.convexHttpClientAuthToken = null;
        this.scheduleRegistrationSync();
    }
    setConvexSiteUrl(value) {
        const next = value?.trim() || null;
        if (next === this.convexSiteUrl)
            return;
        this.convexSiteUrl = next;
        this.scheduleRegistrationSync();
    }
    setTunnelUrl(url, readiness) {
        const next = url?.trim() || null;
        const shouldRegisterUnverifiedFallback = next !== null && readiness === "fallback-unverified";
        if (next === this.tunnelUrl && readiness === undefined)
            return;
        if (next && next !== this.tunnelUrl) {

            this.healthFailureStreak = 0;
            this.lastHealthyProbeAt = 0;
            this.tunnelEverVerified = false;
            this.refreshUnverifiedTunnelRegistration = false;
        }
        if (next && readiness === "verified") {

            this.lastHealthyProbeAt = Date.now();
            this.tunnelEverVerified = true;
            this.refreshUnverifiedTunnelRegistration = false;
        }
        else if (shouldRegisterUnverifiedFallback) {
            this.refreshUnverifiedTunnelRegistration = true;
        }
        this.tunnelUrl = next;
        this.registerUnverifiedTunnelFallback = shouldRegisterUnverifiedFallback;
        this.scheduleRegistrationSync();
    }
    getPort() {
        return this.port;
    }
    getBridgeOrigin() {
        if (!this.tunnelUrl) {
            return null;
        }
        try {
            return new URL(trimTrailingSlash(this.tunnelUrl)).origin;
        }
        catch {
            return null;
        }
    }
    getRequestOrigin(req) {
        const origin = req.headers.origin;
        if (typeof origin !== "string") {
            return null;
        }
        const trimmed = origin.trim();
        if (!trimmed || trimmed === "null") {
            return null;
        }
        try {
            return new URL(trimmed).origin;
        }
        catch {
            return null;
        }
    }
    isAllowedRequestOrigin(origin) {
        if (!origin) {
            return true;
        }
        const bridgeOrigin = this.getBridgeOrigin();
        return Boolean(bridgeOrigin && origin === bridgeOrigin);
    }
    getValidSession(req) {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            if (session.expiresAt <= now) {
                this.sessions.delete(sessionId);
            }
        }
        const cookies = parseCookies(req.headers.cookie);
        const sessionId = cookies[COOKIE_NAME];
        if (!sessionId) {
            return null;
        }
        const session = this.sessions.get(sessionId);
        if (!session || session.expiresAt <= now) {
            return null;
        }
        return session;
    }
    pruneChallenges(now = Date.now()) {
        for (const [challengeId, challenge] of this.challenges) {
            if (challenge.expiresAt <= now) {
                this.challenges.delete(challengeId);
            }
        }
    }
    createBridgeChallenge() {
        const now = Date.now();
        this.pruneChallenges(now);
        const challengeId = crypto.randomUUID();
        const challenge = crypto.randomBytes(32).toString("base64url");
        const expiresAt = now + CHALLENGE_TTL_MS;
        this.challenges.set(challengeId, { challenge, expiresAt });
        return {
            challengeId,
            challenge,
            expiresAt,
            desktopDeviceId: this.deviceId,
            desktopPublicKey: this.bridgeKeyPair.publicKey,
            protocol: BRIDGE_CRYPTO_PROTOCOL,
        };
    }

    start() {
        if (this.server)
            return;
        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res).catch((error) => {
                console.warn("[mobile-bridge] request failed:", error);
                if (!res.headersSent) {
                    res.writeHead(500, {
                        "Content-Type": "text/plain; charset=utf-8",
                        ...NO_STORE_HEADERS,
                    });
                }
                res.end("Mobile bridge request failed.");
            });
        });
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on("connection", (ws, req) => {
            void this.handleWebSocket(ws, req);
        });
        this.server.listen(0, "127.0.0.1", () => {
            const address = this.server?.address();
            if (address && typeof address === "object") {
                this.port = address.port;
                console.log(`[mobile-bridge] Listening on port ${this.port}`);
                void this.syncRegistration();
            }
        });
        this.refreshTimer = setInterval(() => {
            void this.syncRegistration();
        }, MOBILE_BRIDGE_REGISTRATION_REFRESH_MS);
    }
    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.clearRegistrationSyncDebounce();
        this.clearRegistrationLeaseTimer();
        for (const [ws] of this.wsClients) {
            ws.close(1001, "Server shutting down");
        }
        this.wsClients.clear();
        this.wss?.close();
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.port = null;
        this.sessions.clear();
        this.challenges.clear();
        void this.clearRegistration();
    }

    broadcastToMobile = (channel, data) => {
        if (!isMobileBridgeEventChannel(channel)) {
            return;
        }
        if (channel === "display:update" &&
            !this.areDeveloperResourcePreviewsEnabled() &&
            this.isSourceDiffPayload(data)) {
            return;
        }
        if (!this.isBridgeAccessEnabled()) {
            return;
        }
        const encodedData = encodeBridgeBinaryValues(data);
        for (const [ws, client] of this.wsClients) {
            if (client.authenticated &&
                client.subscriptions.has(channel) &&
                ws.readyState === WebSocket.OPEN) {
                ws.send(this.serializeWsMessage(client, {
                    type: "event",
                    channel,
                    data: encodedData,
                }));
            }
        }
    };
    areDeveloperResourcePreviewsEnabled() {
        return (this.lastBootstrapPayload?.localStorage?.[DEVELOPER_RESOURCE_PREVIEWS_KEY] === "true");
    }
    isSourceDiffPayload(data) {
        return (Boolean(data) &&
            typeof data === "object" &&
            data.kind === "source-diff");
    }
    clearRegistrationLeaseTimer() {
        if (this.registrationLeaseTimer) {
            clearTimeout(this.registrationLeaseTimer);
            this.registrationLeaseTimer = null;
        }
    }
    closeBridgeClients(reason) {
        this.sessions.clear();
        this.challenges.clear();
        for (const [ws] of this.wsClients) {
            ws.close(4001, reason);
        }
        this.wsClients.clear();
    }
    setRegistrationLease(expiresAt) {
        this.clearRegistrationLeaseTimer();
        this.registrationLeaseExpiresAt = expiresAt;
        this.registrationLeaseTimer = setTimeout(() => {
            if (!this.hasActiveRegistrationLease()) {
                this.expireRegistrationPresence();
            }
        }, Math.max(0, expiresAt - Date.now()));
    }
    expireRegistrationPresence() {
        this.clearRegistrationLeaseTimer();
        this.registrationLeaseExpiresAt = null;
        this.registrationState = "expired";
    }
    invalidateBridgeAccess(reason) {
        this.clearRegistrationLeaseTimer();
        this.registrationLeaseExpiresAt = null;
        this.registrationState = "revoked";
        this.hasRegisteredBridge = false;
        this.closeBridgeClients(reason);
    }
    hasActiveRegistrationLease(nowMs = Date.now()) {
        return Boolean(typeof this.registrationLeaseExpiresAt === "number" &&
            this.registrationLeaseExpiresAt > nowMs);
    }
    isBridgeAccessEnabled() {
        return Boolean(this.hasRegisteredBridge &&
            this.hostAuthToken &&
            this.convexSiteUrl &&
            this.deviceId);
    }

    async handleRequest(req, res) {
        const requestOrigin = this.getRequestOrigin(req);
        if (!req.url) {
            sendJson(res, 400, { error: "Missing request URL." }, requestOrigin);
            return;
        }
        if (req.method === "OPTIONS") {
            if (!this.isAllowedRequestOrigin(requestOrigin)) {
                res.writeHead(403, { ...NO_STORE_HEADERS });
                res.end();
                return;
            }
            sendNoContent(res, requestOrigin);
            return;
        }
        if (!this.isAllowedRequestOrigin(requestOrigin)) {
            sendJson(res, 403, { error: "Forbidden" }, requestOrigin);
            return;
        }

        if (req.url === "/bridge/health" ||
            req.url === "/__stella_mobile_bridge/health") {
            sendJson(res, 200, { ok: true }, requestOrigin);
            return;
        }
        if (req.url.split("?")[0] === "/bridge/challenge") {
            if (!this.isBridgeAccessEnabled()) {
                sendJson(res, 403, { error: "Desktop bridge unavailable" }, requestOrigin);
                return;
            }

            const requestedDeviceId = new URL(req.url, "http://localhost").searchParams
                .get("d")
                ?.trim();
            if (requestedDeviceId) {
                if (!this.deviceId || requestedDeviceId !== this.deviceId) {
                    sendJson(res, 404, { error: "Not found" }, requestOrigin);
                    return;
                }
            }
            else if (!this.consumeBareChallengeBudget()) {
                sendJson(res, 429, { error: "Too many requests" }, requestOrigin);
                return;
            }
            sendJson(res, 200, this.createBridgeChallenge(), requestOrigin);
            return;
        }

        if (req.url === "/bridge/bootstrap") {
            const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
            if (!authenticated)
                return;
            await this.handleBootstrap(res, requestOrigin);
            return;
        }

        if (req.url.startsWith("/bridge/ipc/")) {
            const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
            if (!authenticated)
                return;
            await this.handleIpcRequest(req, res, requestOrigin, authenticated);
            return;
        }

        if (req.url === "/bridge/file" && req.method === "POST") {
            const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
            if (!authenticated)
                return;
            await this.handleBinaryFileRequest(req, res, requestOrigin, authenticated);
            return;
        }

        if (req.url === "/bridge/upload" && req.method === "POST") {
            const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
            if (!authenticated)
                return;
            await this.handleBinaryUploadRequest(req, res, requestOrigin, authenticated);
            return;
        }

        const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
        if (!authenticated)
            return;
        if (this.options.isDev) {
            await this.proxyToDevServer(req, res);
        }
        else {
            await this.serveStaticRenderer(req, res, requestOrigin);
        }
    }

    decryptBridgePayload(session, envelope) {
        if (!session.crypto || !isBridgeEncryptedEnvelope(envelope)) {
            throw new Error("Encrypted bridge session required");
        }
        return decryptBridgePayload(session.crypto, "m2d", envelope, this.getSessionReplayGuard(session));
    }
    getSessionReplayGuard(session) {
        if (!session.rxGuard) {
            session.rxGuard = createBridgeReplayGuard();
        }
        return session.rxGuard;
    }
    sessionSupportsDeflate(session) {
        return session.peerFeatures?.has(BRIDGE_FEATURE_DEFLATE) === true;
    }
    consumeBareChallengeBudget() {
        const now = Date.now();
        if (now - this.bareChallengeWindowStart >= BARE_CHALLENGE_WINDOW_MS) {
            this.bareChallengeWindowStart = now;
            this.bareChallengeCount = 0;
        }
        this.bareChallengeCount += 1;
        return this.bareChallengeCount <= BARE_CHALLENGE_LIMIT;
    }
    sendMaybeEncryptedJson(res, status, data, origin, session, encrypted) {
        if (!encrypted) {
            sendJson(res, status, data, origin);
            return;
        }
        if (!session.crypto) {
            sendJson(res, 403, { error: "Encrypted bridge session required" }, origin);
            return;
        }
        sendJson(res, status, {
            envelope: encryptBridgePayload(session.crypto, "d2m", data, {
                compress: this.sessionSupportsDeflate(session),
            }),
        }, origin);
    }

    async handleBinaryFileRequest(req, res, requestOrigin, session) {
        if (!session.crypto) {
            sendJson(res, 403, { error: "Encrypted bridge session required" }, requestOrigin);
            return;
        }
        try {
            const body = JSON.parse(await readBody(req));
            const decoded = this.decryptBridgePayload(session, body?.envelope);
            const dispatchResult = await dispatchCapturedIpc("display:readFile", [
                {
                    filePath: typeof decoded?.filePath === "string" ? decoded.filePath : "",
                    conversationId: typeof decoded?.conversationId === "string"
                        ? decoded.conversationId
                        : "",
                },
            ], this.broadcastToMobile);
            if (dispatchResult.kind !== "handle") {
                throw new Error("display:readFile did not return a result");
            }
            const result = dispatchResult.result;
            if (result?.missing === true || !(result?.bytes instanceof Uint8Array)) {
                this.sendMaybeEncryptedJson(res, 200, {
                    result: {
                        missing: true,
                        mimeType: result?.mimeType ?? "application/octet-stream",
                        path: result?.path ?? "",
                    },
                }, requestOrigin, session, true);
                return;
            }
            const frame = encryptBridgeBytes(session.crypto, "d2m", result.bytes);
            res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Content-Length": frame.ciphertext.byteLength,
                "X-Stella-Bridge-Bin": "1",
                "X-Stella-Bridge-Bin-Seq": String(frame.seq),
                "X-Stella-Bridge-Bin-Iv": frame.iv,
                "X-Stella-Bridge-Bin-Mime": result.mimeType ?? "application/octet-stream",
                "X-Stella-Bridge-Bin-Size": String(result.sizeBytes ?? result.bytes.byteLength),
                ...getCorsHeaders(requestOrigin),
                ...NO_STORE_HEADERS,
            });
            res.end(Buffer.from(frame.ciphertext));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Internal error";
            sendJson(res, 400, { error: message }, requestOrigin);
        }
    }

    async handleBinaryUploadRequest(req, res, requestOrigin, session) {
        if (!session.crypto) {
            sendJson(res, 403, { error: "Encrypted bridge session required" }, requestOrigin);
            return;
        }
        try {
            const seqHeader = req.headers["x-stella-bridge-bin-seq"];
            const ivHeader = req.headers["x-stella-bridge-bin-iv"];
            const mimeHeader = req.headers["x-stella-bridge-bin-mime"];
            const seq = typeof seqHeader === "string" ? Number(seqHeader) : NaN;
            const iv = typeof ivHeader === "string" ? ivHeader.trim() : "";
            const mimeType = typeof mimeHeader === "string" && mimeHeader.trim()
                ? mimeHeader.trim()
                : "application/octet-stream";
            if (!Number.isFinite(seq) || !iv) {
                sendJson(res, 400, { error: "Missing binary frame headers" }, requestOrigin);
                return;
            }
            const ciphertext = await readBodyBuffer(req);
            const bytes = decryptBridgeBytes(session.crypto, "m2d", { seq, iv, ciphertext: new Uint8Array(ciphertext) }, this.getSessionReplayGuard(session));
            this.pruneUploads();
            if (this.uploadTotalBytes + bytes.byteLength > UPLOAD_TOTAL_BYTE_CAP) {
                sendJson(res, 413, { error: "Upload staging full" }, requestOrigin);
                return;
            }
            const uploadId = crypto.randomUUID();
            this.uploads.set(uploadId, {
                dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
                mimeType,
                expiresAt: Date.now() + UPLOAD_TTL_MS,
                bytes: bytes.byteLength,
            });
            this.uploadTotalBytes += bytes.byteLength;
            this.sendMaybeEncryptedJson(res, 200, { result: { uploadId, sizeBytes: bytes.byteLength } }, requestOrigin, session, true);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Internal error";
            sendJson(res, 400, { error: message }, requestOrigin);
        }
    }
    pruneUploads(now = Date.now()) {
        for (const [id, upload] of this.uploads) {
            if (upload.expiresAt <= now) {
                this.uploads.delete(id);
                this.uploadTotalBytes -= upload.bytes;
            }
        }
        if (this.uploadTotalBytes < 0)
            this.uploadTotalBytes = 0;
    }

    resolveUploadedAttachments(channel, args) {
        if (channel !== "agent:startChat" || !Array.isArray(args))
            return args;
        const [first, ...rest] = args;
        if (!first || typeof first !== "object")
            return args;
        const record = first;
        if (!Array.isArray(record.attachments))
            return args;
        this.pruneUploads();
        const attachments = record.attachments.map((attachment) => {
            if (!attachment || typeof attachment !== "object")
                return attachment;
            const entry = attachment;
            const uploadId = typeof entry.uploadId === "string" ? entry.uploadId.trim() : "";
            if (!uploadId)
                return attachment;
            const upload = this.uploads.get(uploadId);
            if (!upload) {
                throw new Error("Attachment upload expired; please retry the send.");
            }

            return {
                url: upload.dataUrl,
                mimeType: typeof entry.mimeType === "string" && entry.mimeType.trim()
                    ? entry.mimeType
                    : upload.mimeType,
            };
        });
        return [{ ...record, attachments }, ...rest];
    }
    async handleIpcRequest(req, res, requestOrigin, session) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const channel = decodeURIComponent(url.pathname.slice("/bridge/ipc/".length));
        if (!isMobileBridgeRequestChannel(channel)) {
            sendJson(res, 403, { error: `Disallowed IPC channel: ${channel}` }, requestOrigin);
            return;
        }
        try {
            const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
            const encryptedRequest = isBridgeEncryptedEnvelope(body?.envelope);
            const decodedBody = encryptedRequest
                ? this.decryptBridgePayload(session, body.envelope)
                : body;
            const requestArgs = decodedBody.args ?? [];
            const dispatchResult = await dispatchCapturedIpc(channel, Array.isArray(requestArgs)
                ? adaptLegacyMobileArgs(channel, requestArgs)
                : requestArgs, this.broadcastToMobile, { swallowEventHandlerErrors: true });
            if (dispatchResult.kind === "handle") {
                const result = encodeBridgeBinaryValues(dispatchResult.result);
                this.sendMaybeEncryptedJson(res, 200, { result }, requestOrigin, session, encryptedRequest);
            }
            else {
                if (encryptedRequest) {
                    this.sendMaybeEncryptedJson(res, 200, { result: undefined }, requestOrigin, session, true);
                }
                else {
                    sendNoContent(res, requestOrigin);
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Internal error";
            if (message.startsWith("Unknown IPC channel:")) {
                sendJson(res, 404, { error: message }, requestOrigin);
            }
            else {
                console.error(`[mobile-bridge] IPC error on ${channel}: ${message}`);
                sendJson(res, 500, { error: message }, requestOrigin);
            }
        }
    }

    async handleBootstrap(res, requestOrigin) {
        if (!this.getBootstrapPayload) {
            sendJson(res, 200, { localStorage: {} }, requestOrigin);
            return;
        }
        try {
            const payload = await this.getBootstrapPayload();
            this.lastBootstrapPayload = payload;
            sendJson(res, 200, payload, requestOrigin);
        }
        catch (error) {
            console.warn("[mobile-bridge] Failed to read bootstrap payload:", error);
            this.lastBootstrapPayload = null;
            sendJson(res, 200, { localStorage: {} }, requestOrigin);
        }
    }

    async handleWebSocket(ws, req) {
        const requestOrigin = this.getRequestOrigin(req);
        if (!this.isAllowedRequestOrigin(requestOrigin)) {
            ws.close(1008, "Forbidden");
            return;
        }
        if (!this.isBridgeAccessEnabled()) {
            ws.close(4001, "Unauthorized");
            return;
        }
        const resolved = await this.resolveBridgeSession(req);
        if (!resolved) {
            ws.close(4001, "Unauthorized");
            return;
        }
        const session = resolved.session;
        const client = {
            subscriptions: new Set(),
            authenticated: true,
            session,
            encrypted: req.headers["x-stella-bridge-encrypted"] === BRIDGE_CRYPTO_PROTOCOL,
        };
        this.wsClients.set(ws, client);
        this.markClientActivity();
        console.log("[mobile-bridge] WebSocket connected");
        ws.on("message", (data) => {
            this.markClientActivity();
            if (!this.isBridgeAccessEnabled()) {
                ws.close(4001, "Desktop bridge unavailable");
                return;
            }
            try {
                const parsed = JSON.parse(data.toString());
                const msg = (isBridgeEncryptedEnvelope(parsed?.envelope)
                    ? this.decryptWsMessage(client, parsed.envelope)
                    : parsed);
                if (msg.type === "subscribe" && msg.channel) {
                    if (isMobileBridgeEventChannel(msg.channel) &&
                        !client.subscriptions.has(msg.channel)) {
                        client.subscriptions.add(msg.channel);
                    }
                }
                if (msg.type === "unsubscribe" && msg.channel) {
                    client.subscriptions.delete(msg.channel);
                }
                if (msg.type === "invoke" && msg.channel && msg.id) {
                    if (!isMobileBridgeRequestChannel(msg.channel)) {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(this.serializeWsMessage(client, {
                                type: "response",
                                id: msg.id,
                                error: `Disallowed IPC channel: ${msg.channel}`,
                            }));
                        }
                        return;
                    }
                    void this.handleWsInvoke(ws, client, msg.channel, msg.id, msg.args ?? []);
                }
            }
            catch {

            }
        });
        ws.on("close", () => {
            this.wsClients.delete(ws);
            console.log("[mobile-bridge] WebSocket disconnected");
        });
        ws.on("error", (error) => {
            console.warn("[mobile-bridge] WebSocket error:", error.message);
        });
    }
    decryptWsMessage(client, envelope) {
        if (!client.session.crypto || !isBridgeEncryptedEnvelope(envelope)) {
            throw new Error("Encrypted bridge session required");
        }
        client.encrypted = true;
        return decryptBridgePayload(client.session.crypto, "m2d", envelope, this.getSessionReplayGuard(client.session));
    }
    serializeWsMessage(client, payload) {
        if (!client.encrypted) {
            return JSON.stringify(payload);
        }
        if (!client.session.crypto) {
            throw new Error("Encrypted bridge session required");
        }
        return JSON.stringify({
            envelope: encryptBridgePayload(client.session.crypto, "d2m", payload, {
                compress: this.sessionSupportsDeflate(client.session),
            }),
        });
    }
    async handleWsInvoke(ws, client, channel, id, args) {
        try {
            const resolvedArgs = this.resolveUploadedAttachments(channel, args);
            const dispatchResult = await dispatchCapturedIpc(channel, Array.isArray(resolvedArgs)
                ? adaptLegacyMobileArgs(channel, resolvedArgs)
                : resolvedArgs, this.broadcastToMobile);
            if (dispatchResult.kind === "handle") {
                const result = encodeBridgeBinaryValues(dispatchResult.result);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(this.serializeWsMessage(client, { type: "response", id, result }));
                }
            }
            else {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(this.serializeWsMessage(client, {
                        type: "response",
                        id,
                        result: undefined,
                    }));
                }
            }
        }
        catch (error) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(this.serializeWsMessage(client, {
                    type: "response",
                    id,
                    error: error instanceof Error ? error.message : "Internal error",
                }));
            }
        }
    }

    hasExplicitSessionHeaders(req) {
        const id = req.headers["x-stella-bridge-session-id"];
        return typeof id === "string" && id.trim().length > 0;
    }

    async resolveBridgeSession(req) {
        const resolved = await (async () => {
            if (this.hasExplicitSessionHeaders(req)) {
                const session = await this.authorizeBridgeSession(req.headers);
                return session ? { session, fromHeaders: true } : null;
            }
            const cookieSession = this.getValidSession(req);
            return cookieSession
                ? { session: cookieSession, fromHeaders: false }
                : null;
        })();

        const featuresHeader = req.headers["x-stella-bridge-features"];
        if (resolved && typeof featuresHeader === "string") {
            resolved.session.peerFeatures = parseBridgeFeaturesHeader(featuresHeader);
        }
        return resolved;
    }
    async ensureAuthorized(req, res, requestOrigin) {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions) {
            if (session.expiresAt <= now)
                this.sessions.delete(sessionId);
        }
        if (!this.isBridgeAccessEnabled()) {
            sendJson(res, 403, { error: "Desktop bridge unavailable" }, requestOrigin);
            return null;
        }
        const resolved = await this.resolveBridgeSession(req);
        if (!resolved) {
            sendJson(res, 401, { error: "Unauthorized" }, requestOrigin);
            return null;
        }

        if (resolved.fromHeaders) {
            const sessionCookieId = crypto.randomUUID();
            this.sessions.set(sessionCookieId, resolved.session);
            res.setHeader("Set-Cookie", `${COOKIE_NAME}=${sessionCookieId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        }
        this.markClientActivity();
        return resolved.session;
    }
    async authorizeBridgeSession(requestHeaders) {
        const convexSiteUrl = this.convexSiteUrl;
        const deviceId = this.deviceId;
        const hostAuthToken = this.hostAuthToken;
        if (!convexSiteUrl || !deviceId || !hostAuthToken)
            return null;
        const sessionId = typeof requestHeaders["x-stella-bridge-session-id"] === "string"
            ? requestHeaders["x-stella-bridge-session-id"].trim()
            : "";
        const sessionSecret = typeof requestHeaders["x-stella-bridge-session-secret"] === "string"
            ? requestHeaders["x-stella-bridge-session-secret"].trim()
            : "";
        const challengeId = typeof requestHeaders["x-stella-bridge-challenge-id"] === "string"
            ? requestHeaders["x-stella-bridge-challenge-id"].trim()
            : "";
        if (!sessionId || !sessionSecret || !challengeId) {
            return null;
        }
        const existing = this.sessions.get(sessionId);
        if (existing?.crypto &&
            existing.expiresAt > Date.now() &&
            existing.sessionSecret === sessionSecret) {
            return existing;
        }
        this.pruneChallenges();
        const challenge = this.challenges.get(challengeId);
        if (!challenge) {
            return null;
        }
        try {
            const response = await this.postBridgeJson(convexSiteUrl, "/api/mobile/desktop-bridge/session/consume", `Bearer ${hostAuthToken}`, {
                deviceId,
                sessionId,
                sessionSecret,
                desktopChallenge: challenge.challenge,
            });
            if (!response.ok) {
                return null;
            }
            const body = (await response.json());
            if (body.desktopChallenge !== challenge.challenge ||
                body.desktopPublicKey !== this.bridgeKeyPair.publicKey ||
                typeof body.mobilePublicKey !== "string" ||
                typeof body.mobileDeviceId !== "string" ||
                typeof body.expiresAt !== "number") {
                return null;
            }
            const session = {
                expiresAt: Math.min(body.expiresAt, Date.now() + SESSION_TTL_MS),
                mobileDeviceId: body.mobileDeviceId,
                sessionSecret,
                crypto: deriveBridgeCryptoSession({
                    sessionId,
                    secretKey: this.bridgeKeyPair.secretKey,
                    peerPublicKey: body.mobilePublicKey,
                    mobilePublicKey: body.mobilePublicKey,
                    desktopPublicKey: this.bridgeKeyPair.publicKey,
                }),
            };
            this.challenges.delete(challengeId);
            this.sessions.set(sessionId, session);
            return session;
        }
        catch {
            return null;
        }
    }
    postBridgeJson(siteUrl, route, authorization, body, extraHeaders) {
        return fetch(`${trimTrailingSlash(siteUrl)}${route}`, {
            method: "POST",
            headers: {
                Authorization: authorization,
                "Content-Type": "application/json",
                ...extraHeaders,
            },
            body: JSON.stringify(body),
        });
    }
    getRegistrationConvexClient() {
        const deploymentUrl = readConfiguredConvexUrl(this.convexDeploymentUrl);
        const authToken = this.hostAuthToken?.trim() || null;
        if (!deploymentUrl || !authToken) {
            return null;
        }
        if (!this.convexHttpClient || this.convexHttpClientUrl !== deploymentUrl) {
            this.convexHttpClient = new ConvexHttpClient(deploymentUrl, {
                logger: false,
            });
            this.convexHttpClientUrl = deploymentUrl;
            this.convexHttpClientAuthToken = null;
        }
        if (this.convexHttpClientAuthToken !== authToken) {
            this.convexHttpClient.setAuth(authToken);
            this.convexHttpClientAuthToken = authToken;
        }
        return this.convexHttpClient;
    }
    registerDesktopBridge(args) {
        const client = this.getRegistrationConvexClient();
        if (!client) {
            throw new Error("Desktop bridge registration is missing Convex configuration or auth");
        }
        return client.mutation(REGISTER_DESKTOP_BRIDGE_MUTATION, args);
    }

    async proxyToDevServer(req, res) {
        const target = new URL(req.url ?? "/", `${trimTrailingSlash(this.options.getDevServerUrl())}/`);
        const method = req.method ?? "GET";
        const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (!value)
                continue;
            const lower = key.toLowerCase();
            if (lower === "host" ||
                lower === "connection" ||
                lower === "authorization" ||
                lower === "cookie" ||
                lower === "content-length") {
                continue;
            }
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        headers.set("accept-encoding", "identity");
        const upstream = await fetch(target, {
            method,
            headers,
            body: body ?? undefined,
            ...(body ? { duplex: "half" } : {}),
        });
        const responseHeaders = {};
        upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (lower === "content-length" ||
                lower === "set-cookie" ||
                lower === "content-encoding" ||
                lower === "connection") {
                return;
            }
            responseHeaders[key] = value;
        });
        res.writeHead(upstream.status, {
            ...responseHeaders,
            ...NO_STORE_HEADERS,
        });
        if (!upstream.body) {
            res.end();
            return;
        }
        await new Promise((resolve, reject) => {
            Readable.fromWeb(upstream.body).pipe(res);
            res.on("finish", resolve);
            res.on("error", reject);
        });
    }

    resolveStaticRendererRoot() {
        const candidates = [
            resolveRendererRoot(this.options.electronDir),
            path.resolve(this.options.electronDir, "../dist"),
        ];
        for (const candidate of candidates) {
            try {
                if (fs.statSync(path.join(candidate, "index.html")).isFile()) {
                    return candidate;
                }
            }
            catch {

            }
        }
        return null;
    }
    async serveStaticRenderer(req, res, requestOrigin) {
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const relativePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
        const distRoot = this.resolveStaticRendererRoot();
        if (!distRoot) {
            console.warn("[mobile-bridge] No built renderer assets found to serve.");
            sendJson(res, 503, { error: "Desktop renderer assets are unavailable." }, requestOrigin);
            return;
        }
        const isServableFile = (candidate) => {
            const relative = path.relative(distRoot, candidate);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
                return false;
            }
            try {
                return fs.statSync(candidate).isFile();
            }
            catch {
                return false;
            }
        };
        const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
        const targetPath = path.join(distRoot, safePath);
        const fallbackPath = path.join(distRoot, "index.html");
        const filePath = isServableFile(targetPath) ? targetPath : fallbackPath;
        if (!isServableFile(filePath)) {
            sendJson(res, 503, { error: "Desktop renderer assets are unavailable." }, requestOrigin);
            return;
        }
        const extension = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[extension] ?? "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": contentType,
            ...NO_STORE_HEADERS,
        });
        const stream = fs.createReadStream(filePath);

        stream.on("error", (error) => {
            console.warn(`[mobile-bridge] Failed to stream renderer asset ${filePath}:`, error instanceof Error ? error.message : String(error));
            res.destroy();
        });
        res.on("close", () => {
            stream.destroy();
        });
        stream.pipe(res);
    }

    scheduleRegistrationSync() {
        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
        }
        this.syncDebounceTimer = setTimeout(() => {
            this.syncDebounceTimer = null;
            void this.syncRegistration();
        }, REGISTRATION_SYNC_DEBOUNCE_MS);
    }
    clearRegistrationSyncDebounce() {
        if (this.syncDebounceTimer) {
            clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = null;
        }
    }
    async syncRegistration() {

        if (this.syncInFlight) {
            this.syncQueued = true;
            return;
        }
        this.syncInFlight = true;
        try {
            do {
                this.syncQueued = false;
                await this.performRegistrationSync();
            } while (this.syncQueued);
        }
        finally {
            this.syncInFlight = false;
        }
    }
    async performRegistrationSync() {
        if (!this.port ||
            !this.convexDeploymentUrl ||
            !this.convexSiteUrl ||
            !this.hostAuthToken ||
            !this.deviceId) {
            await this.clearRegistration();
            return;
        }
        if (!this.tunnelUrl) {
            await this.clearRegistration();
            return;
        }
        const baseUrls = [this.tunnelUrl];

        let healthy;
        const useUnverifiedFallback = this.registerUnverifiedTunnelFallback;
        if (useUnverifiedFallback) {

            healthy = false;
        }
        else if (Date.now() - this.lastHealthyProbeAt < BRIDGE_PUBLIC_HEALTH_CACHE_MS) {

            healthy = true;
        }
        else {
            healthy = await this.probePublicTunnelHealth(this.tunnelUrl);
            if (healthy) {
                this.lastHealthyProbeAt = Date.now();
                this.tunnelEverVerified = true;
                this.refreshUnverifiedTunnelRegistration = false;
            }
        }
        if (!healthy && !useUnverifiedFallback) {
            this.healthFailureStreak += 1;
            const streakExceeded = this.healthFailureStreak >= BRIDGE_PUBLIC_HEALTH_FAILURE_THRESHOLD;

            const everVerified = this.tunnelEverVerified;
            if (streakExceeded && everVerified && this.hasRegisteredBridge) {
                console.warn(`[mobile-bridge] Public tunnel failed ${this.healthFailureStreak} health checks; clearing availability`);
                await this.clearRegistration();
                return;
            }
            if (everVerified ||
                (!streakExceeded && !this.refreshUnverifiedTunnelRegistration)) {

                if (this.hasActiveRegistrationLease()) {
                    this.registrationState = "degraded";
                }
                return;
            }
            if (this.refreshUnverifiedTunnelRegistration) {

                console.warn("[mobile-bridge] Public tunnel remains unverified; refreshing degraded registration");
            }
            else {

                console.warn(`[mobile-bridge] Public tunnel unverified after ${this.healthFailureStreak} health checks; registering anyway (probe may be resolver-blinded)`);
            }
        }
        else if (!healthy) {
            console.warn("[mobile-bridge] Tunnel readiness fallback was unverified; registering immediately as degraded");
        }
        else {
            this.healthFailureStreak = 0;
        }
        try {
            const response = await this.registerDesktopBridge({
                deviceId: this.deviceId,
                baseUrls,
                platform: getDesktopPlatformLabel(),
                desktopPublicKey: this.bridgeKeyPair.publicKey,
            });
            const expiresAt = typeof response.leaseExpiresAt === "number" &&
                Number.isFinite(response.leaseExpiresAt) &&
                response.leaseExpiresAt > Date.now()
                ? response.leaseExpiresAt
                : typeof response.leaseDurationMs === "number" &&
                    Number.isFinite(response.leaseDurationMs) &&
                    response.leaseDurationMs > 0
                    ? Date.now() + response.leaseDurationMs
                    : null;
            if (expiresAt === null) {
                throw new Error("Registration response missing a valid lease expiry");
            }
            this.setRegistrationLease(expiresAt);
            this.hasRegisteredBridge = true;
            this.registerUnverifiedTunnelFallback = false;
            this.refreshUnverifiedTunnelRegistration = !healthy;

            this.registrationState = healthy ? "healthy" : "degraded";
        }
        catch (error) {
            const errorCode = error && typeof error === "object"
                ? (error.data?.code ?? error.code)
                : null;
            if (errorCode === "UNAUTHENTICATED" ||
                errorCode === "UNAUTHORIZED" ||
                errorCode === "FORBIDDEN") {
                this.invalidateBridgeAccess("Desktop bridge authorization expired");
                return;
            }
            if (this.hasActiveRegistrationLease()) {
                this.registrationState = "degraded";
            }
            else {
                this.expireRegistrationPresence();
            }
            console.warn("[mobile-bridge] registration failed:", error);
        }
    }
    probePublicTunnelHealth(url) {
        return probeBridgePublicHealth(url, BRIDGE_PUBLIC_HEALTH_TIMEOUT_MS);
    }
    async clearRegistration() {
        if (!this.hostAuthToken) {
            this.clearRegistrationLeaseTimer();
            this.registrationLeaseExpiresAt = null;
            this.registrationState = "inactive";
            this.hasRegisteredBridge = false;
            this.closeBridgeClients("Desktop bridge unavailable");
            return;
        }
        await this.clearRegistrationWithToken(this.hostAuthToken);
    }
    async clearRegistrationWithToken(token) {
        if (!this.convexSiteUrl ||
            !this.deviceId) {
            this.clearRegistrationLeaseTimer();
            this.registrationLeaseExpiresAt = null;
            this.registrationState = "inactive";
            this.hasRegisteredBridge = false;
            this.closeBridgeClients("Desktop bridge unavailable");
            return;
        }
        try {
            await this.postBridgeJson(this.convexSiteUrl, "/api/mobile/desktop-bridge/clear", `Bearer ${token}`, { deviceId: this.deviceId });
        }
        catch {

        }
        this.clearRegistrationLeaseTimer();
        this.registrationLeaseExpiresAt = null;
        this.registrationState = "inactive";
        this.hasRegisteredBridge = false;
        this.closeBridgeClients("Desktop bridge unavailable");
    }
}

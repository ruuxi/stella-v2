import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { watch as watchFs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { IPC_OFFICE_PREVIEW_UPDATE } from "@stella/contracts/desktop/ipc-channels";
import { broadcastToWindows } from "./context.js";
const PREVIEW_ROOT_DIRNAME = "office-previews";
const SESSION_MANIFEST_NAME = "session.json";
const SESSION_HTML_NAME = "preview.html";

const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const execFileAsync = promisify(execFile);
const isPreviewStatus = (value) => value === "starting" ||
    value === "ready" ||
    value === "error" ||
    value === "stopped";
const isPreviewFormat = (value) => value === "docx" || value === "xlsx" || value === "pptx" || value === null;
const asString = (value) => typeof value === "string" ? value : "";
const asNumber = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const resolvePreviewRoot = (stellaDataDir) => path.join(stellaDataDir, PREVIEW_ROOT_DIRNAME);
const readSnapshotFromSessionDir = async (sessionDir) => {
    try {
        const manifestPath = path.join(sessionDir, SESSION_MANIFEST_NAME);
        const manifestRaw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestRaw);
        const sessionId = asString(manifest.sessionId);
        const title = asString(manifest.title);
        const sourcePath = asString(manifest.sourcePath);
        if (!sessionId || !title || !sourcePath) {
            return null;
        }
        let html = "";
        try {
            html = await fs.readFile(path.join(sessionDir, SESSION_HTML_NAME), "utf-8");
        }
        catch {
            html = "";
        }
        return {
            sessionId,
            title,
            sourcePath,
            format: isPreviewFormat(manifest.format) ? manifest.format : null,
            startedAt: asNumber(manifest.startedAt, Date.now()),
            updatedAt: asNumber(manifest.updatedAt, Date.now()),
            status: isPreviewStatus(manifest.status) ? manifest.status : "starting",
            html,
            ...(typeof manifest.error === "string" && manifest.error.trim()
                ? { error: manifest.error }
                : {}),
        };
    }
    catch {
        return null;
    }
};
export const listOfficePreviewSnapshots = async (stellaDataDir) => {
    const previewRoot = resolvePreviewRoot(stellaDataDir);

    const entries = await fs
        .readdir(previewRoot, { withFileTypes: true })
        .catch((error) => {
        if (error?.code === "ENOENT")
            return null;
        throw error;
    });
    if (entries === null) {
        return [];
    }
    const snapshots = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSnapshotFromSessionDir(path.join(previewRoot, entry.name))));
    return snapshots
        .filter((snapshot) => snapshot !== null)
        .sort((left, right) => left.updatedAt - right.updatedAt);
};
const waitForProcessExit = async (pid, timeoutMs = 2_500) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        catch {
            return;
        }
    }
};
const stopPreviewProcess = async (pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return;
    }
    try {
        if (process.platform === "win32") {
            await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
                windowsHide: true,
            });
            return;
        }
        try {
            process.kill(-pid, "SIGTERM");
        }
        catch {
            process.kill(pid, "SIGTERM");
        }
        await waitForProcessExit(pid);
        try {
            process.kill(pid, 0);
        }
        catch {
            return;
        }
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch {
            process.kill(pid, "SIGKILL");
        }
    }
    catch {

    }
};
const findPreviewProcessIds = async (sessionId) => {
    if (!sessionId.trim()) {
        return [];
    }
    if (process.platform === "win32") {
        const escapedSessionId = sessionId.replace(/'/g, "''");
        const script = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            `$session = '${escapedSessionId}'`,
            "$currentPid = $PID",
            "$processes = Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%__run-preview-session%'\"",
            "$matches = @()",
            "foreach ($proc in $processes) {",
            "  $line = [string]$proc.CommandLine",
            "  if (-not $line -or [int]$proc.ProcessId -eq $currentPid) { continue }",
            "  if ($line.Contains('__run-preview-session') -and $line.Contains('--session') -and $line.Contains($session)) {",
            "    $matches += [int]$proc.ProcessId",
            "  }",
            "}",
            "$matches | ConvertTo-Json -Compress",
        ].join("; ");
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ], { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
            const raw = stdout.trim();
            if (!raw)
                return [];
            const parsed = JSON.parse(raw);
            const values = Array.isArray(parsed) ? parsed : [parsed];
            return values
                .map((value) => typeof value === "number"
                ? value
                : typeof value === "string"
                    ? Number.parseInt(value, 10)
                    : Number.NaN)
                .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
        }
        catch {
            return [];
        }
    }
    try {
        const { stdout } = await execFileAsync("pgrep", ["-f", `__run-preview-session.*--session ${sessionId}`], { windowsHide: true });
        return stdout
            .split(/\s+/)
            .map((value) => Number(value))
            .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    }
    catch {
        return [];
    }
};
export const stopOfficePreviewSessions = async (stellaDataDir) => {
    const snapshots = await listOfficePreviewSnapshots(stellaDataDir).catch(() => []);
    const activeSnapshots = snapshots.filter((snapshot) => snapshot.status === "starting" || snapshot.status === "ready");
    const pidGroups = await Promise.all(activeSnapshots.map((snapshot) => findPreviewProcessIds(snapshot.sessionId)));
    const pids = [...new Set(pidGroups.flat())];
    await Promise.allSettled(pids.map(stopPreviewProcess));
};
export const startOfficePreviewBridge = (context) => {
    const stellaDataDir = context.state.stellaDataDirPath;
    if (!stellaDataDir) {
        return () => { };
    }
    let stopped = false;
    let timer = null;

    let currentIntervalMs = 0;
    const lastDeliveredAt = new Map();
    const previewRoot = resolvePreviewRoot(stellaDataDir);
    let watcher = null;
    let watchKickTimer = null;

    void fs
        .mkdir(previewRoot, { recursive: true })
        .catch(() => undefined)
        .then(() => {
        if (!stopped)
            startWatcher();
    });

    const kickScanSoon = () => {
        if (stopped || watchKickTimer)
            return;
        watchKickTimer = setTimeout(() => {
            watchKickTimer = null;
            void scan();
        }, 50);
    };
    const startWatcher = () => {
        try {

            watcher = watchFs(previewRoot, { persistent: false }, () => {
                kickScanSoon();
            });
            watcher.on("error", () => {

                watcher?.close();
                watcher = null;
            });
        }
        catch {

        }
    };
    const arm = (intervalMs) => {
        if (stopped || intervalMs === currentIntervalMs) {
            return;
        }
        currentIntervalMs = intervalMs;
        if (timer) {
            clearInterval(timer);
        }
        timer = setInterval(() => {
            void scan();
        }, intervalMs);
    };
    const scan = async () => {
        try {
            const snapshots = await listOfficePreviewSnapshots(stellaDataDir);
            if (stopped) {
                return;
            }

            if (lastDeliveredAt.size > 0) {
                const present = new Set(snapshots.map((snapshot) => snapshot.sessionId));
                for (const sessionId of lastDeliveredAt.keys()) {
                    if (!present.has(sessionId)) {
                        lastDeliveredAt.delete(sessionId);
                    }
                }
            }
            for (const snapshot of snapshots) {
                const previousUpdatedAt = lastDeliveredAt.get(snapshot.sessionId) ?? -1;
                if (previousUpdatedAt >= snapshot.updatedAt) {
                    continue;
                }
                lastDeliveredAt.set(snapshot.sessionId, snapshot.updatedAt);
                broadcastToWindows(context, IPC_OFFICE_PREVIEW_UPDATE, snapshot);
            }

            arm(snapshots.length > 0 ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
        }
        catch (error) {
            console.debug("[office-preview] Failed to scan preview sessions:", error instanceof Error ? error.message : String(error));
        }
    };
    void scan();

    arm(IDLE_POLL_INTERVAL_MS);
    return () => {
        stopped = true;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (watchKickTimer) {
            clearTimeout(watchKickTimer);
            watchKickTimer = null;
        }
        if (watcher) {
            watcher.close();
            watcher = null;
        }
    };
};

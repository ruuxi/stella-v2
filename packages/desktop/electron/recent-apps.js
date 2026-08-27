import { execFile } from 'child_process';
import { app as electronApp } from 'electron';
import { runNativeHelper, runNativeHelperDetailed } from './native-helper.js';
import { requestRecentAppsDaemon } from './native-helper-daemon.js';

const HELPER_NAME = 'home_apps';

const RECENT_APPS_CACHE_MS = 2_500;
const WINDOWS_RECENT_APPS_CACHE_MS = 10_000;
const WINDOWS_NATIVE_HELPER_TIMEOUT_MS = 1_000;
const WINDOWS_NATIVE_SLOW_SUCCESS_THRESHOLD_MS = 750;
const WINDOWS_NATIVE_SLOW_SUCCESS_BACKOFF_MS = 60_000;
const recentAppsCache = new Map();
const recentAppsInFlight = new Map();

const NOISE_NAMES = new Set([

    'finder',
    'dock',
    'systemuiserver',
    'controlcenter',
    'control center',
    'notificationcenter',
    'notification center',
    'spotlight',
    'windowserver',
    'screen sharing',
    'wallpaper',
    'loginwindow',
    'coreservicesuiagent',
    'sidecar',
    'siri',
    'crashpad',

    'universalaccessauthwarn',
    'universal access auth',
    'tccd',
    'authorizationhost',
    'securityagent',
    'storedownloadd',
    'screenshot',

    'explorer',
    'searchhost',
    'searchapp',
    'startmenuexperiencehost',
    'shellexperiencehost',
    'lockapp',
    'applicationframehost',
    'runtimebroker',
    'textinputhost',
    'sihost',
    'ctfmon',
    'dwm',
    'fontdrvhost',
    'csrss',
    'wininit',
    'winlogon',
    'services',
    'smss',
    'lsass',
    'svchost',
    'taskhostw',
    'systemsettings',
    'gamebar',
    'gamebarpresencewriter',
    'msedgewebview2',
    'widgets',
]);

const NOISE_BUNDLE_ID_SUBSTRINGS = [
    'universalaccessauth',
    'tccd',
    'authorizationhost',
    'securityagent',
    'screensharing',
    'screencaptureui',
    'systemuiserver',
    'controlcenter',
    'notificationcenter',
    'spotlight',
    'windowserver',
    'loginwindow',
    'coreservicesuiagent',
];
const STELLA_BUNDLE_ID_PREFIXES = ['com.stella', 'ai.stella', 'org.stella'];
const STELLA_PROCESS_NAMES = new Set([
    'stella',
    'stella helper',
    'stella overlay',
]);
const STELLA_EXECUTABLE_PATH_NEEDLES = [
    '\\stella\\',
    '/stella/',
    '\\stella.app\\',
    '/stella.app/',
];
const STELLA_WINDOW_TITLE_PREFIXES = [
    'stella',
    'stella overlay',
];
const hasStellaExecutablePath = (executablePath) => {
    const exePath = executablePath?.toLowerCase().trim();
    if (!exePath)
        return false;
    const normalized = exePath.replaceAll('/', '\\');
    if (normalized.endsWith('\\stella.exe'))
        return true;
    if (normalized.endsWith('\\stella helper.exe'))
        return true;
    for (const needle of STELLA_EXECUTABLE_PATH_NEEDLES) {
        if (exePath.includes(needle))
            return true;
    }
    return false;
};
const isStellaApp = (rawName, bundleId, executablePath, windowTitle) => {
    const lowerBundle = bundleId?.toLowerCase();
    if (lowerBundle) {
        for (const prefix of STELLA_BUNDLE_ID_PREFIXES) {
            if (lowerBundle.startsWith(prefix))
                return true;
        }
    }
    const name = (rawName ?? '').toLowerCase().trim();
    if (STELLA_PROCESS_NAMES.has(name))
        return true;
    const hasStellaPath = hasStellaExecutablePath(executablePath);
    if (hasStellaPath)
        return true;
    const title = windowTitle?.toLowerCase().trim();
    if (title && (name === 'electron' || name.includes('stella') || hasStellaPath)) {
        for (const prefix of STELLA_WINDOW_TITLE_PREFIXES) {
            if (title === prefix ||
                title.startsWith(`${prefix} `) ||
                title.startsWith(`${prefix} -`) ||
                title.startsWith(`${prefix}:`))
                return true;
        }
    }
    return false;
};
const isNoiseName = (name) => NOISE_NAMES.has(name.toLowerCase().trim());
const isNoiseBundleId = (bundleId) => {
    if (!bundleId)
        return false;
    const lower = bundleId.toLowerCase();
    for (const needle of NOISE_BUNDLE_ID_SUBSTRINGS) {
        if (lower.includes(needle))
            return true;
    }
    return false;
};

const listRecentAppsMac = async (limit) => {

    const stdout = await runNativeHelper(HELPER_NAME, ['list'], {
        timeout: 8_000,
        maxBuffer: 4 * 1024 * 1024,
        onError: (error) => {
            console.warn('[home] home_apps list (mac) failed', error.message);
        },
    });
    if (!stdout)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch (error) {
        console.warn('[home] home_apps list (mac) parse failed', error);
        return null;
    }
    if (parsed.ok === false || !Array.isArray(parsed.apps)) {
        return null;
    }
    const cleaned = [];
    const seenPids = new Set();
    for (const raw of parsed.apps) {
        if (typeof raw.name !== 'string' || typeof raw.pid !== 'number')
            continue;
        if (isStellaApp(raw.name, raw.bundleId ?? null, null, raw.windowTitle ?? null))
            continue;
        if (isNoiseName(raw.name))
            continue;
        if (isNoiseBundleId(raw.bundleId ?? null))
            continue;
        if (seenPids.has(raw.pid))
            continue;
        seenPids.add(raw.pid);
        const windowTitle = typeof raw.windowTitle === 'string' ? raw.windowTitle.trim() : '';
        const iconDataUrl = typeof raw.iconDataUrl === 'string' &&
            raw.iconDataUrl.startsWith('data:image/')
            ? raw.iconDataUrl
            : undefined;
        cleaned.push({
            name: raw.name,
            bundleId: raw.bundleId ?? undefined,
            pid: raw.pid,
            isActive: Boolean(raw.isActive),
            windowTitle: windowTitle || undefined,
            iconDataUrl,
        });
    }
    return cleaned.slice(0, Math.max(0, limit));
};
const windowsIconCache = new Map();
let windowsRecentAppsNativeBackoffUntil = 0;
const execAsync = (command, args, timeoutMs) => new Promise((resolve) => {
    execFile(command, args, {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
    }, (error, stdout) => {
        if (error) {
            resolve(null);
            return;
        }
        resolve(typeof stdout === 'string' ? stdout : null);
    });
});
const cleanWindowsName = (name) => name.replace(/\.exe$/i, '').trim();
const resolveWindowsIconDataUrl = async (executablePath) => {
    const normalizedPath = typeof executablePath === 'string' ? executablePath.trim() : '';
    if (!normalizedPath)
        return undefined;
    if (!electronApp.isReady())
        return undefined;
    const cached = windowsIconCache.get(normalizedPath);
    if (cached !== undefined)
        return cached ?? undefined;
    try {
        const icon = await electronApp.getFileIcon(normalizedPath, { size: 'normal' });
        if (icon.isEmpty()) {
            windowsIconCache.set(normalizedPath, null);
            return undefined;
        }
        const resized = icon.resize({ width: 32, height: 32 });
        const dataUrl = resized.isEmpty() ? icon.toDataURL() : resized.toDataURL();
        const normalizedDataUrl = dataUrl.startsWith('data:image/')
            ? dataUrl
            : null;
        windowsIconCache.set(normalizedPath, normalizedDataUrl);
        return normalizedDataUrl ?? undefined;
    }
    catch {
        windowsIconCache.set(normalizedPath, null);
        return undefined;
    }
};
const listRecentAppsWindows = async (limit) => {
    if (limit <= 0)
        return [];

    const native = await listRecentAppsWindowsNative(limit);
    if (native !== null)
        return native;
    return listRecentAppsWindowsPowerShell(limit);
};
const parseWinProcessesJson = (stdout) => {
    try {
        const json = JSON.parse(stdout);
        return Array.isArray(json) ? json : [];
    }
    catch {
        return null;
    }
};
const listRecentAppsWindowsNative = async (limit) => {

    const daemonResponse = await requestRecentAppsDaemon([`--limit=${limit}`]);
    if (daemonResponse !== undefined) {
        const parsed = parseWinProcessesJson(daemonResponse);
        if (parsed)
            return buildRecentAppsFromWinProcesses(parsed, limit);

    }
    const now = Date.now();
    if (windowsRecentAppsNativeBackoffUntil > now) {
        return [];
    }
    const result = await runNativeHelperDetailed('recent_apps', [`--limit=${limit}`], {
        timeout: WINDOWS_NATIVE_HELPER_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        onError: () => {

        },
    });
    if (result.timedOut ||
        result.killed ||
        result.skippedReason === 'circuit-open' ||
        result.skippedReason === 'in-flight') {
        return [];
    }
    if (result.durationMs >= WINDOWS_NATIVE_SLOW_SUCCESS_THRESHOLD_MS) {
        windowsRecentAppsNativeBackoffUntil =
            Date.now() + WINDOWS_NATIVE_SLOW_SUCCESS_BACKOFF_MS;
    }
    const stdout = result.stdout;
    if (!stdout)
        return null;
    const parsed = parseWinProcessesJson(stdout);
    if (!parsed)
        return null;
    return buildRecentAppsFromWinProcesses(parsed, limit);
};
const listRecentAppsWindowsPowerShell = async (limit) => {

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Name 'StellaFW' -Namespace 'Win32' -MemberDefinition @'
[DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);
'@
$fgPid = 0
$null = [Win32.StellaFW]::GetWindowThreadProcessId([Win32.StellaFW]::GetForegroundWindow(), [ref]$fgPid)
$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object Id, ProcessName, MainWindowTitle, @{Name='IsActive';Expression={$_.Id -eq $fgPid}}, @{Name='ExecutablePath';Expression={try { $_.MainModule.FileName } catch { $null }}}
$procs | ConvertTo-Json -Compress
`.trim();
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const stdout = await execAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], 3_000);
    if (!stdout)
        return null;
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null')
        return null;
    let parsed;
    try {
        const json = JSON.parse(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`);
        parsed = Array.isArray(json) ? json : [];
    }
    catch (error) {
        console.warn('[home] list-apps (win) parse failed', error);
        return null;
    }
    return buildRecentAppsFromWinProcesses(parsed, limit);
};

const buildRecentAppsFromWinProcesses = async (parsed, limit) => {
    const seenPids = new Set();

    parsed.sort((a, b) => {
        if (a.IsActive !== b.IsActive) {
            return a.IsActive ? -1 : 1;
        }
        const aName = (a.ProcessName ?? '').toLowerCase();
        const bName = (b.ProcessName ?? '').toLowerCase();
        return aName.localeCompare(bName);
    });
    const kept = [];
    for (const raw of parsed) {
        const rawName = raw.ProcessName?.trim();
        const pid = typeof raw.Id === 'number' ? raw.Id : NaN;
        if (!rawName || !Number.isFinite(pid))
            continue;
        const windowTitle = raw.MainWindowTitle?.trim() ?? '';
        if (isStellaApp(rawName, null, raw.ExecutablePath ?? null, windowTitle))
            continue;
        if (isNoiseName(rawName))
            continue;
        if (seenPids.has(pid))
            continue;
        seenPids.add(pid);
        kept.push({ raw, name: rawName, pid, windowTitle });
        if (kept.length >= limit)
            break;
    }

    const iconPromisesByPath = new Map();
    const icons = await Promise.all(kept.map(({ raw }) => {
        const exePath = typeof raw.ExecutablePath === 'string' ? raw.ExecutablePath.trim() : '';
        if (!exePath)
            return Promise.resolve(undefined);
        let promise = iconPromisesByPath.get(exePath);
        if (!promise) {
            promise = resolveWindowsIconDataUrl(raw.ExecutablePath);
            iconPromisesByPath.set(exePath, promise);
        }
        return promise;
    }));
    return kept.map((entry, index) => ({
        name: cleanWindowsName(entry.name),
        pid: entry.pid,
        isActive: Boolean(entry.raw.IsActive),
        windowTitle: entry.windowTitle || undefined,
        iconDataUrl: icons[index],
    }));
};

export const listRecentApps = async (limit = 6) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    const cacheKey = `${process.platform}:${normalizedLimit}`;
    const now = Date.now();
    const cached = recentAppsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const inFlight = recentAppsInFlight.get(cacheKey);
    if (inFlight) {
        return await inFlight;
    }
    const promise = (async () => {
        if (process.platform === 'darwin')
            return await listRecentAppsMac(normalizedLimit);
        if (process.platform === 'win32')
            return await listRecentAppsWindows(normalizedLimit);
        return null;
    })();
    recentAppsInFlight.set(cacheKey, promise);
    try {
        const value = await promise;
        const cacheTtlMs = process.platform === 'win32'
            ? WINDOWS_RECENT_APPS_CACHE_MS
            : RECENT_APPS_CACHE_MS;
        recentAppsCache.set(cacheKey, {
            expiresAt: Date.now() + cacheTtlMs,
            value,
        });
        return value;
    }
    finally {
        recentAppsInFlight.delete(cacheKey);
    }
};

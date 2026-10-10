import { app, BrowserWindow, contentTracing, dialog, powerSaveBlocker, shell } from "electron";
import { spawn } from "node:child_process";
import { access, copyFile, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMainLogger } from "../observability/main-logger.js";
import { exportDesktopDebugLogs, getDesktopDebugPaths } from "../observability/desktop-debug-logging.js";
import { resolveLogPaths } from "@stella/runtime/observability/log-paths";
import { getLocalModelPreferences, getOnboardingCompleted, getPreventComputerSleep, getReadAloudEnabled, setReadAloudEnabled, getSoundNotificationsEnabled, loadLocalPreferences, normalizeImageGenerationPreferences, normalizeCodexServiceTier, normalizeRealtimeVoicePreferences, saveLocalPreferences, setOnboardingCompleted, updateLocalModelPreferences, } from "@stella/runtime/kernel/preferences/local-preferences";
import { coerceAgentRuntimeEngine } from "@stella/contracts/agent-engine";
import { listChatGptModels } from "@stella/contracts/chatgpt-siwc-flows";
import { hasRealtimeVoiceSessionRouteChanged, } from "@stella/contracts/local-preferences";
import { resetStellaCustomizations } from "@stella/runtime/kernel/home/reset-customizations";
import { ensureStellaDataDirSeeded } from "@stella/runtime/kernel/home/stella-home";
import { loadAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";
import { deletePromptPreset, isCustomizablePromptAgentId, listPromptPresets, readPromptPreset, savePromptPreset, } from "@stella/runtime/kernel/prompts/prompt-presets";
import { getPromptPresetSelection, setPromptPresetSelection, } from "@stella/runtime/kernel/preferences/local-preferences";
import { desktopPiChatEnabled } from "@stella/contracts/pi-chat";
import { getModels } from "@stella/runtime/kernel/model-catalog";
import { deleteLocalLlmCredential, getLocalLlmCredential, listLocalLlmCredentials, saveLocalLlmCredential, } from "@stella/runtime/kernel/storage/llm-credentials";
import { cleanupRetiredLocalLlmOAuthCredentials, deleteLocalLlmOAuthCredential, getLocalLlmOAuthApiKey, listLocalLlmOAuthCredentials, saveLocalLlmOAuthCredential, } from "@stella/runtime/kernel/storage/llm-oauth-credentials";
import { getLlmOAuthProvider, getLlmOAuthProviders, loginLlmOAuth, } from "@stella/runtime/kernel/storage/llm-oauth-providers";
import { loginChatGpt } from "@stella/runtime/kernel/integrations/chatgpt-sign-in";
import { beginChatGptRegistration, chatGptProfileIdForClient, getChatGptAccessToken, getChatGptHostId, hasUsableChatGptProfile, listChatGptProfiles, removeChatGptProfile, saveChatGptRegistration, savedChatGptRegistration, setActiveChatGptProfile, signOutChatGptProfile, } from "@stella/runtime/kernel/storage/chatgpt-profiles";
import { isRuntimeUnavailableError } from "@stella/contracts/protocol/rpc-peer";
import { isCloudWorkspacePath } from "@stella/contracts/cloud-world-paths";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_GET_CHALLENGE_TOKEN,
  IPC_AUTH_APPLY_SESSION_TOKEN,
  IPC_AUTH_DELETE_USER,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_GET_TOKEN,
  IPC_AUTH_REVOKE_SESSIONS,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_DIAGNOSTICS_EXPORT_LOGS,
  IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
  IPC_DIAGNOSTICS_REPORT_ERROR,
  IPC_DIAGNOSTICS_REPORT_TIMING,
  IPC_DIAGNOSTICS_OPEN_LOGS,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_SYSTEM_OPEN_FDA,
  IPC_PERMISSIONS_GET_STATUS,
  IPC_PERMISSIONS_OPEN_SETTINGS,
  IPC_PERMISSIONS_REQUEST,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_CUSTOMIZATIONS_RESET,
  IPC_PROMPT_PRESETS_LIST,
  IPC_PROMPT_PRESETS_READ,
  IPC_PROMPT_PRESETS_SAVE,
  IPC_PROMPT_PRESETS_DELETE,
  IPC_PROMPT_PRESETS_SELECT,
  IPC_PREFERENCES_GET_MODELS,
  IPC_CHATGPT_LIST_MODELS,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_LIST_MODELS,
  IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_READ_ALOUD_CHANGED,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_VOICE_PREFERENCES_CHANGED,
  IPC_PI_CHAT_ENABLED_CHANGED,
  IPC_USER_ASK_ANSWER,
  IPC_USER_ASK_CANCEL,
  IPC_USER_ASK_LIST,
  IPC_USER_ASK_OVERRIDE_SENSITIVE,
  IPC_USER_ASK_POLICY_GET,
  IPC_USER_ASK_POLICY_SET,
  IPC_DEVICE_GET_ID,
  IPC_AUTH_SIGN_DEVICE,
  IPC_HOST_CONFIGURE_RUNTIME,
  IPC_HOST_SET_CLOUD_SYNC,
  IPC_APP_HARD_RESET,
  IPC_APP_RESET_MESSAGES,
  IPC_CONNECTOR_CREDENTIAL_SUBMIT,
  IPC_CONNECTOR_CREDENTIAL_CANCEL,
  IPC_CONNECTOR_CONNECT_RESPOND,
  IPC_SHELL_OPEN_EXTERNAL,
  IPC_SHELL_SHOW_IN_FOLDER,
  IPC_SHELL_KILL_BY_PORT,
  IPC_LLM_CREDENTIALS_LIST,
  IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS,
  IPC_LLM_CREDENTIALS_LIST_OAUTH,
  IPC_LLM_CREDENTIALS_LOGIN_OAUTH,
  IPC_CLAUDE_ACCOUNTS_LIST,
  IPC_CLAUDE_ACCOUNTS_START_LOGIN,
  IPC_CLAUDE_ACCOUNTS_WAIT_LOGIN,
  IPC_CLAUDE_ACCOUNTS_FINISH_LOGIN,
  IPC_CLAUDE_ACCOUNTS_CANCEL_LOGIN,
  IPC_CLAUDE_ACCOUNTS_SIGN_OUT,
  IPC_CHATGPT_PROFILES_CHANGED,
  IPC_CHATGPT_LIST_PROFILES,
  IPC_CHATGPT_SIGN_IN,
  IPC_CHATGPT_CANCEL_SIGN_IN,
  IPC_CHATGPT_SET_ACTIVE,
  IPC_CHATGPT_SIGN_OUT,
  IPC_CHATGPT_REMOVE,
  IPC_ENGINE_ACCOUNTS_CONNECT_CHATGPT_CLOUD,
  IPC_ENGINE_ACCOUNTS_CANCEL_CONNECT_CHATGPT_CLOUD,
  IPC_LLM_CREDENTIALS_CANCEL_OAUTH,
  IPC_LLM_CREDENTIALS_VALIDATE_OAUTH,
  IPC_LLM_CREDENTIALS_DELETE_OAUTH,
  IPC_LLM_CREDENTIALS_SAVE,
  IPC_LLM_CREDENTIALS_DELETE,
  IPC_SYSTEM_DETECT_TECHNICAL_USER_SIGNALS,
} from "@stella/contracts/desktop/ipc-channels";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { hasMacPermission, clearPermissionCache, getMicrophonePermissionStatus, requestMacPermission, resetMacMicrophonePermissions, resetMacPermission, } from "../utils/macos-permissions.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import { getGlobalShortcutsSuspended, setGlobalShortcutsSuspended, } from "./global-shortcuts.js";
import { createRequire } from "node:module";
import { t } from "../services/i18n-service.js";
import { isDelegatedDeviceSigningInput } from "@stella/contracts/gateway/dpop";
import {
  handleIpc,
  onIpc,
} from "./typed-ipc.js";
let _screenCapturePermissions;
const getScreenCapturePermissions = () => {
    if (_screenCapturePermissions !== undefined)
        return _screenCapturePermissions;
    try {
        const req = createRequire(import.meta.url);
        _screenCapturePermissions = req("mac-screen-capture-permissions");
    }
    catch {
        _screenCapturePermissions = null;
    }
    return _screenCapturePermissions;
};
const screenCapturePermissionsHasPrompted = (mod) => {
    if (!mod) {
        return false;
    }
    try {
        return mod.hasPromptedForPermission();
    }
    catch {
        return false;
    }
};
// System Settings corrupts its own view (it can render nearly blank, showing
// only General/Spotlight) when the x-apple.systempreferences: URL is opened
// repeatedly in quick succession. Coalesce rapid opens from every path (enable
// button spam, request + settings fallback, the openSettings handler) behind a
// single cooldown so one user click opens System Settings at most once.
const PERMISSION_SETTINGS_OPEN_COOLDOWN_MS = 1500;
let lastPermissionSettingsOpenAt = 0;
const consumePermissionSettingsOpenSlot = () => {
    const now = Date.now();
    if (now - lastPermissionSettingsOpenAt < PERMISSION_SETTINGS_OPEN_COOLDOWN_MS) {
        return false;
    }
    lastPermissionSettingsOpenAt = now;
    return true;
};
const openScreenCaptureSystemPreferences = async (mod) => {
    if (!mod) {
        return false;
    }
    if (!consumePermissionSettingsOpenSlot()) {
        return false;
    }
    try {
        await mod.openSystemPreferences();
        return true;
    }
    catch {
        return false;
    }
};
const permissionSettingsUrlByKind = {
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};
const openMacPermissionSettings = async (kind) => {
    const url = permissionSettingsUrlByKind[kind];
    if (!url) {
        return { opened: false, url: null };
    }
    if (!consumePermissionSettingsOpenSlot()) {
        return { opened: false, url };
    }
    await shell.openExternal(url);
    return { opened: true, url };
};
/**
 * Touch a few TCC-protected paths from the main process so macOS records the
 * Stella.app bundle as a Full Disk Access client. Until an app actually
 * *attempts* to read protected data, it never appears in
 * System Settings → Privacy & Security → Full Disk Access — so the user opens
 * the pane and Stella isn't in the list, forcing them to add it by hand. The
 * reads are expected to fail with EPERM when access hasn't been granted yet;
 * the TCC registration side-effect is what we're after, so all errors are
 * swallowed. Mirrors `registerStellaForScreenRecording` in macos-permissions.
 */
const registerStellaForFullDiskAccess = async () => {
    if (process.platform !== "darwin")
        return;
    const home = os.homedir();
    await Promise.allSettled([
        readFile(path.join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db")),
        readdir(path.join(home, "Library", "Safari")),
        readdir(path.join(home, "Library", "Containers", "com.apple.stocks")),
    ]);
};
const clampHeapTraceDurationMs = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 5_000;
    return Math.min(30_000, Math.max(1_000, Math.floor(parsed)));
};
const macAppPaths = (appName) => {
    const home = os.homedir();
    return [
        `/Applications/${appName}.app`,
        path.join(home, "Applications", `${appName}.app`),
    ];
};
const winAppPaths = (relPath) => {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
        path.join(localAppData, relPath),
        path.join(programFiles, relPath),
        path.join(programFilesX86, relPath),
    ];
};
const pathExists = async (candidate) => {
    try {
        await access(candidate);
        return true;
    }
    catch {
        return false;
    }
};
const anyExistsAsync = async (paths) => {
    if (paths.length === 0)
        return false;
    const results = await Promise.all(paths.map(pathExists));
    return results.some(Boolean);
};
/**
 * On Windows the simplistic `for (dir in PATH) for (ext in PATHEXT) existsSync(...)`
 * loop is the recurring source of slow onboarding. PATH typically has 30-50
 * entries and PATHEXT defaults to `.EXE;.CMD;.BAT`, so each binary lookup is
 * ~150-300 filesystem hits — and `existsSync` blocks the entire main process.
 *
 * We resolve each binary by running every candidate path through `fs.promises.access`
 * in parallel. NTFS is case-insensitive so the lowercase-vs-uppercase double
 * check the legacy code did is unnecessary; we use PATHEXT as-is.
 */
const findCliOnPathAsync = async (binName) => {
    const home = os.homedir();
    const wellKnown = binName === "claude"
        ? [
            path.join(home, ".claude", "local", "claude"),
            path.join(home, ".claude", "bin", "claude"),
        ]
        : binName === "codex"
            ? [
                path.join(home, ".codex", "bin", "codex"),
                path.join(home, ".cargo", "bin", "codex"),
            ]
            : binName === "opencode"
                ? [
                    path.join(home, ".opencode", "bin", "opencode"),
                    path.join(home, ".bun", "bin", "opencode"),
                ]
                : [];
    if (await anyExistsAsync(wellKnown))
        return true;
    const pathEnv = process.env.PATH ?? "";
    const sep = process.platform === "win32" ? ";" : ":";
    const exts = process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
        : [""];
    const candidates = [];
    for (const dir of pathEnv.split(sep)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            candidates.push(path.join(dir, `${binName}${ext}`));
        }
    }
    return await anyExistsAsync(candidates);
};
const detectTechnicalUserSignalsAsync = async () => {
    const home = os.homedir();
    const probes = [];
    if (process.platform === "darwin") {
        probes.push(anyExistsAsync(macAppPaths("Claude")).then((v) => v ? "claude-app" : null), anyExistsAsync(macAppPaths("ChatGPT")).then((v) => v ? "chatgpt-app" : null), anyExistsAsync(macAppPaths("Cursor")).then((v) => v ? "cursor-app" : null));
    }
    else if (process.platform === "win32") {
        probes.push(Promise.all([
            anyExistsAsync(winAppPaths("AnthropicClaude\\Claude.exe")),
            anyExistsAsync(winAppPaths("Programs\\Claude\\Claude.exe")),
        ]).then(([a, b]) => (a || b ? "claude-app" : null)), anyExistsAsync(winAppPaths("Programs\\OpenAI ChatGPT\\ChatGPT.exe")).then((v) => (v ? "chatgpt-app" : null)), anyExistsAsync(winAppPaths("Programs\\Cursor\\Cursor.exe")).then((v) => v ? "cursor-app" : null));
    }
    probes.push(findCliOnPathAsync("claude").then((v) => (v ? "claude-cli" : null)), findCliOnPathAsync("opencode").then((v) => (v ? "opencode-cli" : null)), Promise.all([
        pathExists(path.join(home, ".pi", "agent")),
        findCliOnPathAsync("pi"),
    ]).then(([a, b]) => (a || b ? "pi-cli" : null)));
    const results = await Promise.all(probes);
    const seen = new Set();
    for (const value of results) {
        if (value)
            seen.add(value);
    }
    return Array.from(seen);
};
let technicalUserSignalsPromise = null;
const detectTechnicalUserSignalsMemoized = () => {
    // Memoize for the lifetime of the Electron main process. The probe scans
    // ~hundreds of filesystem entries on Windows and the answer can't change
    // mid-session in any way the user cares about.
    if (!technicalUserSignalsPromise) {
        technicalUserSignalsPromise = detectTechnicalUserSignalsAsync().catch((error) => {
            // Reset the cache on failure so a later probe can retry.
            technicalUserSignalsPromise = null;
            throw error;
        });
    }
    return technicalUserSignalsPromise;
};
const asTrimmedString = (value) => typeof value === "string" ? value.trim() : "";
const sanitizeStringRecord = (value) => {
    const nextRecord = {};
    for (const [key, entryValue] of Object.entries(value && typeof value === "object"
        ? value
        : {})) {
        const trimmedKey = asTrimmedString(key);
        const trimmedValue = asTrimmedString(entryValue);
        if (!trimmedKey || !trimmedValue) {
            continue;
        }
        nextRecord[trimmedKey] = trimmedValue;
    }
    return nextRecord;
};
const sanitizeStringList = (value) => {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
        const trimmed = asTrimmedString(entry);
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};
const sanitizeReasoningEfforts = (value) => {
    const nextRecord = {};
    for (const [key, entryValue] of Object.entries(value && typeof value === "object"
        ? value
        : {})) {
        const trimmedKey = asTrimmedString(key);
        if (!trimmedKey)
            continue;
        if (entryValue === "minimal" ||
            entryValue === "low" ||
            entryValue === "medium" ||
            entryValue === "high" ||
            entryValue === "xhigh") {
            nextRecord[trimmedKey] = entryValue;
        }
    }
    return nextRecord;
};
const sanitizeReasoningEffort = (value) => {
    if (value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh") {
        return value;
    }
    return "default";
};
let preventSleepBlockerId = null;
export const setPreventComputerSleep = (enabled) => {
    if (enabled) {
        if (preventSleepBlockerId === null ||
            !powerSaveBlocker.isStarted(preventSleepBlockerId)) {
            preventSleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
        }
        return;
    }
    if (preventSleepBlockerId !== null) {
        if (powerSaveBlocker.isStarted(preventSleepBlockerId)) {
            powerSaveBlocker.stop(preventSleepBlockerId);
        }
        preventSleepBlockerId = null;
    }
};
const lockedComputerUseInstallerTimeoutMs = 120_000;
const resolveLockedComputerUseHome = (stellaAppDir) => {
    if (process.env.STELLA_DATA_DIR) {
        return path.resolve(process.env.STELLA_DATA_DIR);
    }
    if (stellaAppDir) {
        return path.resolve(stellaAppDir);
    }
    return path.join(os.homedir(), ".stella");
};
const readLockedComputerUseEnabled = (stellaAppDir) => {
    try {
        return loadLocalPreferences(resolveLockedComputerUseHome(stellaAppDir))
            .lockedComputerUseEnabled;
    }
    catch {
        return false;
    }
};
const writeLockedComputerUseEnabled = (stellaAppDir, enabled) => {
    const stellaDataDir = resolveLockedComputerUseHome(stellaAppDir);
    const prefs = loadLocalPreferences(stellaDataDir);
    saveLocalPreferences(stellaDataDir, {
        ...prefs,
        lockedComputerUseEnabled: enabled,
    });
};
const runProcessCapture = async (command, args, timeoutMs) => await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    const settle = (result) => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        resolve(result);
    };
    timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle({
            status: 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
            stderr: Buffer.concat(stderrChunks).toString("utf8").trim() ||
                `${command} timed out after ${timeoutMs}ms`,
            timedOut: true,
        });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", (error) => {
        settle({
            status: 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
            stderr: error.message,
            error,
        });
    });
    child.once("exit", (status) => {
        settle({
            status: status ?? 1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
            stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        });
    });
});
const lockedComputerUseInstallerPaths = () => {
    const installerPath = resolveNativeHelperPath("locked_use_installer");
    if (!installerPath) {
        throw new Error('Native helper "locked_use_installer" was not found. Build desktop/native first.');
    }
    return {
        installerPath,
        resourceDir: path.dirname(installerPath),
    };
};
const lockedComputerUseAuthorizerPath = (resourceDir) => {
    const helperPath = path.join(resourceDir, "Stella.app", "Contents", "MacOS", "Stella");
    if (!existsSync(helperPath)) {
        throw new Error('Native helper "Stella.app" was not found. Build desktop/native first.');
    }
    return helperPath;
};
const runLockedComputerUseInstaller = async (action, options = {}) => {
    const { installerPath, resourceDir } = lockedComputerUseInstallerPaths();
    if (options.admin &&
        process.platform === "darwin" &&
        typeof process.getuid === "function" &&
        process.getuid() !== 0) {
        return await runProcessCapture(lockedComputerUseAuthorizerPath(resourceDir), [action, resourceDir], lockedComputerUseInstallerTimeoutMs);
    }
    return await runProcessCapture(installerPath, [action, resourceDir], lockedComputerUseInstallerTimeoutMs);
};
const getLockedComputerUseStatus = async (stellaAppDir) => {
    if (process.platform !== "darwin") {
        return {
            ok: true,
            enabled: false,
            installed: false,
            active: false,
            locked: false,
            suppressedUntilManualUnlock: false,
            message: "Locked computer use is only available on macOS.",
            warnings: [],
        };
    }
    let installed = false;
    let message = "";
    try {
        const status = await runLockedComputerUseInstaller("status");
        message = [status.stdout, status.stderr].filter(Boolean).join("\n").trim();
        installed =
            /\binstalled\b/.test(message) && !/\bnot-installed\b/.test(message);
    }
    catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    return {
        ok: true,
        enabled: readLockedComputerUseEnabled(stellaAppDir),
        installed,
        active: false,
        locked: false,
        suppressedUntilManualUnlock: false,
        message: message || "Locked computer use status unavailable.",
        warnings: [],
    };
};
const sanitizeOptionalHttpUrl = (value, fieldName) => {
    const normalized = asTrimmedString(value);
    if (!normalized) {
        return undefined;
    }
    let parsed;
    try {
        parsed = new URL(normalized);
    }
    catch {
        throw new Error(`Invalid ${fieldName}.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Invalid ${fieldName}.`);
    }
    return parsed.toString();
};
export const registerSystemHandlers = (options) => {
    const activeOAuthLogins = new Map();
    const refreshLocalLlmCredentials = () => {
        options.getStellaHostRunner()?.refreshLocalLlmCredentials?.();
    };
    const stellaAppDir = options.getStellaAppDir();
    if (stellaAppDir) {
        cleanupRetiredLocalLlmOAuthCredentials(stellaAppDir);
    }
    handleIpc(IPC_DEVICE_GET_ID, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DEVICE_GET_ID)) {
            throw new Error("Blocked untrusted device:getId request.");
        }
        return options.getDeviceId() ?? await options.loadDeviceId();
    });
    handleIpc(IPC_AUTH_SIGN_DEVICE, async (event, input) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_SIGN_DEVICE)) {
            throw new Error("Blocked untrusted device-signing request.");
        }
        if (typeof input !== "string" || input.length === 0 || input.length > 64 * 1024) {
            throw new Error("Invalid device-signing input.");
        }
        // The device key also signs presence-socket proofs; a renderer may
        // only obtain DPoP-shaped signatures through this channel.
        if (!isDelegatedDeviceSigningInput(input)) {
            throw new Error("Blocked device-signing input outside the DPoP contract.");
        }
        const signer = await options.loadDeviceSigner();
        return {
            alg: signer.alg,
            rawPublicKey: Array.from(signer.rawPublicKey),
            signature: await signer.sign(input),
        };
    });
    handleIpc(IPC_APP_QUIT_FOR_RESTART, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_APP_QUIT_FOR_RESTART)) {
            throw new Error("Blocked untrusted app:quitForRestart request.");
        }
        setTimeout(() => {
            app.quit();
        }, 50);
        return { ok: true };
    });
    handleIpc(IPC_HOST_CONFIGURE_RUNTIME, (event, config) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_HOST_CONFIGURE_RUNTIME)) {
            throw new Error("Blocked untrusted host configuration request.");
        }
        const backendUrl = sanitizeOptionalHttpUrl(config?.backendUrl, "backendUrl");
        if (backendUrl) {
            options.authService.configurePiRuntime({ backendUrl });
        }
        return { deviceId: options.getDeviceId() };
    });
    handleIpc(IPC_AUTH_GET_SESSION, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_GET_SESSION)) {
            throw new Error("Blocked untrusted auth session request.");
        }
        return await options.authService.getAuthSessionSnapshot({
            allowCached: payload?.allowCached === true,
        });
    });
    handleIpc(IPC_AUTH_SIGN_IN_ANONYMOUS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_SIGN_IN_ANONYMOUS)) {
            throw new Error("Blocked untrusted anonymous sign-in request.");
        }
        return await options.authService.signInAnonymous();
    });
    handleIpc(IPC_AUTH_GET_CHALLENGE_TOKEN, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_GET_CHALLENGE_TOKEN)) {
            throw new Error("Blocked untrusted human-verification request.");
        }
        return await options.authService.getChallengeToken();
    });
    handleIpc(IPC_AUTH_SIGN_OUT, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_SIGN_OUT)) {
            throw new Error("Blocked untrusted sign-out request.");
        }
        return await options.authService.signOut();
    });
    handleIpc(IPC_AUTH_DELETE_USER, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_DELETE_USER)) {
            throw new Error("Blocked untrusted account deletion request.");
        }
        return await options.authService.deleteUser();
    });
    handleIpc(IPC_AUTH_APPLY_SESSION_TOKEN, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_APPLY_SESSION_TOKEN)) {
            throw new Error("Blocked untrusted session-token request.");
        }
        return await options.authService.applySessionToken(typeof payload?.sessionToken === "string" ? payload.sessionToken : "");
    });
    handleIpc(IPC_AUTH_GET_TOKEN, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_GET_TOKEN)) {
            throw new Error("Blocked untrusted auth token request.");
        }
        const result = await options.authService.getAuthTokenResult();
        return result.ok ? result.token : null;
    });
    handleIpc(IPC_AUTH_REVOKE_SESSIONS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_AUTH_REVOKE_SESSIONS)) {
            throw new Error("Blocked untrusted session revocation request.");
        }
        return await options.authService.revokeSessions();
    });
    handleIpc(IPC_HOST_SET_CLOUD_SYNC, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_HOST_SET_CLOUD_SYNC)) {
            throw new Error("Blocked untrusted host:setCloudSyncEnabled request.");
        }
        options
            .getStellaHostRunner()
            ?.setCloudSyncEnabled(Boolean(payload?.enabled));
        return { ok: true };
    });
    handleIpc(IPC_APP_HARD_RESET, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_APP_HARD_RESET)) {
            throw new Error("Blocked untrusted app:hardResetLocalState request.");
        }
        return options.hardResetLocalState();
    });
    handleIpc(IPC_APP_RESET_MESSAGES, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_APP_RESET_MESSAGES)) {
            throw new Error("Blocked untrusted app:resetLocalMessages request.");
        }
        return options.resetLocalMessages();
    });
    handleIpc(IPC_USER_ASK_LIST, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_LIST)) {
            throw new Error("Blocked untrusted ask list request.");
        }
        return options.listUserAsks();
    });
    handleIpc(IPC_USER_ASK_ANSWER, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_ANSWER)) {
            throw new Error("Blocked untrusted ask answer.");
        }
        return await options.answerUserAsk(payload);
    });
    handleIpc(IPC_USER_ASK_CANCEL, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_CANCEL)) {
            throw new Error("Blocked untrusted ask cancellation.");
        }
        return options.cancelUserAsk(payload);
    });
    handleIpc(IPC_USER_ASK_OVERRIDE_SENSITIVE, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_OVERRIDE_SENSITIVE)) {
            throw new Error("Blocked untrusted ask sensitivity override.");
        }
        return options.overrideUserAskSensitive(payload);
    });
    handleIpc(IPC_USER_ASK_POLICY_GET, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_POLICY_GET)) {
            throw new Error("Blocked untrusted ask policy request.");
        }
        return await options.getUserAskPolicy();
    });
    handleIpc(IPC_USER_ASK_POLICY_SET, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_USER_ASK_POLICY_SET)) {
            throw new Error("Blocked untrusted ask policy update.");
        }
        return await options.setUserAskPolicy(payload);
    });
    handleIpc(IPC_CONNECTOR_CREDENTIAL_SUBMIT, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_CONNECTOR_CREDENTIAL_SUBMIT)) {
            throw new Error("Blocked untrusted connector credential submission.");
        }
        return await options.submitConnectorCredential(payload);
    });
    handleIpc(IPC_CONNECTOR_CREDENTIAL_CANCEL, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_CONNECTOR_CREDENTIAL_CANCEL)) {
            throw new Error("Blocked untrusted connector credential cancellation.");
        }
        return options.cancelConnectorCredential(payload);
    });
    handleIpc(IPC_CONNECTOR_CONNECT_RESPOND, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_CONNECTOR_CONNECT_RESPOND)) {
            throw new Error("Blocked untrusted connector connect response.");
        }
        if (payload.action !== "accept" &&
            payload.action !== "decline" &&
            payload.action !== "cancel") {
            throw new Error("Invalid connector connect action.");
        }
        return options.respondConnectorConnect(payload);
    });
    onIpc(IPC_SHELL_OPEN_EXTERNAL, (event, url) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SHELL_OPEN_EXTERNAL)) {
            console.debug("[system] blocked untrusted shell:openExternal");
            return;
        }
        const safeUrl = options.externalLinkService.normalizeExternalHttpUrl(url);
        if (!safeUrl) {
            console.debug("[system] rejected invalid URL for shell:openExternal");
            return;
        }
        if (!options.externalLinkService.consumeExternalOpenBudget(event.sender.id)) {
            console.debug("[system] shell:openExternal rate limited");
            return;
        }
        void shell.openExternal(safeUrl);
    });
    onIpc(IPC_SHELL_SHOW_IN_FOLDER, (event, filePath) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SHELL_SHOW_IN_FOLDER)) {
            return;
        }
        if (typeof filePath === "string" && filePath.trim()) {
            const trimmed = filePath.trim();
            // A cloud-world path has nothing to reveal on this machine, and
            // Finder answers one by surfacing an unrelated window. This
            // channel is fire-and-forget, so the only honest reply is to do
            // nothing and say why in the log.
            if (isCloudWorkspacePath(trimmed)) {
                console.debug("[system] shell:showItemInFolder ignored a cloud workspace path");
                return;
            }
            shell.showItemInFolder(trimmed);
        }
    });
    onIpc(IPC_DIAGNOSTICS_REPORT_ERROR, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DIAGNOSTICS_REPORT_ERROR)) {
            return;
        }
        // Preserve the renderer's original message and stack. Calling crash()
        // here would replace it with a main-process wrapper stack.
        getMainLogger()?.error("renderer.error", {
            kind: payload?.kind,
            source: payload?.source,
            errorMessage: payload?.message,
            ...(payload?.stack ? { stack: payload.stack } : {}),
        });
    });
    onIpc(IPC_DIAGNOSTICS_REPORT_TIMING, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DIAGNOSTICS_REPORT_TIMING)) {
            return;
        }
        const phase = typeof payload?.phase === "string" ? payload.phase : "";
        const elapsedMs = Number(payload?.elapsedMs);
        const durationMs = payload?.durationMs === undefined ? undefined : Number(payload.durationMs);
        const outcome = payload?.outcome;
        if (!/^cloud\.[a-z0-9.-]{1,72}$/.test(phase) ||
            !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 600000 ||
            (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600000)) ||
            (outcome !== undefined && !["hit", "miss", "success", "unavailable"].includes(outcome))) {
            return;
        }
        getMainLogger()?.process("renderer.cloud_readiness", {
            phase,
            elapsedMs: Math.round(elapsedMs),
            ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
            ...(outcome === undefined ? {} : { outcome }),
        });
    });
    handleIpc(IPC_DIAGNOSTICS_OPEN_LOGS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DIAGNOSTICS_OPEN_LOGS)) {
            throw new Error("Blocked untrusted diagnostics:openLogs request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return { ok: false, error: "no-root" };
        const logDir = getDesktopDebugPaths()?.root ?? resolveLogPaths(stellaAppDir).logDir;
        const opened = await shell.openPath(logDir);
        // shell.openPath returns "" on success, or an error string.
        return opened
            ? { ok: false, error: opened, path: logDir }
            : { ok: true, path: logDir };
    });
    handleIpc(IPC_DIAGNOSTICS_EXPORT_LOGS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DIAGNOSTICS_EXPORT_LOGS)) {
            throw new Error("Blocked untrusted diagnostics:exportLogs request.");
        }
        try {
            const output = await exportDesktopDebugLogs();
            return { ok: true, path: output };
        }
        catch (error) {
            getMainLogger()?.error("diagnostics.export-failed", { error });
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    handleIpc(IPC_SHELL_SAVE_FILE_AS, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SHELL_SAVE_FILE_AS)) {
            return { ok: false, error: "Blocked untrusted request." };
        }
        const sourcePath = typeof payload?.sourcePath === "string"
            ? payload.sourcePath.trim()
            : "";
        if (!sourcePath) {
            return { ok: false, error: "Missing source file." };
        }
        try {
            const sourceStat = await stat(sourcePath);
            if (!sourceStat.isFile()) {
                return { ok: false, error: "Only files can be saved." };
            }
            const defaultName = typeof payload.defaultName === "string" && payload.defaultName.trim()
                ? path.basename(payload.defaultName.trim())
                : path.basename(sourcePath);
            const owner = BrowserWindow.fromWebContents(event.sender);
            const saveOptions = {
                defaultPath: defaultName,
            };
            const result = owner
                ? await dialog.showSaveDialog(owner, saveOptions)
                : await dialog.showSaveDialog(saveOptions);
            if (result.canceled || !result.filePath) {
                return { ok: false, canceled: true };
            }
            await copyFile(sourcePath, result.filePath);
            return { ok: true, path: result.filePath };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    onIpc(IPC_SYSTEM_OPEN_FDA, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SYSTEM_OPEN_FDA)) {
            return;
        }
        const approved = await options.ensurePrivilegedActionApproval("system.open_full_disk_access", "Allow Stella to open Full Disk Access settings?", "This opens macOS System Settings so Stella can be granted disk access for user-requested tasks.", event);
        if (!approved) {
            return;
        }
        if (process.platform === "darwin") {
            // Register the Stella.app bundle with TCC first so it shows up in the
            // Full Disk Access list, then open the pane for the user to toggle on.
            await registerStellaForFullDiskAccess();
            await openMacPermissionSettings("full-disk-access");
        }
    });
    handleIpc(IPC_SHELL_KILL_BY_PORT, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SHELL_KILL_BY_PORT)) {
            throw new Error("Blocked untrusted shell kill request.");
        }
        const port = Number(payload?.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("Invalid port.");
        }
        options.getStellaHostRunner()?.killShellsByPort(port);
    });
    handleIpc(IPC_PREFERENCES_GET_PREVENT_SLEEP, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_PREVENT_SLEEP)) {
            throw new Error("Blocked untrusted preferences:getPreventSleep request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return false;
        return getPreventComputerSleep(stellaAppDir);
    });
    handleIpc(IPC_PREFERENCES_SET_PREVENT_SLEEP, (event, enabled) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_PREVENT_SLEEP)) {
            throw new Error("Blocked untrusted preferences:setPreventSleep request.");
        }
        const nextEnabled = enabled === true;
        const stellaAppDir = options.getStellaAppDir();
        if (stellaAppDir) {
            const prefs = loadLocalPreferences(stellaAppDir);
            prefs.preventComputerSleep = nextEnabled;
            saveLocalPreferences(stellaAppDir, prefs);
        }
        setPreventComputerSleep(nextEnabled);
        return { enabled: nextEnabled };
    });
    handleIpc(IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE)) {
            throw new Error("Blocked untrusted preferences:getLockedComputerUse request.");
        }
        return await getLockedComputerUseStatus(options.getStellaAppDir());
    });
    handleIpc(IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE, async (event, enabled) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE)) {
            throw new Error("Blocked untrusted preferences:setLockedComputerUse request.");
        }
        if (process.platform !== "darwin") {
            throw new Error("Locked computer use is only available on macOS.");
        }
        const nextEnabled = enabled === true;
        const stellaAppDir = options.getStellaAppDir();
        const currentStatus = await getLockedComputerUseStatus(stellaAppDir);
        if (!nextEnabled) {
            writeLockedComputerUseEnabled(stellaAppDir, false);
            return {
                ...currentStatus,
                enabled: false,
            };
        }
        if (nextEnabled && currentStatus.installed) {
            writeLockedComputerUseEnabled(stellaAppDir, true);
            return {
                ...currentStatus,
                enabled: true,
            };
        }
        const installerResult = await runLockedComputerUseInstaller("install", {
            admin: true,
        });
        if (installerResult.status !== 0) {
            throw new Error(installerResult.stderr ||
                installerResult.stdout ||
                "Failed to enable locked computer use.");
        }
        const status = await getLockedComputerUseStatus(stellaAppDir);
        if (!status.installed) {
            throw new Error(installerResult.stderr ||
                installerResult.stdout ||
                "Locked computer use install did not complete.");
        }
        writeLockedComputerUseEnabled(stellaAppDir, nextEnabled);
        return {
            ...status,
            enabled: true,
            message: installerResult.stdout ||
                installerResult.stderr ||
                status.message ||
                "OK",
        };
    });
    handleIpc(IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS)) {
            throw new Error("Blocked untrusted preferences:getSoundNotifications request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return true;
        return getSoundNotificationsEnabled(stellaAppDir);
    });
    handleIpc(IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS, (event, enabled) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS)) {
            throw new Error("Blocked untrusted preferences:setSoundNotifications request.");
        }
        const nextEnabled = enabled === true;
        const stellaAppDir = options.getStellaAppDir();
        if (stellaAppDir) {
            const prefs = loadLocalPreferences(stellaAppDir);
            prefs.soundNotificationsEnabled = nextEnabled;
            saveLocalPreferences(stellaAppDir, prefs);
        }
        return { enabled: nextEnabled };
    });
    handleIpc(IPC_PREFERENCES_GET_READ_ALOUD, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_READ_ALOUD)) {
            throw new Error("Blocked untrusted preferences:getReadAloud request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return false;
        return getReadAloudEnabled(stellaAppDir);
    });
    handleIpc(IPC_PREFERENCES_GET_ONBOARDING_COMPLETED, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_ONBOARDING_COMPLETED)) {
            throw new Error("Blocked untrusted preferences:getOnboardingCompleted request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return false;
        return getOnboardingCompleted(stellaAppDir);
    });
    handleIpc(IPC_PREFERENCES_SET_ONBOARDING_COMPLETED, (event, completed) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_ONBOARDING_COMPLETED)) {
            throw new Error("Blocked untrusted preferences:setOnboardingCompleted request.");
        }
        const nextCompleted = completed === true;
        const stellaAppDir = options.getStellaAppDir();
        if (stellaAppDir) {
            setOnboardingCompleted(stellaAppDir, nextCompleted);
        }
        return { completed: nextCompleted };
    });
    handleIpc(IPC_PREFERENCES_SET_READ_ALOUD, (event, enabled) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_READ_ALOUD)) {
            throw new Error("Blocked untrusted preferences:setReadAloud request.");
        }
        const nextEnabled = enabled === true;
        const stellaAppDir = options.getStellaAppDir();
        if (stellaAppDir) {
            setReadAloudEnabled(stellaAppDir, nextEnabled);
        }
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_PREFERENCES_READ_ALOUD_CHANGED, nextEnabled);
            }
        }
        return { enabled: nextEnabled };
    });
    handleIpc(IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED)) {
            throw new Error("Blocked untrusted globalShortcuts:getSuspended request.");
        }
        return getGlobalShortcutsSuspended();
    });
    handleIpc(IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED, (event, suspended) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED)) {
            throw new Error("Blocked untrusted globalShortcuts:setSuspended request.");
        }
        return setGlobalShortcutsSuspended(suspended === true);
    });
    handleIpc(IPC_DIAGNOSTICS_RECORD_HEAP_TRACE, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_DIAGNOSTICS_RECORD_HEAP_TRACE)) {
            throw new Error("Blocked untrusted diagnostics:recordHeapTrace request.");
        }
        const durationMs = clampHeapTraceDurationMs(payload?.durationMs);
        try {
            await contentTracing.enableHeapProfiling?.();
            await contentTracing.startRecording({
                included_categories: ["disabled-by-default-memory-infra"],
                excluded_categories: ["*"],
                memory_dump_config: {
                    triggers: [{ mode: "detailed", periodic_interval_ms: 1000 }],
                },
            });
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            const tracePath = await contentTracing.stopRecording();
            return { ok: true, path: tracePath };
        }
        catch (error) {
            try {
                await contentTracing.stopRecording();
            }
            catch {
                // No active trace, or tracing already stopped.
            }
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    const promptPresetContext = (event, channel, agentId) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, channel)) {
            throw new Error(`Blocked untrusted ${channel} request.`);
        }
        if (!isCustomizablePromptAgentId(agentId)) {
            throw new Error("Unknown prompt agent.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            throw new Error("Stella data directory unavailable.");
        return stellaAppDir;
    };
    handleIpc(IPC_PROMPT_PRESETS_LIST, async (event, agentId) => {
        const dir = promptPresetContext(event, IPC_PROMPT_PRESETS_LIST, agentId);
        return {
            presets: await listPromptPresets(dir, agentId),
            selectedId: getPromptPresetSelection(dir, agentId),
        };
    });
    handleIpc(IPC_PROMPT_PRESETS_READ, async (event, agentId, presetId) => {
        const dir = promptPresetContext(event, IPC_PROMPT_PRESETS_READ, agentId);
        const id = String(presetId ?? "");
        // "default" reads the shipped prompt so the editor can seed a new
        // preset from what Stella actually ships.
        if (id === "default") {
            const content = (await loadAgentSystemPrompt(agentId)) ?? "";
            return { id: "default", name: "default", agentId, content };
        }
        return await readPromptPreset(dir, agentId, id);
    });
    handleIpc(IPC_PROMPT_PRESETS_SAVE, async (event, payload) => {
        const agentId = payload?.agentId;
        const dir = promptPresetContext(event, IPC_PROMPT_PRESETS_SAVE, agentId);
        const result = await savePromptPreset(dir, {
            agentId,
            id: typeof payload?.id === "string" && payload.id ? payload.id : undefined,
            name: String(payload?.name ?? ""),
            content: String(payload?.content ?? ""),
        });
        if (result.ok && payload?.select === true) {
            setPromptPresetSelection(dir, agentId, result.preset.id);
        }
        return result;
    });
    handleIpc(IPC_PROMPT_PRESETS_DELETE, async (event, agentId, presetId) => {
        const dir = promptPresetContext(event, IPC_PROMPT_PRESETS_DELETE, agentId);
        const id = String(presetId ?? "");
        const ok = await deletePromptPreset(dir, agentId, id);
        // A deleted selection reverts to the shipped prompt.
        if (ok && getPromptPresetSelection(dir, agentId) === id) {
            setPromptPresetSelection(dir, agentId, "default");
        }
        return { ok, selectedId: getPromptPresetSelection(dir, agentId) };
    });
    handleIpc(IPC_PROMPT_PRESETS_SELECT, async (event, agentId, presetId) => {
        const dir = promptPresetContext(event, IPC_PROMPT_PRESETS_SELECT, agentId);
        const id = String(presetId ?? "default");
        if (id !== "default" && !(await readPromptPreset(dir, agentId, id))) {
            return { ok: false, selectedId: getPromptPresetSelection(dir, agentId) };
        }
        setPromptPresetSelection(dir, agentId, id);
        return { ok: true, selectedId: getPromptPresetSelection(dir, agentId) };
    });
    handleIpc(IPC_CUSTOMIZATIONS_RESET, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_CUSTOMIZATIONS_RESET)) {
            throw new Error("Blocked untrusted customizations:reset request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return { ok: false, movedEntries: [], error: "Stella data directory unavailable." };
        try {
            const result = await resetStellaCustomizations(stellaAppDir);
            const stellaInstallDir = options.getStellaInstallDir?.();
            if (stellaInstallDir &&
                result.movedEntries.some((entry) => entry.startsWith(`skills${path.sep}`))) {
                await ensureStellaDataDirSeeded(stellaInstallDir, stellaAppDir);
            }
            return { ok: true, movedEntries: result.movedEntries, trashDir: result.trashDir };
        }
        catch (error) {
            return {
                ok: false,
                movedEntries: [],
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
    handleIpc(IPC_PREFERENCES_GET_MODELS, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_GET_MODELS)) {
            throw new Error("Blocked untrusted preferences:getLocalModelPreferences request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            return null;
        }
        return getLocalModelPreferences(stellaAppDir);
    });
    // The ChatGPT models this computer's active account may use
    // (`GET /v1/models`, `visibility: "list"`, in the server's order), or
    // Stella's catalog while no account is signed in here.
    handleIpc(IPC_CHATGPT_LIST_MODELS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_CHATGPT_LIST_MODELS)) {
            throw new Error("Blocked untrusted chatgpt:listModels request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        const catalog = () => ({
            source: "catalog",
            models: getModels("chatgpt").map((model) => ({ id: model.id, name: model.name })),
        });
        if (!stellaAppDir || !hasUsableChatGptProfile(stellaAppDir)) {
            return catalog();
        }
        const accessToken = await getChatGptAccessToken(stellaAppDir);
        if (!accessToken) {
            return catalog();
        }
        return { source: "account", models: await listChatGptModels(accessToken) };
    });
    handleIpc(IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS)) {
            throw new Error("Blocked untrusted preferences:listClaudeCodeModels request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        const apiKey = stellaAppDir
            ? getLocalLlmCredential(stellaAppDir, "anthropic")
            : null;
        // Loaded on first use: the Claude Code runtime pulls in the MCP SDK,
        // turndown/domino and the local tool dispatch graph, which otherwise
        // evaluate on every launch before the window opens.
        const { listClaudeCodeModels } = await import("@stella/runtime/kernel/integrations/claude-code-session-runtime");
        return listClaudeCodeModels({ apiKey }, stellaAppDir ?? undefined);
    });
    handleIpc(IPC_PREFERENCES_LIST_MODELS, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_LIST_MODELS)) {
            throw new Error("Blocked untrusted preferences:listModels request.");
        }
        // Do not let a renderer preload during runner attachment turn a
        // transient lifecycle gap into a successful, 24-hour cached empty
        // catalog. Await runner attachment instead so early renderer mounts
        // resolve once the deferred host-runner initialization completes.
        const runner = await waitForConnectedRunner(options.getStellaHostRunner, {
            timeoutMs: 10_000,
            unavailableMessage: "Stella runtime model catalog is not ready.",
            onRunnerChanged: options.onStellaHostRunnerChanged,
        });
        const forceRefresh = Boolean(payload) &&
            typeof payload === "object" &&
            payload.forceRefresh === true;
        return await runner.listModels({ forceRefresh });
    });
    handleIpc(IPC_PREFERENCES_SET_MODELS, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PREFERENCES_SET_MODELS)) {
            throw new Error("Blocked untrusted preferences:setLocalModelPreferences request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir)
            return null;
        const previousRealtimeVoice = payload?.realtimeVoice !== undefined
            ? getLocalModelPreferences(stellaAppDir).realtimeVoice
            : null;
        const previousPiChat = desktopPiChatEnabled(getLocalModelPreferences(stellaAppDir).agentRuntimeEngine);
        const nextDefaultModels = sanitizeStringRecord(payload?.defaultModels);
        const nextOverrides = sanitizeStringRecord(payload?.modelOverrides);
        const nextAssistantPropagatedAgents = sanitizeStringList(payload?.assistantPropagatedAgents);
        const nextReasoningEfforts = sanitizeReasoningEfforts(payload?.reasoningEfforts);
        const nextStellaConversationModelOverrides = sanitizeStringRecord(payload?.stellaConversationModelOverrides);
        const nextStellaConversationReasoningEfforts = sanitizeReasoningEfforts(payload?.stellaConversationReasoningEfforts);
        const agentRuntimeEngine = coerceAgentRuntimeEngine(payload?.agentRuntimeEngine);
        const parsedConcurrency = Number(payload?.maxAgentConcurrency);
        const maxAgentConcurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
            ? Math.min(24, Math.floor(parsedConcurrency))
            : 24;
        const patch = {};
        if (payload?.defaultModels !== undefined) {
            patch.defaultModels = nextDefaultModels;
        }
        if (payload?.modelOverrides !== undefined) {
            patch.modelOverrides = nextOverrides;
        }
        if (payload?.assistantPropagatedAgents !== undefined) {
            patch.assistantPropagatedAgents = nextAssistantPropagatedAgents;
        }
        if (payload?.reasoningEfforts !== undefined) {
            patch.reasoningEfforts = nextReasoningEfforts;
        }
        if (payload?.stellaConversationModelOverrides !== undefined) {
            patch.stellaConversationModelOverrides =
                nextStellaConversationModelOverrides;
        }
        if (payload?.stellaConversationReasoningEfforts !== undefined) {
            patch.stellaConversationReasoningEfforts =
                nextStellaConversationReasoningEfforts;
        }
        if (payload?.agentRuntimeEngine !== undefined) {
            patch.agentRuntimeEngine = agentRuntimeEngine;
        }
        if (payload?.codexModel !== undefined) {
            patch.codexModel =
                typeof payload.codexModel === "string"
                    ? payload.codexModel.trim()
                    : "";
        }
        if (payload?.codexModelExplicit !== undefined) {
            patch.codexModelExplicit = payload.codexModelExplicit === true;
        }
        if (payload?.codexReasoningEffort !== undefined) {
            patch.codexReasoningEffort = sanitizeReasoningEffort(payload.codexReasoningEffort);
        }
        if (payload?.codexServiceTier !== undefined) {
            patch.codexServiceTier = normalizeCodexServiceTier(payload.codexServiceTier);
        }
        if (payload?.claudeCodeModel !== undefined) {
            patch.claudeCodeModel =
                typeof payload.claudeCodeModel === "string"
                    ? payload.claudeCodeModel.trim()
                    : "";
        }
        if (payload?.claudeCodeReasoningEffort !== undefined) {
            patch.claudeCodeReasoningEffort = sanitizeReasoningEffort(payload.claudeCodeReasoningEffort);
        }
        if (payload?.useNativeClaudeCodeRuntime !== undefined) {
            patch.useNativeClaudeCodeRuntime =
                payload.useNativeClaudeCodeRuntime === true;
        }
        if (payload?.maxAgentConcurrency !== undefined) {
            patch.maxAgentConcurrency = maxAgentConcurrency;
        }
        if (payload?.imageGeneration !== undefined) {
            patch.imageGeneration = normalizeImageGenerationPreferences(payload.imageGeneration);
        }
        if (payload?.realtimeVoice !== undefined) {
            patch.realtimeVoice = normalizeRealtimeVoicePreferences(payload.realtimeVoice);
        }
        if (payload?.memoryEnabled !== undefined) {
            patch.memoryEnabled = payload.memoryEnabled === true;
        }
        const saved = updateLocalModelPreferences(stellaAppDir, patch);
        // Moving onto or off Claude Code moves the chat between its paths.
        const piChat = desktopPiChatEnabled(saved.agentRuntimeEngine);
        if (piChat !== previousPiChat) {
            for (const window of BrowserWindow.getAllWindows()) {
                if (window.isDestroyed() || window.webContents.isDestroyed())
                    continue;
                try {
                    window.webContents.send(IPC_PI_CHAT_ENABLED_CHANGED, piChat);
                }
                catch {
                    // Ignore renderer delivery failures while a window closes.
                }
            }
        }
        if (previousRealtimeVoice &&
            hasRealtimeVoiceSessionRouteChanged(previousRealtimeVoice, saved.realtimeVoice)) {
            for (const window of BrowserWindow.getAllWindows()) {
                if (window.isDestroyed() || window.webContents.isDestroyed())
                    continue;
                try {
                    window.webContents.send(IPC_VOICE_PREFERENCES_CHANGED, saved.realtimeVoice);
                }
                catch {
                    // Ignore renderer delivery failures while a window closes.
                }
            }
        }
        return saved;
    });
    handleIpc(IPC_LLM_CREDENTIALS_LIST, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_LIST)) {
            throw new Error("Blocked untrusted credential request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            return [];
        }
        return listLocalLlmCredentials(stellaAppDir);
    });
    handleIpc(IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS)) {
            throw new Error("Blocked untrusted OAuth provider request.");
        }
        // Claude (Claude Code's own login) and ChatGPT (Sign in with
        // ChatGPT) are not providers of this store.
        return getLlmOAuthProviders()
            .map((provider) => ({
            provider: provider.id,
            label: provider.name,
        }));
    });
    handleIpc(IPC_LLM_CREDENTIALS_LIST_OAUTH, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_LIST_OAUTH)) {
            throw new Error("Blocked untrusted OAuth credential request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            return [];
        }
        return listLocalLlmOAuthCredentials(stellaAppDir);
    });
    handleIpc(IPC_LLM_CREDENTIALS_LOGIN_OAUTH, async (event, payload) => {
        // Modifying this could break the app. Avoid exposing or logging OAuth
        // credentials, and confirm any request to weaken this boundary.
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_LOGIN_OAUTH)) {
            throw new Error("Blocked untrusted OAuth login request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            throw new Error("Local Stella root is unavailable.");
        }
        const providerId = asTrimmedString(payload?.provider).toLowerCase();
        const provider = getLlmOAuthProvider(providerId);
        if (!provider) {
            throw new Error("Unsupported OAuth provider.");
        }
        const loginKey = `${event.sender.id}:${providerId}`;
        activeOAuthLogins.get(loginKey)?.abort();
        const controller = new AbortController();
        activeOAuthLogins.set(loginKey, controller);
        const abortOnSenderDestroyed = () => controller.abort();
        event.sender.once("destroyed", abortOnSenderDestroyed);
        try {
            const credentials = await loginLlmOAuth(provider, {
                notify: (authEvent) => {
                    if (authEvent.type === "auth_url") {
                        void shell.openExternal(authEvent.url);
                    }
                    else if (authEvent.type === "device_code") {
                        void shell.openExternal(authEvent.verificationUri);
                        if (providerId !== "xai")
                            return;
                        void dialog.showMessageBox({
                            type: "info",
                            message: t("desktop.oauth.xaiCodeMessage"),
                            detail: authEvent.userCode,
                            buttons: [t("desktop.common.continue")],
                        });
                    }
                },
                // The only question these sign-ins ask is GitHub Enterprise's
                // domain; the empty answer signs in to github.com.
                prompt: async () => "",
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                throw controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error("OAuth login was canceled.");
            }
            const savedCredential = saveLocalLlmOAuthCredential(stellaAppDir, {
                provider: provider.id,
                label: provider.name,
                credentials,
            });
            refreshLocalLlmCredentials();
            return savedCredential;
        }
        finally {
            event.sender.removeListener("destroyed", abortOnSenderDestroyed);
            if (activeOAuthLogins.get(loginKey) === controller) {
                activeOAuthLogins.delete(loginKey);
            }
        }
    });
    // Claude Code logins on this computer. Main runs the real `claude` CLI
    // (`claude auth login` / `auth status` / `auth logout`) with the chosen
    // config dir; Stella never sees a Claude credential.
    const claudeAccounts = options.claudeLocalAccounts;
    const guardClaude = (event, channel) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, channel)) {
            throw new Error(`Blocked untrusted ${channel} request.`);
        }
    };
    handleIpc(IPC_CLAUDE_ACCOUNTS_LIST, async (event) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_LIST);
        return await claudeAccounts.list();
    });
    handleIpc(IPC_CLAUDE_ACCOUNTS_START_LOGIN, async (event, payload) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_START_LOGIN);
        const configId = asTrimmedString(payload?.configId);
        const email = asTrimmedString(payload?.email);
        const started = await claudeAccounts.startLogin({
            ...(configId ? { configId } : {}),
            ...(email ? { email } : {}),
        });
        // A window that goes away takes its waiting sign-in with it.
        event.sender.once("destroyed", () => claudeAccounts.cancelLogin(started.loginId));
        return started;
    });
    handleIpc(IPC_CLAUDE_ACCOUNTS_WAIT_LOGIN, async (event, payload) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_WAIT_LOGIN);
        return await claudeAccounts.waitLogin(asTrimmedString(payload?.loginId));
    });
    handleIpc(IPC_CLAUDE_ACCOUNTS_FINISH_LOGIN, async (event, payload) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_FINISH_LOGIN);
        return await claudeAccounts.finishLogin(asTrimmedString(payload?.loginId), typeof payload?.code === "string" ? payload.code : "");
    });
    handleIpc(IPC_CLAUDE_ACCOUNTS_CANCEL_LOGIN, (event, payload) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_CANCEL_LOGIN);
        return claudeAccounts.cancelLogin(asTrimmedString(payload?.loginId));
    });
    handleIpc(IPC_CLAUDE_ACCOUNTS_SIGN_OUT, async (event, payload) => {
        guardClaude(event, IPC_CLAUDE_ACCOUNTS_SIGN_OUT);
        return await claudeAccounts.signOut(asTrimmedString(payload?.configId));
    });
    // ChatGPT on this computer (Sign in with ChatGPT): this install is its
    // own agent host. Sign-in runs the loopback flow here in main; the
    // credentials stay in this computer's keychain-protected store.
    let activeChatGptSignIn = null;
    const chatGptAppDir = () => {
        const dir = options.getStellaAppDir();
        if (!dir) {
            throw new Error("Local Stella root is unavailable.");
        }
        return dir;
    };
    const chatGptProfilesChanged = () => {
        refreshLocalLlmCredentials();
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send(IPC_CHATGPT_PROFILES_CHANGED, {});
            }
        }
    };
    const guardChatGpt = (event, channel) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, channel)) {
            throw new Error(`Blocked untrusted ${channel} request.`);
        }
    };
    handleIpc(IPC_CHATGPT_LIST_PROFILES, (event) => {
        guardChatGpt(event, IPC_CHATGPT_LIST_PROFILES);
        const dir = options.getStellaAppDir();
        return dir ? listChatGptProfiles(dir) : { profiles: [] };
    });
    handleIpc(IPC_CHATGPT_SIGN_IN, async (event, payload) => {
        guardChatGpt(event, IPC_CHATGPT_SIGN_IN);
        const dir = chatGptAppDir();
        const sharedClientId = asTrimmedString(payload?.sharedClientId);
        // Reusing a registration another host of the owner made: sign in
        // with its issued client id under this install's own host id. When
        // this computer already has that registration, sign it in again in
        // place.
        const profileId = asTrimmedString(payload?.profileId) ||
            (sharedClientId ? chatGptProfileIdForClient(dir, sharedClientId) ?? "" : "");
        const shared = !profileId && sharedClientId
            ? { clientId: sharedClientId, email: options.engineAccountAccess.chatGptRegistration(sharedClientId)?.email }
            : null;
        activeChatGptSignIn?.abort();
        const controller = new AbortController();
        activeChatGptSignIn = controller;
        const abortOnSenderDestroyed = () => controller.abort();
        event.sender.once("destroyed", abortOnSenderDestroyed);
        try {
            const registration = await loginChatGpt({
                hostId: getChatGptHostId(dir),
                ...(profileId
                    ? { saved: savedChatGptRegistration(dir, profileId) }
                    : shared
                        ? { saved: { clientId: shared.clientId, ...(shared.email ? { email: shared.email } : {}) } }
                        : {}),
                reconsent: payload?.enablePlanUsage === true,
                openUrl: (url) => void shell.openExternal(url),
                onRegistration: (clientId) => {
                    beginChatGptRegistration(dir, clientId);
                    chatGptProfilesChanged();
                },
                signal: controller.signal,
            });
            const saved = saveChatGptRegistration(dir, registration);
            chatGptProfilesChanged();
            // Let the owner's other hosts reuse this registration (its
            // issued client id only, never tokens). Best effort.
            void options.engineAccountAccess.shareChatGptRegistration({
                clientId: registration.clientId,
                ...(registration.email ? { email: registration.email } : {}),
                ...(registration.name ? { name: registration.name } : {}),
            });
            return saved;
        }
        finally {
            event.sender.removeListener("destroyed", abortOnSenderDestroyed);
            if (activeChatGptSignIn === controller) {
                activeChatGptSignIn = null;
            }
        }
    });
    handleIpc(IPC_CHATGPT_CANCEL_SIGN_IN, (event) => {
        guardChatGpt(event, IPC_CHATGPT_CANCEL_SIGN_IN);
        const current = activeChatGptSignIn;
        current?.abort();
        return { canceled: Boolean(current) };
    });
    handleIpc(IPC_CHATGPT_SET_ACTIVE, (event, payload) => {
        guardChatGpt(event, IPC_CHATGPT_SET_ACTIVE);
        setActiveChatGptProfile(chatGptAppDir(), asTrimmedString(payload?.profileId));
        chatGptProfilesChanged();
        return { ok: true };
    });
    handleIpc(IPC_CHATGPT_SIGN_OUT, async (event, payload) => {
        guardChatGpt(event, IPC_CHATGPT_SIGN_OUT);
        const result = await signOutChatGptProfile(chatGptAppDir(), asTrimmedString(payload?.profileId));
        chatGptProfilesChanged();
        return result;
    });
    handleIpc(IPC_CHATGPT_REMOVE, async (event, payload) => {
        guardChatGpt(event, IPC_CHATGPT_REMOVE);
        const result = await removeChatGptProfile(chatGptAppDir(), asTrimmedString(payload?.profileId));
        chatGptProfilesChanged();
        return result;
    });
    // The owner's cloud is its own ChatGPT host: the server builds the
    // authorization and keeps the credentials; this computer only catches
    // the loopback redirect.
    handleIpc(IPC_ENGINE_ACCOUNTS_CONNECT_CHATGPT_CLOUD, async (event, payload) => {
        guardChatGpt(event, IPC_ENGINE_ACCOUNTS_CONNECT_CHATGPT_CLOUD);
        const engineAccounts = options.engineAccountAccess;
        const cancelOnSenderDestroyed = () => engineAccounts.cancelChatGptCloudConnect();
        event.sender.once("destroyed", cancelOnSenderDestroyed);
        try {
            const accountId = asTrimmedString(payload?.accountId);
            const clientId = asTrimmedString(payload?.clientId);
            return await engineAccounts.connectChatGptCloud((url) => void shell.openExternal(url), {
                ...(accountId ? { accountId } : {}),
                ...(clientId ? { clientId } : {}),
                ...(payload?.enablePlanUsage === true ? { enablePlanUsage: true } : {}),
            });
        }
        finally {
            event.sender.removeListener("destroyed", cancelOnSenderDestroyed);
        }
    });
    handleIpc(IPC_ENGINE_ACCOUNTS_CANCEL_CONNECT_CHATGPT_CLOUD, (event) => {
        guardChatGpt(event, IPC_ENGINE_ACCOUNTS_CANCEL_CONNECT_CHATGPT_CLOUD);
        return { canceled: options.engineAccountAccess.cancelChatGptCloudConnect() };
    });
    handleIpc(IPC_LLM_CREDENTIALS_CANCEL_OAUTH, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_CANCEL_OAUTH)) {
            throw new Error("Blocked untrusted OAuth cancel request.");
        }
        const providerId = asTrimmedString(payload?.provider).toLowerCase();
        const key = `${event.sender.id}:${providerId}`;
        const controller = activeOAuthLogins.get(key);
        controller?.abort();
        return { canceled: Boolean(controller) };
    });
    handleIpc(IPC_LLM_CREDENTIALS_VALIDATE_OAUTH, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_VALIDATE_OAUTH)) {
            throw new Error("Blocked untrusted OAuth validation request.");
        }
        const stellaAppDir = options.getStellaAppDir();
        const provider = asTrimmedString(payload?.provider).toLowerCase();
        if (!stellaAppDir || !provider) {
            return { connected: false, needsReauth: false };
        }
        if (!listLocalLlmOAuthCredentials(stellaAppDir).some((entry) => entry.provider === provider)) {
            return { connected: false, needsReauth: false };
        }
        const dropCredential = () => {
            deleteLocalLlmOAuthCredential(stellaAppDir, provider);
            refreshLocalLlmCredentials();
        };
        try {
            const key = await getLocalLlmOAuthApiKey(stellaAppDir, provider);
            if (key)
                return { connected: true, needsReauth: false };
            dropCredential();
            return { connected: false, needsReauth: true };
        }
        catch {
            dropCredential();
            return { connected: false, needsReauth: true };
        }
    });
    handleIpc(IPC_LLM_CREDENTIALS_DELETE_OAUTH, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_DELETE_OAUTH)) {
            throw new Error("Blocked untrusted OAuth credential delete.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            return { removed: false };
        }
        const result = deleteLocalLlmOAuthCredential(stellaAppDir, asTrimmedString(payload?.provider));
        if (result.removed) {
            refreshLocalLlmCredentials();
        }
        return result;
    });
    handleIpc(IPC_LLM_CREDENTIALS_SAVE, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_SAVE)) {
            throw new Error("Blocked untrusted credential write.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            throw new Error("Local Stella root is unavailable.");
        }
        const result = saveLocalLlmCredential(stellaAppDir, {
            provider: asTrimmedString(payload?.provider),
            label: asTrimmedString(payload?.label),
            plaintext: asTrimmedString(payload?.plaintext),
        });
        refreshLocalLlmCredentials();
        return result;
    });
    handleIpc(IPC_LLM_CREDENTIALS_DELETE, (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_LLM_CREDENTIALS_DELETE)) {
            throw new Error("Blocked untrusted credential delete.");
        }
        const stellaAppDir = options.getStellaAppDir();
        if (!stellaAppDir) {
            return { removed: false };
        }
        const result = deleteLocalLlmCredential(stellaAppDir, asTrimmedString(payload?.provider));
        if (result.removed) {
            refreshLocalLlmCredentials();
        }
        return result;
    });
    let lastAccessibilityStatus = false;
    handleIpc(IPC_PERMISSIONS_GET_STATUS, (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PERMISSIONS_GET_STATUS)) {
            throw new Error("Blocked untrusted permissions:getStatus request.");
        }
        const microphoneStatus = getMicrophonePermissionStatus();
        const microphoneGranted = microphoneStatus === "granted";
        if (process.platform !== "darwin") {
            return {
                accessibility: true,
                screen: true,
                microphone: microphoneGranted,
                microphoneStatus,
            };
        }
        const accessibility = hasMacPermission("accessibility", false);
        if (accessibility && !lastAccessibilityStatus) {
            options.onPermissionGranted?.("accessibility");
            try {
                options.ensureGlobalInputHooksOnMac?.();
            }
            catch {
                // Best-effort; hooks may still be starting.
            }
        }
        lastAccessibilityStatus = accessibility;
        return {
            accessibility,
            screen: hasMacPermission("screen", false),
            microphone: microphoneGranted,
            microphoneStatus,
        };
    });
    handleIpc(IPC_PERMISSIONS_RESET_MICROPHONE, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PERMISSIONS_RESET_MICROPHONE)) {
            throw new Error("Blocked untrusted permissions:resetMicrophone request.");
        }
        if (process.platform !== "darwin") {
            return { ok: false };
        }
        return { ok: await resetMacMicrophonePermissions() };
    });
    handleIpc(IPC_PERMISSIONS_RESET, async (event, payload) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PERMISSIONS_RESET)) {
            throw new Error("Blocked untrusted permissions:reset request.");
        }
        if (process.platform !== "darwin") {
            return { ok: false };
        }
        const kind = asTrimmedString(payload?.kind);
        if (!["accessibility", "screen", "microphone"].includes(kind)) {
            return { ok: false };
        }
        if (kind !== "accessibility") {
            const approved = await options.ensurePrivilegedActionApproval("permissions.reset", `Reset ${kind} permission for Stella?`, "Stella will need to ask for this permission again the next time you use a feature that requires it.", event);
            if (!approved) {
                return { ok: false };
            }
        }
        if (kind === "accessibility") {
            options.stopGlobalInputHooksForPermissionReset?.();
        }
        const ok = await resetMacPermission(kind);
        if (ok && kind === "accessibility") {
            setTimeout(() => {
                app.quit();
            }, 50);
        }
        return { ok };
    });
    handleIpc(IPC_PERMISSIONS_OPEN_SETTINGS, async (event, payload) => {
        const kind = asTrimmedString(payload?.kind);
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PERMISSIONS_OPEN_SETTINGS)) {
            throw new Error("Blocked untrusted permissions:openSettings request.");
        }
        if (kind === "microphone" && process.platform === "win32") {
            await shell.openExternal("ms-settings:privacy-microphone");
            return;
        }
        if (process.platform !== "darwin") {
            return;
        }
        await openMacPermissionSettings(kind);
    });
    handleIpc(IPC_PERMISSIONS_REQUEST, async (event, payload) => {
        const kind = asTrimmedString(payload?.kind);
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_PERMISSIONS_REQUEST)) {
            throw new Error("Blocked untrusted permissions:request request.");
        }
        if (kind === "microphone") {
            return { granted: true, alreadyGranted: true };
        }
        if (process.platform !== "darwin") {
            return { granted: true, alreadyGranted: true };
        }
        const macKind = kind;
        if (!["accessibility", "screen"].includes(macKind)) {
            return { granted: false, alreadyGranted: false };
        }
        clearPermissionCache();
        const result = await requestMacPermission(macKind);
        clearPermissionCache();
        let openedSettings = false;
        if (macKind === "screen" && !result.granted) {
            try {
                const scp = getScreenCapturePermissions();
                if (screenCapturePermissionsHasPrompted(scp)) {
                    const openedViaModule = await openScreenCaptureSystemPreferences(scp);
                    if (openedViaModule) {
                        openedSettings = true;
                    }
                    else {
                        const fallback = await openMacPermissionSettings("screen");
                        openedSettings = fallback.opened;
                    }
                }
                else {
                    const fallback = await openMacPermissionSettings("screen");
                    openedSettings = fallback.opened;
                }
            }
            catch {
                // Best effort only; the renderer can still expose manual settings access.
            }
        }
        if (result.granted && !result.alreadyGranted) {
            options.onPermissionGranted?.(macKind);
        }
        return { ...result, openedSettings };
    });
    handleIpc(IPC_SYSTEM_DETECT_TECHNICAL_USER_SIGNALS, async (event) => {
        if (!options.externalLinkService.assertPrivilegedSender(event, IPC_SYSTEM_DETECT_TECHNICAL_USER_SIGNALS)) {
            throw new Error("Blocked untrusted system:detectTechnicalUserSignals request.");
        }
        return { signals: await detectTechnicalUserSignalsMemoized() };
    });
};

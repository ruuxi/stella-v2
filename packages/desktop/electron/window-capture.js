import { nativeImage } from 'electron';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runNativeHelper } from './native-helper.js';
import { requestWindowInfoDaemon } from './native-helper-daemon.js';
import { hasMacPermission } from './utils/macos-permissions.js';
const WINDOW_INFO_HELPER = 'window_info';
export const STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES = ['Stella Overlay'];

const WINDOW_INFO_POINT_CACHE_MS = 200;

const WINDOW_INFO_POINT_CACHE_MAX = 256;
const windowInfoPointCache = new Map();
const windowInfoPointInFlight = new Map();
const windowInfoPointKey = (x, y, options) => `${Math.round(x)},${Math.round(y)}|${(options?.excludePids ?? []).join(',')}|${(options?.excludeTitlePrefixes ?? []).join(',')}`;
const excludePidsArg = (options) => options?.excludePids?.length
    ? `--exclude-pids=${options.excludePids.join(',')}`
    : null;
const excludeTitlePrefixesArg = (options) => options?.excludeTitlePrefixes?.length
    ? `--exclude-title-prefixes=${options.excludeTitlePrefixes.join(',')}`
    : null;
const exclusionArgs = (options) => [excludePidsArg(options), excludeTitlePrefixesArg(options)].filter((arg) => Boolean(arg));
const parseWindowInfoJson = (stdout) => {
    try {
        const info = JSON.parse(stdout);
        if (!info || typeof info !== 'object' || info.error)
            return null;
        return info;
    }
    catch {
        return null;
    }
};

const resolveWindowInfoAtPoint = async (x, y, options) => {
    const tokens = [String(x), String(y), ...exclusionArgs(options)];
    const daemonResponse = await requestWindowInfoDaemon(tokens);
    if (daemonResponse !== undefined) {
        return parseWindowInfoJson(daemonResponse);
    }
    return queryWindowInfo(x, y, options);
};
const queryWindowInfo = (x, y, options) => {
    return new Promise((resolve) => {
        const args = [String(x), String(y)];
        args.push(...exclusionArgs(options));
        void runNativeHelper(WINDOW_INFO_HELPER, args, {
            timeout: 3000,
            onError: (error) => {
                console.warn('window_info failed', error);
            },
        }).then((stdout) => {
            if (!stdout) {
                resolve(null);
                return;
            }
            try {
                const info = JSON.parse(stdout);
                if (info.error) {
                    resolve(null);
                    return;
                }
                resolve(info);
            }
            catch {
                resolve(null);
            }
        });
    });
};
export const getWindowInfoAtPoint = (x, y, options) => {
    const key = windowInfoPointKey(x, y, options);
    const now = Date.now();
    const cached = windowInfoPointCache.get(key);
    if (cached && cached.expiresAt > now) {
        return Promise.resolve(cached.value);
    }

    if (cached)
        windowInfoPointCache.delete(key);
    const inFlight = windowInfoPointInFlight.get(key);
    if (inFlight) {
        return inFlight;
    }
    const promise = resolveWindowInfoAtPoint(x, y, options);
    windowInfoPointInFlight.set(key, promise);
    return promise
        .then((value) => {
        windowInfoPointCache.set(key, {
            expiresAt: Date.now() + WINDOW_INFO_POINT_CACHE_MS,
            value,
        });

        if (windowInfoPointCache.size > WINDOW_INFO_POINT_CACHE_MAX) {
            const oldest = windowInfoPointCache.keys().next().value;
            if (oldest !== undefined)
                windowInfoPointCache.delete(oldest);
        }
        return value;
    })
        .finally(() => {
        windowInfoPointInFlight.delete(key);
    });
};
export const moveResizeWindowAtPoint = (x, y, options) => {
    return new Promise((resolve) => {
        const args = [String(x), String(y)];
        args.push(...exclusionArgs(options));
        const { bounds } = options;
        args.push(`--set-bounds=${[bounds.x, bounds.y, bounds.width, bounds.height]
            .map((value) => Math.round(value))
            .join(',')}`);
        void runNativeHelper(WINDOW_INFO_HELPER, args, {
            timeout: 3000,
            onError: (error) => {
                console.warn('window_info move failed', error);
            },
        }).then((stdout) => {
            if (!stdout) {
                resolve(null);
                return;
            }
            try {
                const info = JSON.parse(stdout);
                if (info.error) {
                    resolve(null);
                    return;
                }
                resolve({
                    windowInfo: info,
                    moved: info.moved === true,
                });
            }
            catch {
                resolve(null);
            }
        });
    });
};
const safeParseJson = (raw) => {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
};
const shotTokens = (x, y, options) => {
    const tokens = ['--shot', String(x), String(y)];
    tokens.push(...exclusionArgs(options));
    return tokens;
};
const buildWindowCaptureFromShot = (data) => {
    if (!data || data.error || !data.image || !data.bounds)
        return null;
    return {
        windowInfo: {
            title: typeof data.title === 'string' ? data.title : '',
            process: typeof data.process === 'string' ? data.process : '',
            pid: typeof data.pid === 'number' ? data.pid : 0,
            bounds: data.bounds,
            axTree: null,
        },
        screenshot: {
            dataUrl: data.image,
            width: typeof data.imageWidth === 'number'
                ? data.imageWidth
                : data.bounds.width,
            height: typeof data.imageHeight === 'number'
                ? data.imageHeight
                : data.bounds.height,
        },
        axTree: null,
    };
};

const runWindowShotWin32 = async (tokens) => {
    const daemonResponse = await requestWindowInfoDaemon(tokens);
    if (daemonResponse !== undefined) {
        const built = buildWindowCaptureFromShot(safeParseJson(daemonResponse));
        if (built)
            return built;
    }
    const stdout = await runNativeHelper(WINDOW_INFO_HELPER, tokens, {
        timeout: 5000,
        onError: () => { },
    });
    if (!stdout)
        return null;
    return buildWindowCaptureFromShot(safeParseJson(stdout));
};
const captureWindowScreenshotWin32 = (x, y, options) => runWindowShotWin32(shotTokens(x, y, options));

export const captureWindowScreenshot = async (x, y, options) => {
    if (!hasMacPermission('screen'))
        return null;
    if (process.platform === 'win32') {
        return captureWindowScreenshotWin32(x, y, options);
    }
    const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`);
    const args = [String(x), String(y), `--screenshot=${tempPath}`];
    args.push(...exclusionArgs(options));
    return runWindowCapture(WINDOW_INFO_HELPER, args, tempPath);
};

export const captureRegionScreenshotNative = async (x, y, width, height) => {
    if (process.platform !== 'win32')
        return null;
    if (width <= 0 || height <= 0)
        return null;
    const regionArg = `--region=${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`;
    const daemonResponse = await requestWindowInfoDaemon([regionArg]);
    let data = daemonResponse !== undefined ? safeParseJson(daemonResponse) : null;
    if (!data || !data.image) {
        const stdout = await runNativeHelper(WINDOW_INFO_HELPER, [regionArg], {
            timeout: 5000,
            onError: () => { },
        });
        data = stdout ? safeParseJson(stdout) : null;
    }
    if (!data || data.error || !data.image)
        return null;
    return {
        dataUrl: data.image,
        width: typeof data.imageWidth === 'number'
            ? data.imageWidth
            : Math.round(width),
        height: typeof data.imageHeight === 'number'
            ? data.imageHeight
            : Math.round(height),
    };
};
const HOME_CAPTURE_HELPER = 'home_capture';

export const captureWindowScreenshotByPid = async (pid, _options) => {
    if (!hasMacPermission('screen'))
        return null;
    if (!Number.isFinite(pid) || pid <= 0)
        return null;
    if (process.platform === 'win32') {
        return runWindowShotWin32(['--shot', `--pid=${Math.round(pid)}`]);
    }
    const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`);
    const args = [`--pid=${pid}`, `--screenshot=${tempPath}`];
    return runWindowCapture(HOME_CAPTURE_HELPER, args, tempPath);
};
const runWindowCapture = async (helperName, args, tempPath) => {
    try {
        const stdout = await runNativeHelper(helperName, args, { timeout: 5000 });
        if (!stdout)
            return null;
        const info = JSON.parse(stdout);
        if (info.error)
            return null;
        let pngBuffer;
        try {
            pngBuffer = await fs.readFile(tempPath);
        }
        catch {

            return null;
        }
        const image = nativeImage.createFromBuffer(pngBuffer);
        const size = image.getSize();
        const dataUrl = image.toDataURL();
        return {
            windowInfo: info,
            screenshot: { dataUrl, width: size.width, height: size.height },
            axTree: typeof info.axTree === 'string' && info.axTree.trim()
                ? info.axTree
                : null,
        };
    }
    catch {
        return null;
    }
    finally {
        fs.unlink(tempPath).catch(() => { });
    }
};

import { execFile } from 'child_process';
import { resolveNativeHelperPath } from './native-helper-path.js';
import { getFileLogger } from '@stella/runtime/observability/file-logger';

const FAILURE_LOG_THROTTLE_MS = 30_000;
const SLOW_HELPER_LOG_THRESHOLD_MS = 500;
const lastFailureLogAt = new Map();

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;
const circuits = new Map();

const WIN32_MAX_CONCURRENT_SPAWNS = 1;
let win32ActiveSpawns = 0;
const win32SpawnWaiters = [];
const acquireWin32SpawnSlot = () => {
    if (win32ActiveSpawns < WIN32_MAX_CONCURRENT_SPAWNS) {
        win32ActiveSpawns += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        win32SpawnWaiters.push(() => {
            win32ActiveSpawns += 1;
            resolve();
        });
    });
};
const releaseWin32SpawnSlot = () => {
    win32ActiveSpawns = Math.max(0, win32ActiveSpawns - 1);
    const next = win32SpawnWaiters.shift();
    if (next)
        next();
};
const getCircuit = (helperName) => {
    let circuit = circuits.get(helperName);
    if (!circuit) {
        circuit = { consecutiveFailures: 0, openUntil: 0 };
        circuits.set(helperName, circuit);
    }
    return circuit;
};
const openCircuit = (circuit, now) => {
    circuit.openUntil = Math.max(circuit.openUntil, now + CIRCUIT_COOLDOWN_MS);
};
const helperTimedOutOrKilled = (error) => {
    const typed = error;
    return (typed.killed === true ||
        typed.code === 'ETIMEDOUT' ||
        typed.signal === 'SIGTERM');
};
const circuitOpenResult = (circuit) => {
    const now = Date.now();
    return {
        stdout: null,
        skipped: true,
        skippedReason: 'circuit-open',
        error: null,
        killed: false,
        timedOut: false,
        durationMs: 0,
        circuitOpenMs: circuit.openUntil > now ? circuit.openUntil - now : 0,
    };
};
export const runNativeHelperDetailed = async (helperName, args, options) => {
    const helperPath = resolveNativeHelperPath(helperName);
    if (!helperPath) {
        return {
            stdout: null,
            skipped: true,
            skippedReason: 'missing',
            error: null,
            killed: false,
            timedOut: false,
            durationMs: 0,
            circuitOpenMs: 0,
        };
    }
    const circuit = getCircuit(helperName);
    if (circuit.openUntil > Date.now()) {

        return circuitOpenResult(circuit);
    }
    const useGovernor = process.platform === 'win32';
    if (useGovernor) {
        await acquireWin32SpawnSlot();
    }

    if (circuit.openUntil > Date.now()) {
        if (useGovernor)
            releaseWin32SpawnSlot();
        return circuitOpenResult(circuit);
    }
    try {
        return await new Promise((resolve) => {
            const startedAt = Date.now();
            execFile(helperPath, args, {
                timeout: options.timeout,
                encoding: options.encoding ?? 'utf8',
                maxBuffer: options.maxBuffer,
                windowsHide: true,
            }, (error, stdout) => {
                const now = Date.now();
                const durationMs = now - startedAt;
                if (error) {
                    const typedError = error;
                    const killed = typedError.killed === true;
                    const timedOut = helperTimedOutOrKilled(error);
                    circuit.consecutiveFailures += 1;
                    if (process.platform === 'win32' && timedOut) {
                        openCircuit(circuit, now);
                    }
                    else if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
                        circuit.openUntil <= now) {
                        openCircuit(circuit, now);
                    }
                    const last = lastFailureLogAt.get(helperName) ?? 0;
                    if (now - last >= FAILURE_LOG_THROTTLE_MS) {
                        lastFailureLogAt.set(helperName, now);
                        getFileLogger()?.warn('native.helper.failed', {
                            helper: helperName,
                            durationMs,
                            timeoutMs: options.timeout,
                            code: typedError.code,
                            killed,
                            timedOut,
                            consecutiveFailures: circuit.consecutiveFailures,
                            circuitOpenMs: circuit.openUntil > now ? circuit.openUntil - now : 0,
                            error,
                        });
                    }
                    options.onError?.(error);
                    resolve({
                        stdout: null,
                        skipped: false,
                        skippedReason: null,
                        error,
                        killed,
                        timedOut,
                        durationMs,
                        circuitOpenMs: circuit.openUntil > now ? circuit.openUntil - now : 0,
                    });
                    return;
                }
                circuit.consecutiveFailures = 0;
                circuit.openUntil = 0;
                if (durationMs >= SLOW_HELPER_LOG_THRESHOLD_MS) {
                    getFileLogger()?.process('native.helper.slow', {
                        helper: helperName,
                        durationMs,
                        timeoutMs: options.timeout,
                    });
                }
                resolve({
                    stdout: typeof stdout === 'string' ? stdout.trim() || null : null,
                    skipped: false,
                    skippedReason: null,
                    error: null,
                    killed: false,
                    timedOut: false,
                    durationMs,
                    circuitOpenMs: circuit.openUntil > now ? circuit.openUntil - now : 0,
                });
            });
        });
    }
    finally {
        if (useGovernor)
            releaseWin32SpawnSlot();
    }
};
export const runNativeHelper = async (helperName, args, options) => (await runNativeHelperDetailed(helperName, args, options)).stdout;

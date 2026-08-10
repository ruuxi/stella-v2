import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { downloadModelWithResume } from "./resumable-model-download.js";

/**
 * Local on-device dictation. Two engines back this depending on platform:
 *
 *  - "coreml"  — Apple Silicon. The Swift `parakeet_transcriber` helper runs
 *                parakeet-tdt-0.6b-v3 on the Neural Engine via FluidAudio/CoreML.
 *                Most power-efficient path; the CoreML model is auto-downloaded
 *                by FluidAudio into the helper's cache root.
 *  - "cpp"     — Windows + Intel macOS. The `parakeet_cpp_transcriber` helper
 *                (wraps parakeet.cpp / libparakeet) runs the same model on CPU
 *                from a GGUF we download + cache here. This closes the gap where
 *                those platforms previously had no local option and fell back to
 *                cloud STT.
 *
 * Both helpers speak the same newline-delimited JSON protocol, so everything
 * below the engine selection (the serve loop, request multiplexing, timeouts)
 * is shared.
 */

type Engine = "coreml" | "cpp";

const resolveEngine = (): Engine | null => {
  if (process.platform === "darwin" && process.arch === "arm64")
    return "coreml";
  if (process.platform === "win32" && process.arch === "x64") return "cpp";
  if (process.platform === "darwin" && process.arch === "x64") return "cpp";
  return null;
};

const COREML_MODEL_ID = "parakeet-tdt-0.6b-v3-coreml";
const COREML_HELPER_NAME = "parakeet_transcriber";

const CPP_MODEL_ID = "parakeet-tdt-0.6b-v3-gguf";
const CPP_HELPER_NAME = "parakeet_cpp_transcriber";
// q8_0 is near-lossless vs NeMo (WER 0) and matches the CoreML path's accuracy.
// Smaller quants exist (q4_k ≈ 643MB, q5_k ≈ 707MB) if download size becomes a
// concern; swapping is a one-line change to these three constants.
const CPP_MODEL_FILE = "tdt-0.6b-v3-q8_0.gguf";
const CPP_MODEL_URL =
  "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/tdt-0.6b-v3-q8_0.gguf";
const CPP_MODEL_SIZE = 940663680;
const CPP_MODEL_SHA256 =
  "4d69a4a6683f4f2d952bad794c1357ca6eb628027695b4699c5a9ad4cd07d757";

const MODEL_ID_BY_ENGINE: Record<Engine, string> = {
  coreml: COREML_MODEL_ID,
  cpp: CPP_MODEL_ID,
};
const HELPER_NAME_BY_ENGINE: Record<Engine, string> = {
  coreml: COREML_HELPER_NAME,
  cpp: CPP_HELPER_NAME,
};

const TRANSCRIBE_TIMEOUT_MS = 120_000;
const SERVICE_READY_TIMEOUT_MS = 120_000;
// CoreML's own downloader allows 30 minutes per large request. Installation is
// deliberately separate from service startup so the first-use 120 s readiness
// watchdog can never kill a multi-hundred-MB model download again.
const COREML_INSTALL_TIMEOUT_MS = 45 * 60_000;
// Perf: stop an idle serve process after this long with no transcription so an
// unused/warmed-but-untouched model doesn't stay resident. The next dictation
// re-warms transparently because startService/warmLocalParakeet are idempotent.
const IDLE_EVICTION_MS = 5 * 60_000;

type HelperResponse = {
  ok: boolean;
  model: string;
  transcript?: string;
  error?: string;
  id?: string;
};

export type LocalParakeetStatus = {
  available: boolean;
  model: string;
  reason?: string;
};

type PendingRequest = {
  resolve: (response: HelperResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let serviceProcess: ChildProcessWithoutNullStreams | null = null;
let serviceReady: Promise<void> | null = null;
let serviceBuffer = "";
let idleEvictionTimer: ReturnType<typeof setTimeout> | null = null;
const pendingRequests = new Map<string, PendingRequest>();
let coremlModelInstall: Promise<void> | null = null;
let coremlInstallProcess: ChildProcess | null = null;

// Perf: (re)arm the idle-eviction timer on each transcription. A serve process
// the user warmed but never (or no longer) dictates with is torn down after
// IDLE_EVICTION_MS so the model stops occupying memory; re-warming on the next
// dictation is transparent (startService is idempotent).
const armIdleEviction = () => {
  if (idleEvictionTimer) clearTimeout(idleEvictionTimer);
  idleEvictionTimer = setTimeout(() => {
    idleEvictionTimer = null;
    if (pendingRequests.size > 0) {
      // A transcription is mid-flight (e.g. timer fired during a slow run);
      // re-arm rather than killing the process out from under it.
      armIdleEviction();
      return;
    }
    stopService();
  }, IDLE_EVICTION_MS);
  // Don't let the eviction timer keep the event loop / process alive on its own.
  idleEvictionTimer.unref?.();
};

const clearIdleEviction = () => {
  if (idleEvictionTimer) {
    clearTimeout(idleEvictionTimer);
    idleEvictionTimer = null;
  }
};

const parseHelperResponse = (raw: string): HelperResponse | null => {
  if (!raw) return null;
  const lastLine = raw.split(/\r?\n/).at(-1);
  if (!lastLine) return null;
  try {
    return JSON.parse(lastLine) as HelperResponse;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// CoreML (Apple Silicon) model location — auto-downloaded by FluidAudio.
// ---------------------------------------------------------------------------

const modelDataRoot = (): string =>
  path.join(app.getPath("userData"), "models");

const coremlCacheRoot = (): string => path.join(modelDataRoot(), "parakeet");

// FluidAudio writes model files incrementally. A directory existing therefore
// does not mean a model is usable (an interrupted first run can leave only a
// few metadata files behind). Stella writes this marker only after the helper's
// `--download` path has downloaded and successfully loaded the complete model.
const coremlReadyMarkerPath = (): string =>
  path.join(coremlCacheRoot(), `.${COREML_MODEL_ID}.ready`);

const coremlModelIsReady = (): boolean => {
  try {
    return statSync(coremlReadyMarkerPath()).isFile();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// parakeet.cpp GGUF model — downloaded + cached under userData.
// ---------------------------------------------------------------------------

let cppModelDownload: Promise<string> | null = null;

const CPP_MODEL_DIR_NAME = "parakeet-cpp";

const hasCppModel = (dir: string): boolean => {
  try {
    return (
      path.isAbsolute(dir) &&
      statSync(path.join(dir, CPP_MODEL_FILE)).size === CPP_MODEL_SIZE
    );
  } catch {
    return false;
  }
};

const cppModelDir = (): string =>
  path.join(modelDataRoot(), CPP_MODEL_DIR_NAME);

const cppModelPath = (): string => path.join(cppModelDir(), CPP_MODEL_FILE);

const cppModelIsReady = (): string | null => {
  const dir = cppModelDir();
  return hasCppModel(dir) ? path.join(dir, CPP_MODEL_FILE) : null;
};

const downloadCppModel = async (): Promise<string> => {
  const target = cppModelPath();
  return await downloadModelWithResume({
    url: CPP_MODEL_URL,
    targetPath: target,
    expectedSize: CPP_MODEL_SIZE,
    expectedSha256: CPP_MODEL_SHA256,
  });
};

/**
 * Ensure the GGUF model is present, downloading once if needed. Concurrent
 * callers share a single in-flight download. Returns the resolved model path.
 */
const ensureCppModel = (): Promise<string> => {
  const ready = cppModelIsReady();
  if (ready) return Promise.resolve(ready);
  if (cppModelDownload) return cppModelDownload;
  cppModelDownload = downloadCppModel().finally(() => {
    cppModelDownload = null;
  });
  return cppModelDownload;
};

// ---------------------------------------------------------------------------
// Engine-specific spawn arguments.
// ---------------------------------------------------------------------------

const serveArgs = async (engine: Engine): Promise<string[]> => {
  if (engine === "coreml") {
    return ["--serve", "--cache-root", coremlCacheRoot()];
  }
  const modelPath = cppModelIsReady();
  if (!modelPath) {
    // Kick the download so a later attempt succeeds, but don't block the serve
    // start (and therefore the user's first dictation) on a multi-hundred-MB
    // fetch — the renderer falls back to cloud STT until the model lands.
    void ensureCppModel().catch(() => undefined);
    throw new Error("Local Parakeet model is still downloading.");
  }
  return ["--serve", "--model", modelPath];
};

// ---------------------------------------------------------------------------
// Shared helper invocation + serve loop.
// ---------------------------------------------------------------------------

const installCoremlModel = (): Promise<void> => {
  if (coremlModelIsReady()) return Promise.resolve();
  if (coremlModelInstall) return coremlModelInstall;

  const helperPath = resolveNativeHelperPath(COREML_HELPER_NAME);
  if (!helperPath) {
    return Promise.reject(
      new Error("Local Parakeet helper has not been built."),
    );
  }

  coremlModelInstall = new Promise<void>((resolve, reject) => {
    coremlInstallProcess = execFile(
      helperPath,
      ["--download", "--cache-root", coremlCacheRoot()],
      {
        timeout: COREML_INSTALL_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        coremlInstallProcess = null;
        const parsed = parseHelperResponse(stdout.trim());
        if (error || !parsed?.ok) {
          reject(
            new Error(
              parsed?.error ||
                error?.message ||
                "Local Parakeet model installation failed.",
            ),
          );
          return;
        }
        void mkdir(coremlCacheRoot(), { recursive: true })
          .then(() =>
            writeFile(
              coremlReadyMarkerPath(),
              `${JSON.stringify({ model: COREML_MODEL_ID, verifiedAt: Date.now() })}\n`,
              { mode: 0o600 },
            ),
          )
          .then(() => resolve(), reject);
      },
    );
  }).finally(() => {
    coremlModelInstall = null;
  });

  return coremlModelInstall;
};

const startService = async (engine: Engine): Promise<void> => {
  if (serviceReady) return serviceReady;
  const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
  if (!helperPath) {
    throw new Error("Local Parakeet helper has not been built.");
  }
  const args = await serveArgs(engine);

  serviceReady = new Promise((resolve, reject) => {
    let readySettled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    const resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      if (readyTimeout) clearTimeout(readyTimeout);
      resolve();
    };

    const rejectReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      if (readyTimeout) clearTimeout(readyTimeout);
      reject(error);
    };

    const child = spawn(helperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    serviceProcess = child;

    readyTimeout = setTimeout(() => {
      rejectReady(new Error("Local Parakeet helper did not become ready."));
      stopService();
    }, SERVICE_READY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      serviceBuffer += chunk;
      let newlineIndex = serviceBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = serviceBuffer.slice(0, newlineIndex).trim();
        serviceBuffer = serviceBuffer.slice(newlineIndex + 1);
        handleServiceLine(line, resolveReady, rejectReady);
        newlineIndex = serviceBuffer.indexOf("\n");
      }
    });

    // Always drain stderr. Native/CoreML libraries may emit diagnostics there;
    // leaving the pipe unread can fill its buffer and deadlock startup.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) console.debug("[dictation] local helper:", message);
    });

    child.once("error", (error) => {
      rejectReady(error);
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
    });

    child.once("exit", (code, signal) => {
      const error = new Error(
        `Local Parakeet helper exited (${signal ?? code ?? "unknown"}).`,
      );
      rejectReady(error);
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
      serviceBuffer = "";
    });
  });

  return serviceReady;
};

const handleServiceLine = (
  line: string,
  readyResolve: () => void,
  readyReject: (error: Error) => void,
) => {
  const parsed = parseHelperResponse(line);
  if (!parsed) return;
  if (!parsed.id) {
    if (parsed.ok) {
      readyResolve();
    } else {
      readyReject(
        new Error(parsed.error ?? "Local Parakeet helper failed to start."),
      );
    }
    return;
  }
  const pending = pendingRequests.get(parsed.id);
  if (!pending) return;
  pendingRequests.delete(parsed.id);
  clearTimeout(pending.timeout);
  pending.resolve(parsed);
};

const failPending = (error: Error) => {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRequests.clear();
};

const stopService = () => {
  clearIdleEviction();
  const child = serviceProcess;
  if (!child) return;
  failPending(new Error("Local Parakeet helper stopped."));
  try {
    child.stdin.end();
  } catch {
    // Ignore shutdown races.
  }
  try {
    child.kill();
  } catch {
    // Already stopped.
  }
  serviceProcess = null;
  serviceReady = null;
  serviceBuffer = "";
};

export const stopLocalParakeet = (): void => {
  try {
    coremlInstallProcess?.kill();
  } catch {
    // Already stopped.
  }
  coremlInstallProcess = null;
  stopService();
};

const transcribeWithService = async (
  engine: Engine,
  audioPath: string,
): Promise<HelperResponse> => {
  await startService(engine);
  const child = serviceProcess;
  if (!child || child.stdin.destroyed) {
    throw new Error("Local Parakeet helper is not running.");
  }
  // Perf: each transcription is "activity" — reset the idle-eviction countdown
  // so an actively-used model stays warm while an idle one gets evicted.
  armIdleEviction();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Local Parakeet transcription timed out."));
    }, TRANSCRIBE_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, audioPath })}\n`);
  });
};

export const warmLocalParakeet = async (): Promise<LocalParakeetStatus> => {
  const status = await getLocalParakeetStatus();
  if (!status.available) return status;
  const engine = resolveEngine();
  if (!engine) return status;

  try {
    await startService(engine);
    // Perf: arm idle eviction so a warmed-but-unused model gets reclaimed.
    armIdleEviction();
    return { available: true, model: status.model };
  } catch (error) {
    return {
      available: false,
      model: status.model,
      reason: (error as Error).message,
    };
  }
};

/**
 * Install (when necessary) and verify the local dictation model without
 * keeping it resident in memory. Startup invokes this in the background; until
 * it completes, transcription fails fast into the renderer's cloud fallback.
 */
export const downloadLocalParakeet = async (): Promise<LocalParakeetStatus> => {
  const engine = resolveEngine();
  const model = engine ? MODEL_ID_BY_ENGINE[engine] : CPP_MODEL_ID;
  if (!engine) {
    return {
      available: false,
      model,
      reason: "Local Parakeet dictation is not supported on this platform.",
    };
  }
  const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
  if (!helperPath) {
    return {
      available: false,
      model,
      reason: "Local Parakeet helper has not been built.",
    };
  }

  try {
    if (engine === "coreml") {
      await installCoremlModel();
    } else {
      await ensureCppModel();
    }
    return { available: true, model };
  } catch (error) {
    return {
      available: false,
      model,
      reason: (error as Error).message,
    };
  }
};

export const getLocalParakeetStatus =
  async (): Promise<LocalParakeetStatus> => {
    const engine = resolveEngine();
    if (!engine) {
      return {
        available: false,
        model: CPP_MODEL_ID,
        reason: "Local Parakeet dictation is not supported on this platform.",
      };
    }
    const modelId = MODEL_ID_BY_ENGINE[engine];
    const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
    if (!helperPath) {
      return {
        available: false,
        model: modelId,
        reason: "Local Parakeet helper has not been built.",
      };
    }
    const ready =
      engine === "coreml" ? coremlModelIsReady() : Boolean(cppModelIsReady());
    return {
      available: ready,
      model: modelId,
      reason: ready
        ? undefined
        : engine === "coreml" && coremlModelInstall
          ? "Local Parakeet model is still downloading."
          : engine === "cpp" && cppModelDownload
            ? "Local Parakeet model is still downloading."
            : "Local Parakeet model is not installed yet.",
    };
  };

export const transcribeWithLocalParakeet = async (
  wavBase64: string,
): Promise<{ transcript: string; model: string }> => {
  const engine = resolveEngine();
  if (!engine) {
    throw new Error(
      "Local Parakeet dictation is not supported on this platform.",
    );
  }
  const status = await getLocalParakeetStatus();
  if (!status.available) {
    throw new Error(
      status.reason ?? "Local Parakeet dictation is unavailable.",
    );
  }

  const tempDir = path.join(os.tmpdir(), "stella-dictation");
  await mkdir(tempDir, { recursive: true });
  const audioPath = path.join(tempDir, `${randomUUID()}.wav`);
  try {
    await writeFile(audioPath, Buffer.from(wavBase64, "base64"));
    const result = await transcribeWithService(engine, audioPath);
    if (!result.ok) {
      throw new Error(result.error ?? "Local Parakeet transcription failed.");
    }
    return {
      transcript: result.transcript ?? "",
      model: result.model || status.model,
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => undefined);
  }
};

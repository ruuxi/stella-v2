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

const COREML_INSTALL_TIMEOUT_MS = 45 * 60_000;

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

  installable?: boolean;
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

const armIdleEviction = () => {
  if (idleEvictionTimer) clearTimeout(idleEvictionTimer);
  idleEvictionTimer = setTimeout(() => {
    idleEvictionTimer = null;
    if (pendingRequests.size > 0) {

      armIdleEviction();
      return;
    }
    stopService();
  }, IDLE_EVICTION_MS);

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

const modelDataRoot = (): string =>
  path.join(app.getPath("userData"), "models");

const coremlCacheRoot = (): string => path.join(modelDataRoot(), "parakeet");

const coremlReadyMarkerPath = (): string =>
  path.join(coremlCacheRoot(), `.${COREML_MODEL_ID}.ready`);

const coremlModelIsReady = (): boolean => {
  try {
    return statSync(coremlReadyMarkerPath()).isFile();
  } catch {
    return false;
  }
};

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

const ensureCppModel = (): Promise<string> => {
  const ready = cppModelIsReady();
  if (ready) return Promise.resolve(ready);
  if (cppModelDownload) return cppModelDownload;
  cppModelDownload = downloadCppModel().finally(() => {
    cppModelDownload = null;
  });
  return cppModelDownload;
};

const serveArgs = async (engine: Engine): Promise<string[]> => {
  if (engine === "coreml") {
    return ["--serve", "--cache-root", coremlCacheRoot()];
  }
  const modelPath = cppModelIsReady();
  if (!modelPath) {

    void ensureCppModel().catch(() => undefined);
    throw new Error("Local Parakeet model is still downloading.");
  }
  return ["--serve", "--model", modelPath];
};

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

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) console.debug("[dictation] local helper:", message);
    });

    const failService = (error: Error) => {
      rejectReady(error);

      if (serviceProcess !== child) return;
      failPending(error);
      serviceProcess = null;
      serviceReady = null;
      serviceBuffer = "";
      try {
        child.kill();
      } catch {

      }
    };

    child.stdin.on("error", failService);
    child.once("error", failService);

    child.once("exit", (code, signal) => {
      const error = new Error(
        `Local Parakeet helper exited (${signal ?? code ?? "unknown"}).`,
      );
      rejectReady(error);
      if (serviceProcess !== child) return;
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

  }
  try {
    child.kill();
  } catch {

  }
  serviceProcess = null;
  serviceReady = null;
  serviceBuffer = "";
};

export const stopLocalParakeet = (): void => {
  try {
    coremlInstallProcess?.kill();
  } catch {

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
        installable: false,
        model: CPP_MODEL_ID,
        reason: "Local Parakeet dictation is not supported on this platform.",
      };
    }
    const modelId = MODEL_ID_BY_ENGINE[engine];
    const helperPath = resolveNativeHelperPath(HELPER_NAME_BY_ENGINE[engine]);
    if (!helperPath) {

      return {
        available: false,
        installable: false,
        model: modelId,
        reason: "On-device dictation isn't available on this device yet.",
      };
    }
    const ready =
      engine === "coreml" ? coremlModelIsReady() : Boolean(cppModelIsReady());
    return {
      available: ready,
      installable: true,
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

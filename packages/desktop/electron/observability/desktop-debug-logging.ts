import { app, crashReporter, netLog, shell } from "electron";
import log from "electron-log/main.js";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveLogPaths } from "@stella/runtime/observability/log-paths";

const MAX_LOG_AGE_DAYS = 7;
const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_EXPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_EXPORT_TOTAL_BYTES = 200 * 1024 * 1024;
const NET_LOG_MAX_BYTES = 20 * 1024 * 1024;

type DebugPaths = {
  root: string;
  run: string;
  crashDumps: string;
  networkLog: string;
};

export type DebugExportEntry = {
  name: string;
  filePath: string;
  size: number;
  mtimeMs: number;
};

let debugPaths: DebugPaths | null = null;
let initialized = false;

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "");

const safeLogName = (name: string): string =>
  name.replace(/[^a-z0-9_.-]/giu, "_") || "main";

const isBrokenPipe = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "EPIPE";

const configureConsoleTransport = (): void => {
  if (app.isPackaged) {
    log.transports.console.level = false;
    return;
  }
  const writeConsole = log.transports.console.writeFn.bind(
    log.transports.console,
  );
  log.transports.console.writeFn = (options) => {
    try {
      writeConsole(options);
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
      log.transports.console.level = false;
    }
  };
};

const cleanupOldRuns = async (
  root: string,
  currentRun: string,
): Promise<void> => {
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1_000;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const target = path.join(root, entry.name);
      if (target === currentRun) return;
      try {
        const info = await stat(target);
        if (info.mtimeMs < cutoff) {
          await rm(target, { recursive: true, force: true });
        }
      } catch {
        // Cleanup is best-effort and must never prevent startup.
      }
    }),
  );
};

export const initDesktopDebugLogging = (stellaAppDir: string): void => {
  if (initialized) return;
  initialized = true;

  const root = resolveLogPaths(stellaAppDir).logDir;
  const run = path.join(root, stamp());
  const crashDumps = path.join(app.getPath("userData"), "Crashpad");
  const networkLog = path.join(run, "network.netlog");
  debugPaths = { root, run, crashDumps, networkLog };

  try {
    mkdirSync(run, { recursive: true, mode: 0o700 });
    mkdirSync(crashDumps, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(root, 0o700);
      chmodSync(run, 0o700);
      chmodSync(crashDumps, 0o700);
    }
    log.transports.file.maxSize = 5 * 1024 * 1024;
    log.transports.file.resolvePathFn = (_variables, message) =>
      path.join(
        run,
        `${safeLogName(
          message?.scope ??
            (message?.variables?.processType === "renderer"
              ? "renderer"
              : "main"),
        )}.log`,
      );
    log.initialize({ preload: false, spyRendererConsole: true });
    configureConsoleTransport();
    // Stella still has many direct console call sites. Route them through the
    // same scoped file transport so local debug logs are complete while the
    // original console transport remains visible during development.
    Object.assign(console, log.functions);

    app.setPath("crashDumps", crashDumps);
    crashReporter.start({
      uploadToServer: false,
      compress: true,
      globalExtra: { app: "stella" },
    });
    log.scope("crash").info("crash reporter started", { path: crashDumps });
  } catch (error) {
    // Logging is diagnostic infrastructure; failure cannot block the app.
    try {
      console.warn("[diagnostics] failed to initialize desktop logging", error);
    } catch {
      // Ignore a broken inherited console pipe too.
    }
  }

  void cleanupOldRuns(root, run);
};

export const getDesktopDebugPaths = (): DebugPaths | null => debugPaths;

export const startDesktopNetworkLogging = async (): Promise<void> => {
  const paths = debugPaths;
  if (!paths || netLog.currentlyLogging) return;
  try {
    await netLog.startLogging(paths.networkLog, {
      captureMode: "default",
      maxFileSize: NET_LOG_MAX_BYTES,
    });
    log.scope("network").info("network log started", {
      path: paths.networkLog,
    });
  } catch (error) {
    log.scope("network").warn("failed to start network log", { error });
  }
};

export const collectDebugRoot = async (
  root: string,
  prefix: string,
  cutoff: number,
): Promise<DebugExportEntry[]> => {
  const entries: DebugExportEntry[] = [];

  const visit = async (directory: string): Promise<void> => {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const filePath = path.join(directory, child.name);
      let info;
      try {
        info = await lstat(filePath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff || info.size > MAX_EXPORT_FILE_BYTES) continue;
      if (child.name.endsWith(".heapsnapshot")) continue;
      const relative = path.relative(root, filePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      entries.push({
        name: path.posix.join(prefix, relative.replaceAll(path.sep, "/")),
        filePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  };

  if (existsSync(root)) await visit(root);
  return entries;
};

export const selectDebugExportEntries = (
  entries: DebugExportEntry[],
): DebugExportEntry[] => {
  let total = 0;
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .filter((entry) => {
      if (total + entry.size > MAX_EXPORT_TOTAL_BYTES) return false;
      total += entry.size;
      return true;
    });
};

export const writeDebugZip = async (
  output: string,
  manifest: Record<string, unknown>,
  entries: DebugExportEntry[],
): Promise<void> => {
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    const { BlobReader, BlobWriter, ZipWriter } = await import(
      "@zip.js/zip.js"
    );
    const writer = new ZipWriter(new BlobWriter("application/zip"));
    await writer.add(
      "manifest.json",
      new BlobReader(
        new Blob([JSON.stringify(manifest, null, 2)], {
          type: "application/json",
        }),
      ),
    );
    for (const entry of entries) {
      const data = await readFile(entry.filePath);
      await writer.add(
        entry.name,
        new BlobReader(new Blob([new Uint8Array(data)])),
      );
    }
    const zip = await writer.close();
    await writeFile(temporary, new Uint8Array(await zip.arrayBuffer()), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const exportDesktopDebugLogs = async (): Promise<string> => {
  const paths = debugPaths;
  if (!paths) throw new Error("Desktop diagnostics are not initialized.");

  const restartNetworkLog = netLog.currentlyLogging;
  if (restartNetworkLog) {
    try {
      await netLog.stopLogging();
    } catch (error) {
      log.scope("network").warn("failed to stop network log", { error });
    }
  }

  try {
    const outputDirectory = app.getPath("downloads");
    await mkdir(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, `stella-debug-${stamp()}.zip`);
    log.scope("main").info("exporting debug logs", { output });

    const cutoff = Date.now() - EXPORT_WINDOW_MS;
    const entries = selectDebugExportEntries([
      ...(await collectDebugRoot(paths.root, "logs", cutoff)),
      ...(await collectDebugRoot(paths.crashDumps, "crashpad", cutoff)),
    ]);
    const manifest = {
      generated: new Date().toISOString(),
      version: app.getVersion(),
      name: app.getName(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      uptime: process.uptime(),
      userData: app.getPath("userData"),
      logs: paths.root,
      currentRun: paths.run,
      crashDumps: paths.crashDumps,
      netLog: paths.networkLog,
      exportWindowHours: 24,
      includedFiles: entries.map(({ name, size }) => ({ name, size })),
    };

    await writeDebugZip(output, manifest, entries);
    shell.showItemInFolder(output);
    return output;
  } finally {
    if (restartNetworkLog) await startDesktopNetworkLogging();
  }
};

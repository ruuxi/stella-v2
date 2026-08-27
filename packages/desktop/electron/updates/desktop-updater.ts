import type {
  DesktopUpdateProgress,
  DesktopUpdateSnapshot,
} from "@stella/contracts/desktop/update";
import {
  STELLA_V2_UPDATE_CHANNEL,
  STELLA_V2_UPDATE_FEED_URL,
} from "@stella/contracts/desktop/update";

type UpdateInfoLike = {
  version: string;
  releaseName?: string | null;
  releaseDate?: string | null;
};

type ProgressInfoLike = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

type UpdaterListener = (...args: unknown[]) => void;

export type DesktopUpdaterClient = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableWebInstaller: boolean;
  setFeedURL: (options: {
    provider: "generic";
    url: string;
    channel: typeof STELLA_V2_UPDATE_CHANNEL;
    useMultipleRangeRequest: boolean;
  }) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: UpdaterListener) => unknown;
  removeListener: (event: string, listener: UpdaterListener) => unknown;
};

export type DesktopUpdaterOptions = {
  client: DesktopUpdaterClient;
  currentVersion: string;
  enabled: boolean;
  autoInstallOnAppQuit?: boolean;
  // Modern desktop apps stage the update in the background so the visible
  // action is a single click. Leave this on unless a caller needs the
  // download to stay manual.
  autoDownload?: boolean;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  restartStallMs?: number;
  onStateChanged?: (snapshot: DesktopUpdateSnapshot) => void;

  onBeforeRestart?: () => void;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

const DEFAULT_STARTUP_DELAY_MS = 6_000;
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

const DEFAULT_RESTART_STALL_MS = 20_000;

const asErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  return String(value || "Unknown desktop update error.");
};

const updateInfoFromArgs = (args: unknown[]): UpdateInfoLike | null => {
  const value = args[0];
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<UpdateInfoLike>;
  return typeof candidate.version === "string"
    ? (candidate as UpdateInfoLike)
    : null;
};

export const assertIsolatedV2UpdateFeed = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.pathname.startsWith("/desktop-v2/")) {
    throw new Error(
      `Refusing non-v2 desktop update feed: ${url.origin}${url.pathname}`,
    );
  }
  return url.toString().replace(/\/$/, "");
};

export const resolveDesktopUpdateFeedUrl = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => {
  const os =
    platform === "darwin"
      ? "mac"
      : platform === "win32"
        ? "win"
        : platform === "linux"
          ? "linux"
          : null;
  if (!os || (arch !== "arm64" && arch !== "x64")) {
    throw new Error(`Unsupported desktop update platform: ${platform}-${arch}`);
  }
  return assertIsolatedV2UpdateFeed(
    `${STELLA_V2_UPDATE_FEED_URL}/${os}-${arch}`,
  );
};

export class DesktopUpdater {
  private snapshot: DesktopUpdateSnapshot;
  private readonly client: DesktopUpdaterClient;
  private readonly enabled: boolean;
  private readonly feedUrl: string;
  private readonly autoInstallOnAppQuit: boolean;
  private readonly autoDownload: boolean;
  private readonly startupDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly restartStallMs: number;
  private readonly onStateChanged?: (snapshot: DesktopUpdateSnapshot) => void;
  private readonly onBeforeRestart?: () => void;
  private readonly log: NonNullable<DesktopUpdaterOptions["log"]>;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private restartStallTimer: ReturnType<typeof setTimeout> | null = null;
  private checkPromise: Promise<DesktopUpdateSnapshot> | null = null;
  private downloadPromise: Promise<DesktopUpdateSnapshot> | null = null;
  private started = false;

  private readonly listeners: Array<[string, UpdaterListener]>;

  constructor(options: DesktopUpdaterOptions) {
    this.client = options.client;
    this.enabled = options.enabled;
    this.feedUrl = resolveDesktopUpdateFeedUrl();
    this.autoInstallOnAppQuit = options.autoInstallOnAppQuit ?? true;
    this.autoDownload = options.autoDownload ?? true;
    this.startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.restartStallMs = options.restartStallMs ?? DEFAULT_RESTART_STALL_MS;
    this.onStateChanged = options.onStateChanged;
    this.onBeforeRestart = options.onBeforeRestart;
    this.log =
      options.log ??
      ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } satisfies NonNullable<DesktopUpdaterOptions["log"]>);
    this.snapshot = {
      status: this.enabled ? "idle" : "disabled",
      channel: STELLA_V2_UPDATE_CHANNEL,
      currentVersion: options.currentVersion,
      availableVersion: null,
      downloadedVersion: null,
      releaseName: null,
      releaseDate: null,
      progress: null,
      checkedAt: null,
      error: null,
    };

    this.listeners = [
      ["checking-for-update", () => this.onChecking()],
      ["update-available", (...args) => this.onAvailable(args)],
      ["update-not-available", (...args) => this.onNotAvailable(args)],
      ["download-progress", (...args) => this.onProgress(args)],
      ["update-downloaded", (...args) => this.onDownloaded(args)],
      ["error", (...args) => this.onError(args[0])],
    ];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) {
      this.emit();
      return;
    }

    this.client.autoDownload = false;
    this.client.autoInstallOnAppQuit = this.autoInstallOnAppQuit;
    this.client.allowDowngrade = false;
    this.client.allowPrerelease = false;
    this.client.disableWebInstaller = true;
    this.client.setFeedURL({
      provider: "generic",
      url: this.feedUrl,
      channel: STELLA_V2_UPDATE_CHANNEL,
      useMultipleRangeRequest: false,
    });

    this.client.allowDowngrade = false;
    for (const [event, listener] of this.listeners) {
      this.client.on(event, listener);
    }

    this.log.info(
      `Desktop updater enabled on isolated channel ${STELLA_V2_UPDATE_CHANNEL} (${this.feedUrl}).`,
    );
    this.startupTimer = setTimeout(() => {
      void this.checkNow().catch(() => undefined);
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.intervalTimer = setInterval(() => {
      void this.checkNow().catch(() => undefined);
    }, this.checkIntervalMs);
    this.intervalTimer.unref?.();
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.restartStallTimer) clearTimeout(this.restartStallTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    this.restartStallTimer = null;
    for (const [event, listener] of this.listeners) {
      this.client.removeListener(event, listener);
    }
    this.started = false;
  }

  getState(): DesktopUpdateSnapshot {
    return structuredClone(this.snapshot);
  }

  checkNow(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled) return Promise.resolve(this.getState());

    if (this.snapshot.status === "restarting") {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) return this.checkPromise;
    this.patch({ status: "checking", error: null, progress: null });
    this.checkPromise = this.client
      .checkForUpdates()
      .then(() => this.getState())
      .catch((error) => {
        this.onError(error);
        throw error;
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  download(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled) return Promise.resolve(this.getState());
    // The background download normally wins the race, so a manual download
    // joins the in-flight one instead of failing the caller.
    if (this.downloadPromise) return this.downloadPromise;
    if (
      this.snapshot.status === "downloaded" ||
      this.snapshot.status === "restarting"
    ) {
      return Promise.resolve(this.getState());
    }
    if (this.snapshot.status !== "available") {
      return Promise.reject(
        new Error("No Stella desktop update is ready to download."),
      );
    }
    this.patch({ status: "downloading", error: null, progress: null });
    this.downloadPromise = this.client
      .downloadUpdate()
      .then(() => this.getState())
      .catch((error) => {
        this.onError(error);
        throw error;
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  restartAndInstall(): { accepted: true } {

    if (this.snapshot.status === "restarting") {
      return { accepted: true };
    }
    if (this.snapshot.status !== "downloaded") {
      throw new Error("Download the Stella desktop update before restarting.");
    }

    try {
      this.onBeforeRestart?.();
    } catch (error) {
      this.log.warn(
        `Desktop update restart preparation failed: ${asErrorMessage(error)}`,
      );
    }

    this.patch({ status: "restarting", error: null });
    this.log.info(
      `Restarting to install desktop update ${this.snapshot.downloadedVersion ?? "unknown"}.`,
    );
    this.restartStallTimer = setTimeout(() => {
      this.restartStallTimer = null;
      this.log.error(
        `Desktop update restart stalled after ${this.restartStallMs}ms; the installer never quit the app.`,
      );
      this.patch({
        status: "downloaded",
        error:
          "Stella could not restart itself. Quit and reopen Stella to finish updating.",
      });
    }, this.restartStallMs);
    this.restartStallTimer.unref?.();

    setImmediate(() => this.client.quitAndInstall(true, true));
    return { accepted: true };
  }

  private onChecking(): void {
    this.patch({ status: "checking", error: null, progress: null });
  }

  private onAvailable(args: unknown[]): void {
    const info = updateInfoFromArgs(args);
    if (!info) return;
    this.patch({
      status: "available",
      availableVersion: info.version,
      downloadedVersion: null,
      releaseName: info.releaseName ?? null,
      releaseDate: info.releaseDate ?? null,
      progress: null,
      checkedAt: new Date().toISOString(),
      error: null,
    });
    if (!this.autoDownload) return;
    // Stage the payload immediately so the pill only ever appears once the
    // update is installable in one click. electron-updater's own autoDownload
    // stays off: routing through download() keeps the snapshot, the in-flight
    // promise, and the error path identical to a manual download.
    queueMicrotask(() => {
      void this.download().catch(() => undefined);
    });
  }

  private onNotAvailable(args: unknown[]): void {
    const info = updateInfoFromArgs(args);
    this.patch({
      status: "idle",
      availableVersion: null,
      downloadedVersion: null,
      releaseName: info?.releaseName ?? null,
      releaseDate: info?.releaseDate ?? null,
      progress: null,
      checkedAt: new Date().toISOString(),
      error: null,
    });
  }

  private onProgress(args: unknown[]): void {
    const value = args[0];
    if (!value || typeof value !== "object") return;
    const info = value as ProgressInfoLike;
    const progress: DesktopUpdateProgress = {
      percent: Number.isFinite(info.percent)
        ? Math.max(0, Math.min(100, info.percent))
        : 0,
      bytesPerSecond: Number(info.bytesPerSecond) || 0,
      transferred: Number(info.transferred) || 0,
      total: Number(info.total) || 0,
    };
    this.patch({ status: "downloading", progress, error: null });
  }

  private onDownloaded(args: unknown[]): void {
    const info = updateInfoFromArgs(args);
    const version = info?.version ?? this.snapshot.availableVersion;
    this.patch({
      status: "downloaded",
      availableVersion: version,
      downloadedVersion: version,
      releaseName: info?.releaseName ?? this.snapshot.releaseName,
      releaseDate: info?.releaseDate ?? this.snapshot.releaseDate,
      progress: this.snapshot.progress
        ? { ...this.snapshot.progress, percent: 100 }
        : null,
      error: null,
    });
  }

  private onError(error: unknown): void {
    const message = asErrorMessage(error);
    this.log.error(`Desktop updater failed: ${message}`);
    this.patch({ status: "error", progress: null, error: message });
  }

  private patch(patch: Partial<DesktopUpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    this.onStateChanged?.(this.getState());
  }
}

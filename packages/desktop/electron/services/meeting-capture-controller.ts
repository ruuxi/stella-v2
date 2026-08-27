import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { systemPreferences } from "electron";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { reapPidfileDaemon } from "./helper-pid-guard.js";
import { hasMacPermission, requestMacPermission } from "../utils/macos-permissions.js";

const STARTUP_TIMEOUT_MS = 4_000;
const STARTUP_POLL_MS = 150;
const STARTUP_POLL_MAX_MS = 1_200;
const DEFAULT_SEGMENT_SECONDS = 30;

export type MeetingStartResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  segmentSeconds?: number;
  system?: boolean;
  mic?: boolean;
  startedAtMs?: number;
  reason?: string;
};

export type MeetingStopResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  durationMs?: number;
  systemSegments?: number;
  micSegments?: number;
  reason?: string;
};

export type MeetingStatus = {
  available: boolean;
  running: boolean;
  recording: boolean;
  paused: boolean;
  sessionId: string | null;
  startedAtMs: number | null;
  segmentSeconds: number;
  screenPermission: boolean;
  micPermission: boolean;
};

const meetingPidFile = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "meetings", "meeting_capture.pid");

export class MeetingCaptureController {
  private child: ChildProcess | null = null;
  private binPath: string | null = null;

  constructor(private readonly stellaDataDir: string) {}

  private resolveBin(): string | null {
    if (this.binPath) return this.binPath;
    this.binPath = resolveNativeHelperPath("meeting_capture");
    return this.binPath;
  }

  private async runCommand(args: string[]): Promise<string | null> {
    const bin = this.resolveBin();
    if (!bin) return null;
    return await new Promise<string | null>((resolve) => {
      execFile(
        bin,
        [...args, "--root", this.stellaDataDir],
        { timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(stdout.toString().trim());
        },
      );
    });
  }

  private parseJson(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async waitForDaemonReady(timeoutMs = STARTUP_TIMEOUT_MS): Promise<boolean> {
    const startedAt = Date.now();

    let pollMs = STARTUP_POLL_MS;
    while (Date.now() - startedAt < timeoutMs) {
      if ((await this.runCommand(["ping"])) === "pong") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, STARTUP_POLL_MAX_MS);
    }
    return false;
  }

  private async ensureDaemon(): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      return { ok: false, reason: "unsupported-platform" };
    }
    const bin = this.resolveBin();
    if (!bin) {
      return { ok: false, reason: "binary-missing" };
    }
    if ((await this.runCommand(["ping"])) === "pong") {
      return { ok: true };
    }

    try {
      await fs.mkdir(path.join(this.stellaDataDir, "meetings"), { recursive: true });
    } catch {

    }

    const child = spawn(bin, ["daemon", "--root", this.stellaDataDir], {
      detached: true,
      stdio: "ignore",
    });
    this.child = child;

    if (typeof child.pid === "number") {
      try {
        await fs.writeFile(meetingPidFile(this.stellaDataDir), String(child.pid));
      } catch {

      }
    }
    let spawnErrorMessage: string | null = null;
    child.on("error", (error) => {
      spawnErrorMessage = error.message;
      this.child = null;
    });
    child.unref();
    child.on("exit", () => {
      this.child = null;
    });

    if (!(await this.waitForDaemonReady())) {
      return { ok: false, reason: spawnErrorMessage ?? "startup-timeout" };
    }
    return { ok: true };
  }

  private getMicPermission(): boolean {
    if (process.platform !== "darwin") return true;
    try {
      return systemPreferences.getMediaAccessStatus("microphone") === "granted";
    } catch {
      return false;
    }
  }

  async start(options?: {
    sessionId?: string;
    segmentSeconds?: number;
  }): Promise<MeetingStartResult> {
    const daemon = await this.ensureDaemon();
    if (!daemon.ok) {
      return { ok: false, reason: daemon.reason ?? "daemon-failed" };
    }

    if (!hasMacPermission("screen", false)) {
      const result = await requestMacPermission("screen");
      if (!result.granted) {
        return { ok: false, reason: "needs-screen-permission" };
      }
    }

    if (process.platform === "darwin" && !this.getMicPermission()) {
      try {
        await systemPreferences.askForMediaAccess("microphone");
      } catch {

      }
    }

    const segmentSeconds = Math.max(
      1,
      Math.floor(options?.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS),
    );
    const args = ["start", "--segment-seconds", String(segmentSeconds)];
    if (options?.sessionId) {
      args.push("--session-id", options.sessionId);
    }
    const parsed = this.parseJson(await this.runCommand(args));
    if (!parsed) {
      return { ok: false, reason: "start-failed" };
    }
    if (parsed.ok !== true) {
      return { ok: false, reason: String(parsed.error ?? "start-failed") };
    }
    return {
      ok: true,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      dir: typeof parsed.dir === "string" ? parsed.dir : undefined,
      segmentSeconds:
        typeof parsed.segmentSeconds === "number" ? parsed.segmentSeconds : segmentSeconds,
      system: parsed.system === true,
      mic: parsed.mic === true,
      startedAtMs:
        typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : undefined,
    };
  }

  async pause(): Promise<boolean> {
    const parsed = this.parseJson(await this.runCommand(["pause"]));
    return parsed?.ok === true;
  }

  async resume(): Promise<boolean> {
    const parsed = this.parseJson(await this.runCommand(["resume"]));
    return parsed?.ok === true;
  }

  async stop(): Promise<MeetingStopResult> {
    const parsed = this.parseJson(await this.runCommand(["stop"]));
    if (!parsed) {
      return { ok: false, reason: "stop-failed" };
    }
    if (parsed.ok !== true) {
      return { ok: false, reason: String(parsed.error ?? "stop-failed") };
    }
    return {
      ok: true,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      dir: typeof parsed.dir === "string" ? parsed.dir : undefined,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : undefined,
      systemSegments:
        typeof parsed.systemSegments === "number" ? parsed.systemSegments : undefined,
      micSegments:
        typeof parsed.micSegments === "number" ? parsed.micSegments : undefined,
    };
  }

  async status(): Promise<MeetingStatus> {
    const bin = this.resolveBin();
    const micPermission = this.getMicPermission();
    const screenPermission =
      process.platform === "darwin" ? hasMacPermission("screen", false) : true;
    if (!bin) {
      return {
        available: false,
        running: false,
        recording: false,
        paused: false,
        sessionId: null,
        startedAtMs: null,
        segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        screenPermission,
        micPermission,
      };
    }
    const parsed = this.parseJson(await this.runCommand(["status"]));
    if (!parsed) {
      return {
        available: true,
        running: false,
        recording: false,
        paused: false,
        sessionId: null,
        startedAtMs: null,
        segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        screenPermission,
        micPermission,
      };
    }
    const sessionId =
      typeof parsed.sessionId === "string" && parsed.sessionId.length > 0
        ? parsed.sessionId
        : null;
    return {
      available: true,
      running: parsed.running === true,
      recording: parsed.recording === true,
      paused: parsed.paused === true,
      sessionId,
      startedAtMs:
        typeof parsed.startedAtMs === "number" && parsed.startedAtMs > 0
          ? parsed.startedAtMs
          : null,
      segmentSeconds:
        typeof parsed.segmentSeconds === "number"
          ? parsed.segmentSeconds
          : DEFAULT_SEGMENT_SECONDS,
      screenPermission:
        typeof parsed.screenPermission === "boolean"
          ? parsed.screenPermission
          : screenPermission,
      micPermission,
    };
  }

  async shutdown(): Promise<void> {

    await this.runCommand(["shutdown"]);
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {

      }
    }
    this.child = null;

    await reapPidfileDaemon(meetingPidFile(this.stellaDataDir), this.resolveBin(), [
      "--root",
      this.stellaDataDir,
    ]);
  }
}

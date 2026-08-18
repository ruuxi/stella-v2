import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readdirSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  STELLA_BROWSER_BRIDGE_PORT,
  STELLA_BROWSER_BRIDGE_SESSION,
  STELLA_BROWSER_BRIDGE_TOKEN,
  STELLA_BROWSER_EXTENSION_ID,
  STELLA_NATIVE_MESSAGING_HOST_NAME,
  getStellaBrowserSocketDir,
} from "@stella/runtime/kernel/tools/stella-browser-bridge-config";
import { registerStellaNativeMessagingHost } from "../utils/register-stella-native-messaging-host.js";
import {
  activateStagedStellaBrowserBinary,
  resolveLegacyStellaBrowserBinaryPath,
  resolveStellaBrowserBinaryPath,
  resolveStellaBrowserRoot,
} from "../utils/stella-browser-paths.js";
import { stopChildProcessTree } from "../process-runtime.js";

const execFileAsync = promisify(execFile);

const DAEMON_READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 2_000;
const DAEMON_READY_PROBE_TIMEOUT_MS = 1_000;
const AGENT_DAEMON_IDLE_TIMEOUT_MS = 30 * 60_000;
const AGENT_CAPABILITY_TTL_MS = 24 * 60 * 60_000;

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

const parseProcessRows = (output: string): ProcessRow[] =>
  output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1]!, 10),
        ppid: Number.parseInt(match[2]!, 10),
        command: match[3]!,
      };
    })
    .filter((row): row is ProcessRow =>
      Boolean(row && Number.isFinite(row.pid) && Number.isFinite(row.ppid)),
    );

const findOrphanedBundledDaemonPids = async (): Promise<number[]> => {
  const activeBinaryPath = resolveStellaBrowserBinaryPath();
  const legacyBinaryPath = resolveLegacyStellaBrowserBinaryPath();
  const binaryPaths = [activeBinaryPath, legacyBinaryPath].filter(
    (value): value is string => Boolean(value),
  );
  if (process.platform === "win32") {
    const binaryPath = activeBinaryPath ?? legacyBinaryPath;
    if (!binaryPath) return [];
    const quotedBinaryPath = binaryPath.replace(/'/g, "''");
    const quotedBinaryName = path.basename(binaryPath).replace(/'/g, "''");
    try {
      // Exclude Chrome-spawned native messaging hosts: Chrome passes the
      // extension origin (chrome-extension://...) as an argument and owns
      // their lifecycle. Killing them disconnects the extension's native
      // port and kicks off its respawn/reconnect loop.
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          [
            `$target = '${quotedBinaryPath}'`,
            `Get-CimInstance Win32_Process -Filter "Name = '${quotedBinaryName}'"`,
            "| Where-Object { $_.ExecutablePath -eq $target -and $_.ProcessId -ne $PID -and $_.CommandLine -notlike '*chrome-extension://*' }",
            "| Select-Object -ExpandProperty ProcessId -Unique",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
      return stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    } catch {
      return [];
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,command="],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    return parseProcessRows(stdout)
      .filter(
        (row) =>
          row.pid !== process.pid &&
          row.ppid === 1 &&
          binaryPaths.some((binaryPath) => row.command.includes(binaryPath)),
      )
      .map((row) => row.pid);
  } catch {
    return [];
  }
};

export const stopOrphanedStellaBrowserDaemons = async () => {
  const pids = await findOrphanedBundledDaemonPids();
  if (pids.length === 0) return;
  for (const pid of pids) {
    if (process.platform === "win32") {
      try {
        await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
        });
        continue;
      } catch {
        // Fall through to a direct kill attempt below.
      }
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
  await delay(150);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort stale daemon cleanup.
    }
  }
};

type StellaBrowserBridgeServiceOptions = {
  stellaAppDir: string;
  onUnexpectedExit?: (error: string) => void;
};

export type StellaBrowserAgentCapability = Readonly<{
  ownerId: string;
  turnId: string;
  ownerLeaseId: string;
  ownerLeaseIssuedAt: number;
  recover?: boolean;
}>;

export type StellaBrowserAgentBackend = Readonly<{
  bridgeSessionId: string;
  capabilityExpiresAt: number;
}>;

type AgentBackendRecord = StellaBrowserAgentCapability &
  StellaBrowserAgentBackend &
  Readonly<{
    cdpUrl: string;
    controlToken: string;
    extensionDelegateToken: string;
    process: ChildProcess;
  }>;

type AgentOwnerLeaseOrder = Readonly<{
  ownerLeaseIssuedAt: number;
  ownerLeaseId: string;
}>;

const compareAgentOwnerLeaseOrder = (
  left: AgentOwnerLeaseOrder,
  right: AgentOwnerLeaseOrder,
): number => {
  if (left.ownerLeaseIssuedAt !== right.ownerLeaseIssuedAt) {
    return left.ownerLeaseIssuedAt < right.ownerLeaseIssuedAt ? -1 : 1;
  }
  if (left.ownerLeaseId === right.ownerLeaseId) return 0;
  return Buffer.compare(
    Buffer.from(left.ownerLeaseId, "utf8"),
    Buffer.from(right.ownerLeaseId, "utf8"),
  );
};

type DaemonResponse = {
  success?: boolean;
  error?: string;
  data?: unknown;
};

export type StellaBrowserExportedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  session: boolean;
  storeId: string;
  sameSite: string;
  expirationDate?: number;
  partitionKey?: {
    topLevelSite?: string;
    hasCrossSiteAncestor?: boolean;
  };
  [key: string]: unknown;
};

export class StellaBrowserBridgeService {
  private readonly stellaAppDir: string;
  private readonly onUnexpectedExit?: (error: string) => void;

  private daemonProcess: ChildProcess | null = null;
  private launchPromise: Promise<void> | null = null;
  private readonly controlToken = randomUUID();
  private readonly agentBackends = new Map<string, AgentBackendRecord>();
  private readonly agentOwnerLeaseHighWater = new Map<
    string,
    Readonly<{
      ownerLeaseIssuedAt: number;
      ownerLeaseId: string;
      turnId: string;
    }>
  >();
  private readonly agentBackendLaunches = new Map<
    string,
    Readonly<{
      ownerLeaseId: string;
      ownerLeaseIssuedAt: number;
      turnId: string;
      promise: Promise<StellaBrowserAgentBackend>;
    }>
  >();
  private agentBackendGeneration = 0;
  private connectedCdpUrl: string | null = null;
  private connectingCdp: Readonly<{
    url: string;
    promise: Promise<void>;
  }> | null = null;
  private cdpRoutingGeneration = 0;
  private isLaunching = false;
  private stopped = false;

  constructor(options: StellaBrowserBridgeServiceOptions) {
    this.stellaAppDir = options.stellaAppDir;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  async getExtensionStatus(): Promise<boolean> {
    const response = await this.sendCommand({
      id: randomUUID(),
      action: "extension_status",
    });
    return (
      typeof response.data === "object" &&
      response.data !== null &&
      "connected" in response.data &&
      response.data.connected === true
    );
  }

  async exportAllCookies(): Promise<StellaBrowserExportedCookie[]> {
    const response = await this.sendCommand({
      id: randomUUID(),
      action: "cookies_export_all",
    });
    const cookies =
      typeof response.data === "object" &&
      response.data !== null &&
      "cookies" in response.data
        ? response.data.cookies
        : null;
    if (!Array.isArray(cookies)) {
      throw new Error("Browser extension returned an invalid cookie export.");
    }
    return cookies as StellaBrowserExportedCookie[];
  }

  async exportCookiesForUrls(
    urls: string[],
  ): Promise<StellaBrowserExportedCookie[]> {
    const response = await this.sendCommand({
      id: randomUUID(),
      action: "cookies_export_for_urls",
      urls,
    });
    const cookies =
      typeof response.data === "object" &&
      response.data !== null &&
      "cookies" in response.data
        ? response.data.cookies
        : null;
    if (!Array.isArray(cookies)) {
      throw new Error("Browser extension returned an invalid cookie export.");
    }
    return cookies as StellaBrowserExportedCookie[];
  }

  async connectCdp(cdpUrl: string): Promise<void> {
    const normalizedUrl = cdpUrl.trim();
    if (!normalizedUrl) {
      throw new Error("A CDP URL is required.");
    }
    if (this.connectedCdpUrl === normalizedUrl) {
      return Promise.resolve();
    }
    if (this.connectingCdp?.url === normalizedUrl) {
      return this.connectingCdp.promise;
    }

    const previousAttempt = this.connectingCdp?.promise;
    const routingGeneration = this.cdpRoutingGeneration;
    const promise = (async () => {
      // A changed adapter URL is serialized behind any in-flight launch. The
      // successful URL is checked again afterwards so concurrent callers do
      // not issue duplicate launch commands.
      await previousAttempt?.catch(() => undefined);
      if (this.connectedCdpUrl === normalizedUrl) return;
      await this.sendCommand({
        id: randomUUID(),
        action: "launch",
        cdpUrl: normalizedUrl,
      });
      if (this.cdpRoutingGeneration === routingGeneration) {
        this.connectedCdpUrl = normalizedUrl;
      }
    })();
    this.connectingCdp = { url: normalizedUrl, promise };
    void promise.then(
      () => {
        if (this.connectingCdp?.promise === promise) {
          this.connectingCdp = null;
        }
      },
      () => {
        // Failed launches are deliberately not cached, so the next browser
        // session can retry the same endpoint.
        if (this.connectingCdp?.promise === promise) {
          this.connectingCdp = null;
        }
      },
    );
    await promise;
  }

  async connectAgentCdp(
    capability: StellaBrowserAgentCapability,
    cdpUrl: string,
  ): Promise<StellaBrowserAgentBackend> {
    const ownerId = requireCapabilityString(capability.ownerId, "ownerId");
    const turnId = requireCapabilityString(capability.turnId, "turnId");
    const ownerLeaseId = requireCapabilityString(
      capability.ownerLeaseId,
      "ownerLeaseId",
    );
    const ownerLeaseIssuedAt = requireCapabilityTimestamp(
      capability.ownerLeaseIssuedAt,
    );
    const normalizedUrl = cdpUrl.trim();
    if (!normalizedUrl) throw new Error("A CDP URL is required.");
    await this.start();
    const backendGeneration = this.agentBackendGeneration;

    // The process map is intentionally ephemeral: a daemon may exit after a
    // transport error. Lease fencing must outlive that process record so an
    // older worker cannot reclaim the durable owner's capability afterward.
    const highWater = this.agentOwnerLeaseHighWater.get(ownerId);
    if (highWater) {
      const order = compareAgentOwnerLeaseOrder(
        { ownerLeaseIssuedAt, ownerLeaseId },
        highWater,
      );
      if (order < 0) {
        throw new Error(
          "A newer browser session already owns this agent backend.",
        );
      }
      if (order === 0 && turnId !== highWater.turnId) {
        throw new Error(
          "A conflicting browser lease already owns this agent backend generation.",
        );
      }
    }
    this.agentOwnerLeaseHighWater.set(ownerId, {
      ownerLeaseIssuedAt,
      ownerLeaseId,
      turnId,
    });

    const inFlight = this.agentBackendLaunches.get(ownerId);
    if (
      !capability.recover &&
      inFlight?.ownerLeaseId === ownerLeaseId &&
      inFlight.ownerLeaseIssuedAt === ownerLeaseIssuedAt &&
      inFlight.turnId === turnId
    ) {
      return await inFlight.promise;
    }

    const previousLaunch = inFlight?.promise;
    const promise = (async () => {
      await previousLaunch?.catch(() => undefined);
      const existing = this.agentBackends.get(ownerId);
      if (
        !capability.recover &&
        existing?.ownerLeaseId === ownerLeaseId &&
        existing.ownerLeaseIssuedAt === ownerLeaseIssuedAt &&
        existing.turnId === turnId &&
        existing.cdpUrl === normalizedUrl &&
        existing.process.exitCode === null &&
        !existing.process.killed &&
        existing.capabilityExpiresAt > Date.now()
      ) {
        return agentBackendResult(existing);
      }
      if (
        existing &&
        compareAgentOwnerLeaseOrder(
          { ownerLeaseIssuedAt, ownerLeaseId },
          existing,
        ) < 0
      ) {
        throw new Error(
          "A newer browser session already owns this agent backend.",
        );
      }
      if (existing) await this.stopAgentBackend(existing);
      const next = await this.spawnAgentBackend({
        ownerId,
        turnId,
        ownerLeaseId,
        ownerLeaseIssuedAt,
        cdpUrl: normalizedUrl,
      });
      const latestLease = this.agentOwnerLeaseHighWater.get(ownerId);
      if (
        !latestLease ||
        latestLease.ownerLeaseIssuedAt !== ownerLeaseIssuedAt ||
        latestLease.ownerLeaseId !== ownerLeaseId ||
        latestLease.turnId !== turnId
      ) {
        await this.stopAgentBackend(next);
        throw new Error(
          "A newer browser session superseded this agent backend during initialization.",
        );
      }
      if (this.stopped || this.agentBackendGeneration !== backendGeneration) {
        await this.stopAgentBackend(next);
        throw new Error(
          "Browser bridge restarted during agent initialization.",
        );
      }
      this.agentBackends.set(ownerId, next);
      return agentBackendResult(next);
    })();
    this.agentBackendLaunches.set(ownerId, {
      ownerLeaseId,
      ownerLeaseIssuedAt,
      turnId,
      promise,
    });
    void promise.then(
      () => {
        if (this.agentBackendLaunches.get(ownerId)?.promise === promise) {
          this.agentBackendLaunches.delete(ownerId);
        }
      },
      () => {
        if (this.agentBackendLaunches.get(ownerId)?.promise === promise) {
          this.agentBackendLaunches.delete(ownerId);
        }
      },
    );
    return await promise;
  }

  start() {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.daemonProcess || this.launchPromise) {
      return this.launchPromise ?? Promise.resolve();
    }
    const launchPromise = this.launchBridge().finally(() => {
      if (this.launchPromise === launchPromise) {
        this.launchPromise = null;
      }
    });
    this.launchPromise = launchPromise;
    return launchPromise;
  }

  async stop() {
    this.stopped = true;
    this.resetCdpRouting();
    this.agentBackendGeneration += 1;

    await Promise.allSettled([
      ...Array.from(this.agentBackends.values(), (backend) =>
        this.stopAgentBackend(backend),
      ),
      ...Array.from(this.agentBackendLaunches.values(), ({ promise }) =>
        promise.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]);
    this.agentBackends.clear();
    this.agentBackendLaunches.clear();
    this.agentOwnerLeaseHighWater.clear();

    const closePromise = this.sendCommand({
      id: randomUUID(),
      action: "close",
    }).catch(() => undefined);

    await Promise.race([closePromise, delay(1_500)]).catch(() => undefined);
    await this.killDaemonProcess();
    await this.stopOrphanedBundledDaemons();
    this.daemonProcess = null;
  }

  private async launchBridge() {
    if (this.stopped) {
      return;
    }

    this.isLaunching = true;

    try {
      const registration = await registerStellaNativeMessagingHost();
      if (!registration.ok) {
        throw new Error(
          registration.error ??
            "Could not register the browser extension connector. Stella may need permission to update browser settings.",
        );
      }

      await this.closeExistingSession();
      this.spawnDaemon();
      await this.waitForDaemonReady();
      await this.sendCommand({
        id: randomUUID(),
        action: "launch",
        provider: "extension",
      });
      await Promise.all(
        Array.from(this.agentBackends.values(), (backend) =>
          this.registerAgentExtensionDelegate(backend),
        ),
      );
    } catch (error) {
      await this.killDaemonProcess();
      throw error;
    } finally {
      this.isLaunching = false;
    }
  }

  private spawnDaemon() {
    this.resetCdpRouting();
    const stellaBrowserRoot = resolveStellaBrowserRoot();
    activateStagedStellaBrowserBinary(stellaBrowserRoot);
    const binPath = resolveStellaBrowserBinaryPath(stellaBrowserRoot);
    if (!binPath) {
      throw new Error(
        "The native Stella Browser service is unavailable. Reinstall Stella or restore the browser service artifact.",
      );
    }
    if (process.platform !== "win32") {
      try {
        accessSync(binPath, constants.X_OK);
      } catch {
        chmodSync(binPath, 0o755);
      }
    }

    const daemon = spawn(
      binPath,
      ["service", "run", "--session", STELLA_BROWSER_BRIDGE_SESSION],
      {
        cwd: stellaBrowserRoot,
        env: {
          ...process.env,
          STELLA_BROWSER_EXT_PORT: STELLA_BROWSER_BRIDGE_PORT,
          STELLA_BROWSER_EXT_TOKEN: STELLA_BROWSER_BRIDGE_TOKEN,
          STELLA_BROWSER_CONTROL_TOKEN: this.controlToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    daemon.stdout?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) {
        console.debug("[stella-browser-bridge]", message);
      }
    });

    daemon.stderr?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) {
        console.warn("[stella-browser-bridge]", message);
      }
    });

    daemon.once("exit", (code, signal) => {
      if (this.daemonProcess !== daemon) {
        return;
      }

      this.daemonProcess = null;
      this.resetCdpRouting();

      if (this.stopped || this.isLaunching) {
        return;
      }

      const reason = signal
        ? `Bridge process exited via ${signal}.`
        : `Bridge process exited with code ${code ?? 0}.`;
      this.onUnexpectedExit?.(reason);
    });

    daemon.once("error", (error) => {
      if (this.daemonProcess !== daemon) {
        return;
      }
      this.daemonProcess = null;
      this.resetCdpRouting();
      if (this.stopped || this.isLaunching) {
        return;
      }
      this.onUnexpectedExit?.(
        `Failed to start browser bridge: ${error.message}`,
      );
    });

    this.daemonProcess = daemon;
  }

  private async spawnAgentBackend(
    input: StellaBrowserAgentCapability & Readonly<{ cdpUrl: string }>,
  ): Promise<AgentBackendRecord> {
    const stellaBrowserRoot = resolveStellaBrowserRoot();
    activateStagedStellaBrowserBinary(stellaBrowserRoot);
    const binPath = resolveStellaBrowserBinaryPath(stellaBrowserRoot);
    if (!binPath) {
      throw new Error(
        "The native Stella Browser service is unavailable. Reinstall Stella or restore the browser service artifact.",
      );
    }
    if (process.platform !== "win32") {
      try {
        accessSync(binPath, constants.X_OK);
      } catch {
        chmodSync(binPath, 0o755);
      }
    }

    const bridgeSessionId = `agent-${randomUUID().replaceAll("-", "")}`;
    const controlToken = randomUUID();
    const extensionDelegateToken = randomUUID();
    const capabilityExpiresAt = Date.now() + AGENT_CAPABILITY_TTL_MS;
    const daemon = spawn(
      binPath,
      ["service", "run", "--session", bridgeSessionId],
      {
        cwd: stellaBrowserRoot,
        env: {
          ...process.env,
          STELLA_BROWSER_CONTROL_TOKEN: controlToken,
          STELLA_BROWSER_EXTENSION_PROXY_SESSION:
            STELLA_BROWSER_BRIDGE_SESSION,
          STELLA_BROWSER_EXTENSION_DELEGATE_TOKEN: extensionDelegateToken,
          STELLA_BROWSER_REQUIRED_OWNER_ID: input.ownerId,
          STELLA_BROWSER_REQUIRED_TURN_ID: input.turnId,
          STELLA_BROWSER_REQUIRED_OWNER_LEASE_ID: input.ownerLeaseId,
          STELLA_BROWSER_REQUIRED_OWNER_LEASE_ISSUED_AT: String(
            input.ownerLeaseIssuedAt,
          ),
          STELLA_BROWSER_CAPABILITY_EXPIRES_AT_MS: String(capabilityExpiresAt),
          STELLA_BROWSER_IDLE_TIMEOUT_MS: String(AGENT_DAEMON_IDLE_TIMEOUT_MS),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const backend: AgentBackendRecord = {
      ...input,
      bridgeSessionId,
      capabilityExpiresAt,
      controlToken,
      extensionDelegateToken,
      process: daemon,
    };
    daemon.stdout?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) console.debug("[stella-browser-agent]", message);
    });
    daemon.stderr?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) console.warn("[stella-browser-agent]", message);
    });
    const forgetBackend = () => {
      if (this.agentBackends.get(input.ownerId)?.process === daemon) {
        this.agentBackends.delete(input.ownerId);
      }
      void this.revokeAgentExtensionDelegate(backend).catch(() => undefined);
    };
    daemon.once("exit", forgetBackend);
    daemon.once("error", forgetBackend);

    try {
      await this.waitForAgentDaemonReady(backend);
      await this.registerAgentExtensionDelegate(backend);
      await this.sendCommandToSession(
        bridgeSessionId,
        {
          id: randomUUID(),
          action: "launch",
          cdpUrl: input.cdpUrl,
          controlToken,
          ownerId: input.ownerId,
          sessionId: input.ownerId,
          turnId: input.turnId,
          ownerLeaseId: input.ownerLeaseId,
          ownerLeaseIssuedAt: input.ownerLeaseIssuedAt,
        },
        COMMAND_TIMEOUT_MS,
      );
      return backend;
    } catch (error) {
      await stopChildProcessTree(daemon).catch(() => undefined);
      throw error;
    }
  }

  private async waitForAgentDaemonReady(backend: AgentBackendRecord) {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (backend.process.exitCode !== null) {
        throw new Error("Agent browser daemon exited before it became ready.");
      }
      try {
        await this.sendCommandToSession(
          backend.bridgeSessionId,
          {
            id: randomUUID(),
            action: "state_list",
            controlToken: backend.controlToken,
          },
          DAEMON_READY_PROBE_TIMEOUT_MS,
        );
        return;
      } catch {
        await delay(100);
      }
    }
    throw new Error("Agent browser daemon did not become ready in time.");
  }

  private async registerAgentExtensionDelegate(backend: AgentBackendRecord) {
    await this.sendCommand({
      id: randomUUID(),
      action: "extension_delegate_register",
      extensionDelegateToken: backend.extensionDelegateToken,
      ownerId: backend.ownerId,
      sessionId: backend.ownerId,
      turnId: backend.turnId,
      ownerLeaseId: backend.ownerLeaseId,
      ownerLeaseIssuedAt: backend.ownerLeaseIssuedAt,
      capabilityExpiresAt: backend.capabilityExpiresAt,
    });
  }

  private async revokeAgentExtensionDelegate(backend: AgentBackendRecord) {
    await this.sendCommand({
      id: randomUUID(),
      action: "extension_delegate_revoke",
      extensionDelegateToken: backend.extensionDelegateToken,
    });
  }

  private async stopAgentBackend(backend: AgentBackendRecord) {
    if (this.agentBackends.get(backend.ownerId)?.process === backend.process) {
      this.agentBackends.delete(backend.ownerId);
    }
    await this.revokeAgentExtensionDelegate(backend).catch(() => undefined);
    await Promise.race([
      this.sendCommandToSession(
        backend.bridgeSessionId,
        {
          id: randomUUID(),
          action: "close",
          controlToken: backend.controlToken,
        },
        1_000,
      ).catch(() => undefined),
      delay(1_100),
    ]).catch(() => undefined);
    if (!backend.process.killed && backend.process.exitCode === null) {
      await stopChildProcessTree(backend.process).catch(() => undefined);
    }
  }

  private resetCdpRouting() {
    this.cdpRoutingGeneration += 1;
    this.connectedCdpUrl = null;
    this.connectingCdp = null;
  }

  private async waitForDaemonReady() {
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.stopped) {
        throw new Error("Browser bridge startup cancelled.");
      }

      if (this.daemonProcess?.exitCode !== null) {
        throw new Error("Browser bridge daemon exited before it became ready.");
      }

      try {
        await this.sendCommand(
          {
            id: randomUUID(),
            action: "state_list",
          },
          DAEMON_READY_PROBE_TIMEOUT_MS,
        );
        return;
      } catch {
        await delay(100);
      }
    }

    throw new Error("Browser bridge daemon did not become ready in time.");
  }

  private async closeExistingSession() {
    const daemonPort = getPortForSession(STELLA_BROWSER_BRIDGE_SESSION);

    await this.sendCommand(
      {
        id: randomUUID(),
        action: "close",
      },
      1_500,
    ).catch(() => undefined);

    const daemonStopped = await this.waitForPortToClose(
      daemonPort,
      DAEMON_SHUTDOWN_TIMEOUT_MS,
    );
    if (!daemonStopped) {
      await this.killProcessListeningOnPort(daemonPort);
      await this.waitForPortToClose(daemonPort, DAEMON_SHUTDOWN_TIMEOUT_MS);
    }
    await this.stopOrphanedBundledDaemons();
  }

  private sendCommand(
    command: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<DaemonResponse> {
    return this.sendCommandToSession(
      STELLA_BROWSER_BRIDGE_SESSION,
      { ...command, controlToken: this.controlToken },
      timeoutMs,
    );
  }

  private async sendCommandToSession(
    session: string,
    command: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<DaemonResponse> {
    const socket = await this.openConnection(session);

    return await new Promise<DaemonResponse>((resolve, reject) => {
      let settled = false;
      let responseBuffer = "";

      const timeout = setTimeout(() => {
        settleReject(new Error("Timed out waiting for browser bridge daemon."));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
      };

      const settleResolve = (response: DaemonResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      socket.on("data", (chunk: Buffer | string) => {
        responseBuffer += String(chunk);
        const newlineIndex = responseBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const line = responseBuffer.slice(0, newlineIndex).trim();
        if (!line) {
          return;
        }

        try {
          const response = JSON.parse(line) as DaemonResponse;
          if (response.success === false) {
            settleReject(
              new Error(response.error || "Browser bridge command failed."),
            );
            return;
          }
          settleResolve(response);
        } catch (error) {
          settleReject(
            new Error(
              `Failed to parse browser bridge response: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });

      socket.once("error", (error) => {
        settleReject(
          new Error(`Failed to reach browser bridge daemon: ${error.message}`),
        );
      });

      socket.once("close", () => {
        if (!settled) {
          settleReject(
            new Error("Browser bridge daemon closed before replying."),
          );
        }
      });

      socket.write(`${JSON.stringify(command)}\n`);
    });
  }

  private async openConnection(
    session = STELLA_BROWSER_BRIDGE_SESSION,
  ): Promise<net.Socket> {
    const endpoint =
      process.platform === "win32"
        ? {
            port: getPortForSession(session),
            host: "127.0.0.1",
          }
        : { path: getSocketPath(session) };

    return await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      socket.once("connect", () => {
        socket.removeListener("error", rejectConnection);
        resolve(socket);
      });
      const rejectConnection = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", rejectConnection);
    });
  }

  /**
   * Open a long-lived subscription to unsolicited extension events (cookie
   * changes pushed in real time). `onEvent` is called for each event object
   * after the initial subscription ack. Auto-reconnects with capped backoff
   * while the daemon is reachable; the returned disposer stops reconnecting and
   * closes the socket. Best-effort: never throws to the caller, and a listener
   * error never tears down the stream.
   */
  subscribeToExtensionEvents(
    onEvent: (event: Record<string, unknown>) => void,
  ): () => void {
    let disposed = false;
    let socket: net.Socket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let backoffMs = 500;
    const MAX_BACKOFF_MS = 15_000;

    const scheduleReconnect = () => {
      if (disposed || this.stopped || reconnectTimer) {
        return;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, backoffMs);
      reconnectTimer.unref?.();
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };

    const connect = async () => {
      if (disposed || this.stopped) {
        return;
      }
      let next: net.Socket;
      try {
        next = await this.openConnection(STELLA_BROWSER_BRIDGE_SESSION);
      } catch {
        scheduleReconnect();
        return;
      }
      if (disposed || this.stopped) {
        next.destroy();
        return;
      }
      socket = next;
      let buffer = "";
      let acked = false;

      next.on("data", (chunk: Buffer | string) => {
        buffer += String(chunk);
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line) {
            continue;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!acked) {
            // First line is the subscription ack: the stream is healthy, so
            // reset backoff for the next reconnect.
            acked = true;
            backoffMs = 500;
            continue;
          }
          try {
            onEvent(parsed);
          } catch {
            // A listener error must never tear down the subscription.
          }
        }
      });

      const handleDrop = () => {
        if (socket === next) {
          socket = null;
        }
        next.removeAllListeners();
        next.destroy();
        scheduleReconnect();
      };
      next.once("error", handleDrop);
      next.once("close", handleDrop);

      next.write(
        `${JSON.stringify({
          id: randomUUID(),
          action: "subscribe_events",
          controlToken: this.controlToken,
        })}\n`,
      );
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
      }
    };
  }

  private async isTcpPortListening(
    port: number,
    timeoutMs = 250,
  ): Promise<boolean> {
    if (!Number.isFinite(port) || port <= 0) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      const settle = (listening: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        socket.destroy();
        resolve(listening);
      };
      const timeout = setTimeout(() => settle(false), timeoutMs);
      timeout.unref?.();
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  }

  private async killDaemonProcess() {
    if (!this.daemonProcess || this.daemonProcess.killed) {
      return;
    }
    await stopChildProcessTree(this.daemonProcess);
  }

  private async stopOrphanedBundledDaemons() {
    await stopOrphanedStellaBrowserDaemons();
  }

  private async getListeningProcessesForPort(port: number): Promise<number[]> {
    if (!Number.isFinite(port) || port <= 0) {
      return [];
    }

    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          },
        );

        return stdout
          .split(/\r?\n/)
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value) && value > 0);
      }

      const { stdout } = await execFileAsync(
        "lsof",
        ["-ti", `tcp:${port}`, "-s", "tcp:listen"],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        },
      );

      return stdout
        .split(/\r?\n/)
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    } catch {
      return [];
    }
  }

  private async waitForPortToClose(port: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;

    if (process.platform === "win32") {
      while (Date.now() < deadline) {
        if (!(await this.isTcpPortListening(port))) {
          return true;
        }
        await delay(150);
      }

      return !(await this.isTcpPortListening(port));
    }

    while (Date.now() < deadline) {
      if ((await this.getListeningProcessesForPort(port)).length === 0) {
        return true;
      }
      await delay(100);
    }

    return (await this.getListeningProcessesForPort(port)).length === 0;
  }

  private async killProcessListeningOnPort(port: number) {
    const pids = await this.getListeningProcessesForPort(port);

    for (const pid of pids) {
      if (process.platform === "win32") {
        try {
          await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
          });
          continue;
        } catch {
          // Fall through to a direct kill attempt below.
        }
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Best-effort cleanup for stale daemon listeners.
      }
    }
  }
}

const getSocketDir = getStellaBrowserSocketDir;

const requireCapabilityString = (value: string, name: string) => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.includes("\0")) {
    throw new Error(`${name} must be a non-empty capability string.`);
  }
  return normalized;
};

const requireCapabilityTimestamp = (value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ownerLeaseIssuedAt must be a positive integer.");
  }
  return value;
};

const agentBackendResult = (
  backend: AgentBackendRecord,
): StellaBrowserAgentBackend => ({
  bridgeSessionId: backend.bridgeSessionId,
  capabilityExpiresAt: backend.capabilityExpiresAt,
});

const getSocketPath = (session: string) =>
  path.join(getSocketDir(), `${session}.sock`);

/**
 * Per-browser user-data roots that hold installed extensions under
 * `<root>/<profile>/Extensions/<id>`. Mirrors the browser list in
 * register-stella-native-messaging-host's installUnix/Windows helpers.
 */
const getChromiumUserDataRoots = (): string[] => {
  const homedir = os.homedir();
  const plat = os.platform();
  if (plat === "darwin") {
    const appSupport = path.join(homedir, "Library", "Application Support");
    return [
      path.join(appSupport, "Google", "Chrome"),
      path.join(appSupport, "Microsoft Edge"),
      path.join(appSupport, "BraveSoftware", "Brave-Browser"),
      path.join(appSupport, "Chromium"),
    ];
  }
  if (plat === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() ||
      path.join(homedir, "AppData", "Local");
    return [
      path.join(localAppData, "Google", "Chrome", "User Data"),
      path.join(localAppData, "Microsoft", "Edge", "User Data"),
      path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      path.join(localAppData, "Chromium", "User Data"),
    ];
  }
  const cfg = path.join(homedir, ".config");
  return [
    path.join(cfg, "google-chrome"),
    path.join(cfg, "microsoft-edge"),
    path.join(cfg, "BraveSoftware", "Brave-Browser"),
    path.join(cfg, "chromium"),
  ];
};

export const isStellaBrowserBridgeBinaryInstalled = (): boolean => {
  try {
    const stellaBrowserRoot = resolveStellaBrowserRoot();
    activateStagedStellaBrowserBinary(stellaBrowserRoot);
    const binaryPath = resolveStellaBrowserBinaryPath(stellaBrowserRoot);
    return Boolean(binaryPath && existsSync(binaryPath));
  } catch {
    return false;
  }
};

/**
 * Cheap, synchronous scan (readdir + existsSync only — no process spawn, no
 * socket dial) for whether the Stella browser extension is installed in ANY
 * Chromium profile. We enumerate every profile directory under each user-data
 * root (Default, Profile N, and custom-named profiles) rather than a hardcoded
 * shortlist, so a user whose extension lives in "Profile 3" or a renamed
 * profile is still detected. (A fully custom `--user-data-dir` outside the
 * standard roots is the only remaining miss; that case is covered by the
 * on-demand start path in the browser IPC handlers.)
 */
export const isStellaExtensionInstalled = (): boolean => {
  for (const root of getChromiumUserDataRoots()) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // Root absent/unreadable — try the next browser.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        if (
          existsSync(
            path.join(
              root,
              entry.name,
              "Extensions",
              STELLA_BROWSER_EXTENSION_ID,
            ),
          )
        ) {
          return true;
        }
      } catch {
        // Ignore unreadable profile paths; keep probing the rest.
      }
    }
  }
  return false;
};

/**
 * Cheap, synchronous check for whether the eager app-ready bridge spawn is
 * worth it. Spawning the bridge daemon unconditionally on every launch starts
 * an extra Electron-as-Node process that, for users without the extension, only
 * ever retries with backoff (browser-bridge-resource onRetry) before failing —
 * pure startup cost for no benefit. We only eager-spawn when one of two signals
 * says the user actually uses browser automation:
 *   (a) the native-messaging host manifest already exists in the socket dir —
 *       written by registerStellaNativeMessagingHost on a prior successful
 *       launch, i.e. steady state once set up; or
 *   (b) the Stella extension directory is present in ANY Chromium profile —
 *       first-launch signal so the bridge still starts for users who DO have the
 *       extension but have never spawned the daemon (which is what registers the
 *       host). Otherwise the spawn is deferred to first real use (the browser
 *       IPC handlers start it on demand).
 */
export const isBrowserBridgeEagerStartWorthwhile = (): boolean => {
  try {
    const manifestPath = path.join(
      getSocketDir(),
      `${STELLA_NATIVE_MESSAGING_HOST_NAME}.json`,
    );
    if (existsSync(manifestPath)) {
      return true;
    }
  } catch {
    // existsSync only throws on pathological inputs; treat as "no signal".
  }

  return isStellaExtensionInstalled();
};

const getPortForSession = (session: string) => {
  let hash = 0;
  for (const char of session) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  const normalized = hash === -2147483648 ? 2147483648 : Math.abs(hash);
  return 49152 + (normalized % 16383);
};

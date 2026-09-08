import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { bin as bundledBin, install } from "cloudflared";
import { stopChildProcessTree } from "../../process-runtime.js";
import { probeBridgePublicHealth } from "./public-health.js";

/**
 * After cloudflared reports a registered connection we don't immediately trust
 * that the public hostname is routable — the Cloudflare edge can take a moment
 * to start routing to a freshly (re)connected connector. We probe the public
 * `/bridge/health` endpoint and advertise the tunnel URL only once it answers,
 * so the phone never receives a URL that isn't actually reachable. There is no
 * advertise-anyway fallback: an unreachable URL is worse than no URL because
 * the phone spends its whole connect budget on it.
 *
 * When the hostname stays unreachable past the repair threshold we ask the
 * backend to repair the tunnel's Cloudflare routing (the DNS record can be
 * missing or pointing at a stale tunnel, or the tunnel itself can be gone).
 * A repair that re-provisions the tunnel restarts cloudflared with the new
 * token; otherwise probing simply continues with backoff.
 */
const PUBLIC_READINESS_PROBE_TIMEOUT_MS = 2_000;
const PUBLIC_READINESS_RETRY_MIN_MS = 3_000;
const PUBLIC_READINESS_RETRY_MAX_MS = 15_000;
const PUBLIC_READINESS_REPAIR_AFTER_MS = 15_000;
const PUBLIC_READINESS_REPAIR_INTERVAL_MS = 60_000;
/** cloudflared must register a connector within this window or its token is presumed stale. */
const CONNECTOR_REGISTRATION_TIMEOUT_MS = 45_000;

export type TunnelPublicReadiness = "verified";

export type TunnelTokenResponse = {
  tunnelToken: string;
  hostname: string;
  repair?: { dnsRepaired: boolean; reprovisioned: boolean };
};

export type TunnelRepairOutcome =
  | "restarted"
  | "repaired"
  | "unchanged"
  | "failed";

export class CloudflareTunnelService {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private bridgePort: number | null = null;
  private started = false;
  private readinessStarted = false;
  private readinessGeneration = 0;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;
  private activeToken: { tunnelToken: string; hostname: string } | null = null;

  constructor(
    private readonly options: {
      getAuthToken: () => Promise<string | null>;
      getConvexSiteUrl: () => string | null;
      getDeviceId: () => string | null;
      /**
       * Writable directory the cloudflared binary is installed into. Required
       * in the packaged app: the `cloudflared` package resolves its default
       * binary path relative to its own bundled location, which lands inside
       * the read-only `app.asar`, so neither the existence check nor the
       * download can ever succeed there.
       */
      getCloudflaredBinDir?: () => string | null;
      onTunnelUrl: (
        url: string | null,
        readiness?: TunnelPublicReadiness,
      ) => void;
      onUnexpectedExit?: (error: string) => void;
    },
  ) {}

  setBridgePort(port: number) {
    this.bridgePort = port;
  }

  async start() {
    if (this.started || this.process) return;

    if (!this.bridgePort) {
      console.log("[cloudflare-tunnel] No bridge port set, skipping start");
      return;
    }

    this.started = true;

    const generation = ++this.readinessGeneration;
    try {
      const { tunnelToken, hostname } = await this.fetchTunnelToken();
      if (generation !== this.readinessGeneration || !this.started) return;
      this.activeToken = { tunnelToken, hostname };

      const cloudflaredBin = await this.ensureCloudflaredBinary();
      if (generation !== this.readinessGeneration || !this.started) return;

      console.log(
        `[cloudflare-tunnel] Starting tunnel to localhost:${this.bridgePort}`,
      );

      this.process = spawn(
        cloudflaredBin,
        [
          "tunnel",
          "run",
          "--url",
          `http://localhost:${this.bridgePort}`,
          "--token",
          tunnelToken,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      this.clearRegistrationTimer();
      this.registrationTimer = setTimeout(() => {
        this.registrationTimer = null;
        if (this.readinessStarted || !this.isGenerationActive(generation)) {
          return;
        }
        console.warn(
          `[cloudflare-tunnel] Connector did not register within ${CONNECTOR_REGISTRATION_TIMEOUT_MS}ms; asking the backend to repair the tunnel`,
        );
        void this.repairTunnelRouting(generation);
      }, CONNECTOR_REGISTRATION_TIMEOUT_MS);

      this.process.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        if (
          !this.readinessStarted &&
          line.includes("Registered tunnel connection")
        ) {
          this.readinessStarted = true;
          this.clearRegistrationTimer();
          console.log(
            "[cloudflare-tunnel] Connector registered; verifying public reachability",
          );
          void this.announceWhenReachable(`https://${hostname}`, generation);
        }
      });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          console.log(`[cloudflare-tunnel] ${line}`);
        }
      });

      this.process.on("exit", (code) => {
        const wasRunning = this.started;
        console.log(`[cloudflare-tunnel] Process exited with code ${code}`);
        this.process = null;
        this.started = false;
        this.readinessStarted = false;
        this.readinessGeneration += 1;
        this.clearRegistrationTimer();
        this.tunnelUrl = null;
        this.options.onTunnelUrl(null);

        if (!wasRunning) return;
        this.options.onUnexpectedExit?.(
          `Cloudflare tunnel exited with code ${code ?? 0}`,
        );
      });
    } catch (error) {
      this.started = false;
      console.error(
        "[cloudflare-tunnel] Failed to start:",
        (error as Error).message,
      );
      throw error;
    }
  }

  async stop() {
    this.started = false;
    this.readinessStarted = false;
    this.readinessGeneration += 1;
    this.clearRegistrationTimer();
    if (this.process) {
      await stopChildProcessTree(this.process);
      this.process = null;
    }
    this.tunnelUrl = null;
    this.options.onTunnelUrl(null);
  }

  /**
   * Resolve the cloudflared executable, downloading it on first use.
   *
   * The `cloudflared` package's default `bin` is computed from its own module
   * location. Once bundled into `main.js` that resolves to
   * `<app>/dist-electron/bin/cloudflared`, which in a packaged build lives
   * inside `app.asar` — a read-only archive with no `bin` directory. So the
   * default path can neither be found nor written, and every packaged desktop
   * fails here before the tunnel ever starts. Installing into an app-data
   * directory keeps the binary writable and lets it survive app updates.
   */
  private async ensureCloudflaredBinary(): Promise<string> {
    const binDir = this.options.getCloudflaredBinDir?.()?.trim();
    if (!binDir) {
      // No writable location configured — fall back to the package default so
      // unpackaged/dev runs keep working exactly as before.
      if (!fs.existsSync(bundledBin)) {
        console.log("[cloudflare-tunnel] Installing cloudflared binary...");
        await install(bundledBin);
      }
      return bundledBin;
    }

    const target = path.join(
      binDir,
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    if (fs.existsSync(target)) {
      return target;
    }

    // `install` writes straight to the target path and does not create parents.
    fs.mkdirSync(binDir, { recursive: true });
    console.log(`[cloudflare-tunnel] Installing cloudflared to ${target}...`);
    await install(target);
    if (process.platform !== "win32") {
      fs.chmodSync(target, 0o755);
    }
    return target;
  }

  private isGenerationActive(generation: number): boolean {
    return (
      this.started &&
      this.process !== null &&
      generation === this.readinessGeneration
    );
  }

  private clearRegistrationTimer() {
    if (this.registrationTimer) clearTimeout(this.registrationTimer);
    this.registrationTimer = null;
  }

  /**
   * Probe the public URL until it actually serves `/bridge/health`, then
   * advertise it. Never advertises an unreachable URL. Past the repair
   * threshold the backend is asked to reconcile the tunnel's DNS record and
   * existence; a re-provision restarts cloudflared and ends this loop.
   */
  private async announceWhenReachable(url: string, generation: number) {
    const startedAt = Date.now();
    let delayMs = PUBLIC_READINESS_RETRY_MIN_MS;
    let lastRepairAt = 0;
    let failures = 0;
    while (this.isGenerationActive(generation)) {
      const reachable = await probeBridgePublicHealth(
        url,
        PUBLIC_READINESS_PROBE_TIMEOUT_MS,
      );
      if (!this.isGenerationActive(generation)) return;
      if (reachable) {
        console.log(`[cloudflare-tunnel] Connected: ${url}`);
        this.tunnelUrl = url;
        this.options.onTunnelUrl(url, "verified");
        return;
      }
      failures += 1;
      const now = Date.now();
      if (
        now - startedAt >= PUBLIC_READINESS_REPAIR_AFTER_MS &&
        now - lastRepairAt >= PUBLIC_READINESS_REPAIR_INTERVAL_MS
      ) {
        lastRepairAt = now;
        console.warn(
          `[cloudflare-tunnel] Public URL unreachable after ${failures} probes; asking the backend to repair the tunnel: ${url}`,
        );
        const outcome = await this.repairTunnelRouting(generation);
        if (outcome === "restarted") return;
        if (!this.isGenerationActive(generation)) return;
        if (outcome === "repaired") {
          // The record was just (re)written; give the edge a fresh short cycle.
          delayMs = PUBLIC_READINESS_RETRY_MIN_MS;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, PUBLIC_READINESS_RETRY_MAX_MS);
    }
  }

  /**
   * Ask the backend to reconcile this desktop's tunnel with Cloudflare. If it
   * had to re-provision (or the credentials no longer match the running
   * connector), restart cloudflared with the fresh token.
   */
  private async repairTunnelRouting(
    generation: number,
  ): Promise<TunnelRepairOutcome> {
    let response: TunnelTokenResponse;
    try {
      response = await this.fetchTunnelToken({ repair: true });
    } catch (error) {
      console.warn(
        "[cloudflare-tunnel] Tunnel repair request failed:",
        (error as Error).message,
      );
      return "failed";
    }
    if (!this.isGenerationActive(generation)) return "failed";
    const credentialsChanged =
      !this.activeToken ||
      this.activeToken.tunnelToken !== response.tunnelToken ||
      this.activeToken.hostname !== response.hostname;
    if (response.repair?.reprovisioned || credentialsChanged) {
      console.warn(
        "[cloudflare-tunnel] Tunnel was re-provisioned; restarting connector with the new token",
      );
      await this.stop();
      await this.start();
      return "restarted";
    }
    if (response.repair?.dnsRepaired) {
      console.warn("[cloudflare-tunnel] Tunnel DNS record was repaired");
      return "repaired";
    }
    return "unchanged";
  }

  private async fetchTunnelToken(
    options: { repair?: boolean } = {},
  ): Promise<TunnelTokenResponse> {
    const siteUrl = this.options.getConvexSiteUrl();
    const token = await this.options.getAuthToken();

    if (!siteUrl || !token) {
      throw new Error("Missing site URL or auth token");
    }

    const deviceId = this.options.getDeviceId()?.trim();
    if (!deviceId) {
      throw new Error("Missing desktop device id for tunnel token");
    }

    const response = await fetch(
      `${siteUrl.replace(/\/+$/, "")}/api/mobile/desktop-bridge/tunnel-token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deviceId,
          ...(options.repair ? { repair: true } : {}),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Tunnel token request failed: ${response.status}`);
    }

    const body = (await response.json()) as Partial<TunnelTokenResponse>;
    if (
      typeof body.tunnelToken !== "string" ||
      !body.tunnelToken ||
      typeof body.hostname !== "string" ||
      !body.hostname
    ) {
      throw new Error("Tunnel token response was incomplete");
    }
    return {
      tunnelToken: body.tunnelToken,
      hostname: body.hostname,
      ...(body.repair &&
      typeof body.repair === "object" &&
      typeof body.repair.dnsRepaired === "boolean" &&
      typeof body.repair.reprovisioned === "boolean"
        ? { repair: body.repair }
        : {}),
    };
  }
}

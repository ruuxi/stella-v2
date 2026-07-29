import { createHash } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  computeRendererManifestSha256,
  RendererArtifactService,
  parseRendererArtifactManifest,
  type RendererArtifactRef,
} from "./renderer-artifact-service.js";

const ACTIVE_INTERIOR_QUERY = makeFunctionReference<
  "query",
  Record<string, never>,
  unknown
>("cloud_deployments:getMyActiveInteriorManifest");
const ROLLBACK_INTERIOR_MUTATION = makeFunctionReference<
  "mutation",
  { expectedRouteRevision: number },
  unknown
>("cloud_deployments:rollbackMyInteriorBuild");

const DEFAULT_CONNECTION_REFRESH_MS = 30_000;
const UNAUTHENTICATED_FALLBACK_DELAY_MS = 5_000;
const MAX_TRANSIENT_APPLY_RETRIES = 4;

class RejectedRendererCandidateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RejectedRendererCandidateError";
  }
}

export interface ActiveInteriorDeployment {
  deployableId: string;
  routeRevision: number;
  previousBuildId: string | null;
  build: {
    buildId: string;
    artifactPrefix: string;
    artifactManifestJson: string;
    manifestSha256: string;
    artifactDigest: string;
    artifactSizeBytes: number;
    bridgeAbi: number;
    minShellVersion: string;
  };
}

export interface RendererDeploymentSyncServiceOptions {
  artifactService: RendererArtifactService;
  getConvexUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  onArtifactActivated: (artifact: RendererArtifactRef) => Promise<void>;
  onArtifactRolledBack: () => Promise<void>;
  connectionRefreshMs?: number;
}

const requireString = (
  value: unknown,
  label: string,
  maxLength = 4_096,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

export const parseActiveInteriorDeployment = (
  input: unknown,
): ActiveInteriorDeployment | null => {
  if (input === null) return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("active interior deployment must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.routeRevision !== "number" ||
    !Number.isSafeInteger(value.routeRevision) ||
    value.routeRevision < 1
  ) {
    throw new Error("active interior route revision is invalid");
  }
  const buildValue = value.build;
  if (
    typeof buildValue !== "object" ||
    buildValue === null ||
    Array.isArray(buildValue)
  ) {
    throw new Error("active interior build is invalid");
  }
  const build = buildValue as Record<string, unknown>;
  const manifestJson = requireString(
    build.artifactManifestJson,
    "active interior manifest JSON",
    4 * 1024 * 1024,
  );
  const manifestSha256 = requireString(
    build.manifestSha256,
    "active interior manifest digest",
    80,
  );
  if (!/^sha256:[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error("active interior manifest digest is invalid");
  }
  const artifactDigest = requireString(
    build.artifactDigest,
    "active interior artifact digest",
    80,
  );
  if (!/^sha256:[0-9a-f]{64}$/.test(artifactDigest)) {
    throw new Error("active interior artifact digest is invalid");
  }
  if (
    typeof build.artifactSizeBytes !== "number" ||
    !Number.isSafeInteger(build.artifactSizeBytes) ||
    build.artifactSizeBytes < 0
  ) {
    throw new Error("active interior artifact size is invalid");
  }
  if (
    typeof build.bridgeAbi !== "number" ||
    !Number.isSafeInteger(build.bridgeAbi) ||
    build.bridgeAbi < 1
  ) {
    throw new Error("active interior bridge ABI is invalid");
  }
  return {
    deployableId: requireString(value.deployableId, "deployableId", 256),
    routeRevision: value.routeRevision,
    previousBuildId:
      value.previousBuildId === null
        ? null
        : requireString(value.previousBuildId, "previousBuildId", 256),
    build: {
      buildId: requireString(build.buildId, "buildId", 256),
      artifactPrefix: requireString(
        build.artifactPrefix,
        "artifactPrefix",
        512,
      ),
      artifactManifestJson: manifestJson,
      manifestSha256,
      artifactDigest,
      artifactSizeBytes: build.artifactSizeBytes,
      bridgeAbi: build.bridgeAbi,
      minShellVersion: requireString(
        build.minShellVersion,
        "minShellVersion",
        128,
      ),
    },
  };
};

const sanitizeConvexUrl = (value: string | null): string | null => {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const isLoopbackHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1");
    if (
      (parsed.protocol !== "https:" && !isLoopbackHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
};

const connectionFingerprint = (url: string, token: string): string =>
  createHash("sha256").update(url).update("\0").update(token).digest("hex");

export class RendererDeploymentSyncService {
  private client: ConvexClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private connectionFingerprint: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private applyQueue: Promise<void> = Promise.resolve();
  private refreshPromise: Promise<void> | null = null;
  private lastProcessedDeployment: string | null = null;
  private connectionGeneration = 0;
  private unauthenticatedFallbackTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = true;

  constructor(private readonly options: RendererDeploymentSyncServiceOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refreshConnection();
    const refreshMs =
      this.options.connectionRefreshMs ?? DEFAULT_CONNECTION_REFRESH_MS;
    this.refreshTimer = setInterval(() => {
      void this.refreshConnection();
    }, refreshMs);
    this.refreshTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearUnauthenticatedFallback();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.disconnect();
    await this.applyQueue.catch(() => undefined);
  }

  async refreshConnection(): Promise<void> {
    if (this.refreshPromise) {
      return await this.refreshPromise;
    }
    this.refreshPromise = this.refreshConnectionInternal();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refreshConnectionInternal(): Promise<void> {
    if (this.stopped) return;
    const convexUrl = sanitizeConvexUrl(this.options.getConvexUrl());
    const authToken = (
      await this.options.getAuthToken().catch(() => null)
    )?.trim();
    if (!convexUrl) {
      this.clearUnauthenticatedFallback();
      this.disconnect();
      return;
    }
    if (!authToken) {
      this.disconnect();
      this.scheduleUnauthenticatedFallback();
      return;
    }
    this.clearUnauthenticatedFallback();
    const nextFingerprint = connectionFingerprint(convexUrl, authToken);
    if (
      this.client &&
      this.unsubscribe &&
      this.connectionFingerprint === nextFingerprint
    ) {
      return;
    }

    this.disconnect();
    if (this.stopped) return;
    const client = new ConvexClient(convexUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
    client.setAuth(async () => {
      return (
        (await this.options.getAuthToken().catch(() => null))?.trim() || null
      );
    });
    const generation = ++this.connectionGeneration;
    const subscription = client.onUpdate(
      ACTIVE_INTERIOR_QUERY,
      {},
      (snapshot) => {
        if (
          this.stopped ||
          generation !== this.connectionGeneration ||
          this.client !== client
        ) {
          return;
        }
        this.enqueueDeployment(snapshot);
      },
      (error) => {
        console.warn(
          "[renderer-deployment] Active interior subscription failed:",
          error.message,
        );
      },
    );
    this.client = client;
    this.unsubscribe = () => subscription.unsubscribe();
    this.connectionFingerprint = nextFingerprint;
  }

  /**
   * Exposed for deterministic main-process tests and for a future one-shot
   * refresh path. Realtime subscriptions call the same serialized method.
   */
  async applyDeploymentSnapshot(snapshot: unknown): Promise<void> {
    let deployment: ActiveInteriorDeployment | null;
    try {
      deployment = parseActiveInteriorDeployment(snapshot);
    } catch (error) {
      const routeRevision =
        typeof snapshot === "object" &&
        snapshot !== null &&
        !Array.isArray(snapshot) &&
        typeof (snapshot as Record<string, unknown>).routeRevision ===
          "number" &&
        Number.isSafeInteger(
          (snapshot as Record<string, unknown>).routeRevision,
        ) &&
        ((snapshot as Record<string, unknown>).routeRevision as number) > 0
          ? ((snapshot as Record<string, unknown>).routeRevision as number)
          : null;
      if (
        routeRevision !== null &&
        (await this.rollbackControlPlane(routeRevision))
      ) {
        return;
      }
      throw error;
    }
    if (!deployment) {
      if (this.lastProcessedDeployment === "none") return;
      if (await this.options.artifactService.deactivateToBundled()) {
        await this.options.onArtifactRolledBack();
      }
      this.lastProcessedDeployment = "none";
      return;
    }
    const deploymentKey = `${deployment.deployableId}:${deployment.routeRevision}:${deployment.build.buildId}`;
    if (deploymentKey === this.lastProcessedDeployment) return;
    const accountScope = createHash("sha256")
      .update(deployment.deployableId)
      .digest("hex");

    let activated: RendererArtifactRef | null = null;
    try {
      let stateBefore = await this.options.artifactService.getState();
      if (stateBefore.active && stateBefore.accountScope !== accountScope) {
        await this.options.artifactService.deactivateToBundled();
        await this.options.onArtifactRolledBack();
        stateBefore = await this.options.artifactService.getState();
      }
      let manifest: ReturnType<typeof parseRendererArtifactManifest>;
      try {
        manifest = parseRendererArtifactManifest(
          JSON.parse(deployment.build.artifactManifestJson),
        );
      } catch (error) {
        throw new RejectedRendererCandidateError(
          "renderer manifest is invalid",
          { cause: error },
        );
      }
      if (manifest.buildId !== deployment.build.buildId) {
        throw new RejectedRendererCandidateError(
          "control-plane build ID does not match renderer manifest",
        );
      }
      if (
        `sha256:${manifest.artifactSha256}` !==
          deployment.build.artifactDigest ||
        manifest.size !== deployment.build.artifactSizeBytes ||
        manifest.bridgeAbi !== deployment.build.bridgeAbi ||
        manifest.minShellVersion !== deployment.build.minShellVersion ||
        manifest.artifactPrefix !== deployment.build.artifactPrefix
      ) {
        throw new RejectedRendererCandidateError(
          "control-plane artifact metadata does not match renderer manifest",
        );
      }
      const expectedArtifactSha256 = deployment.build.artifactDigest.slice(
        "sha256:".length,
      );
      const expectedManifestSha256 = deployment.build.manifestSha256.slice(
        "sha256:".length,
      );
      if (
        computeRendererManifestSha256(deployment.build.artifactManifestJson) !==
        expectedManifestSha256
      ) {
        throw new RejectedRendererCandidateError(
          "control-plane manifest digest does not match renderer manifest",
        );
      }
      if (
        await this.options.artifactService.isHealthyDeploymentInstalled({
          accountScope,
          artifactSha256: expectedArtifactSha256,
          manifestSha256: expectedManifestSha256,
        })
      ) {
        this.lastProcessedDeployment = deploymentKey;
        return;
      }
      const candidate = await this.options.artifactService.stage({
        manifestJson: deployment.build.artifactManifestJson,
        expectedManifestSha256: deployment.build.manifestSha256,
      });
      activated = await this.options.artifactService.activate(
        candidate.artifactSha256,
        accountScope,
      );

      await this.options.onArtifactActivated(activated);
      await this.options.artifactService.markHealthy(activated.artifactSha256);
      this.lastProcessedDeployment = deploymentKey;
      console.info(
        `[renderer-deployment] Activated interior ${activated.buildId} at route revision ${deployment.routeRevision}.`,
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "renderer activation failed";
      console.error(
        `[renderer-deployment] Failed to apply ${deployment.build.buildId}:`,
        error,
      );
      if (activated) {
        await this.options.artifactService
          .quarantine(activated.artifactSha256, reason.slice(0, 1_024))
          .catch((quarantineError) => {
            console.error(
              "[renderer-deployment] Failed to quarantine renderer artifact:",
              quarantineError,
            );
          });
        await this.options.onArtifactRolledBack().catch((rollbackError) => {
          console.error(
            "[renderer-deployment] Failed to reload renderer fallback:",
            rollbackError,
          );
        });
        if (await this.rollbackControlPlane(deployment.routeRevision)) {
          this.lastProcessedDeployment = deploymentKey;
          return;
        }
        throw error;
      }
      if (reason.includes("quarantined")) {
        if (await this.rollbackControlPlane(deployment.routeRevision)) {
          this.lastProcessedDeployment = deploymentKey;
          return;
        }
        throw error;
      }
      if (error instanceof RejectedRendererCandidateError) {
        if (await this.rollbackControlPlane(deployment.routeRevision)) {
          this.lastProcessedDeployment = deploymentKey;
          return;
        }
      }
      throw error;
    }
  }

  private enqueueDeployment(snapshot: unknown, attempt = 0): void {
    this.applyQueue = this.applyQueue
      .then(() => this.applyDeploymentSnapshot(snapshot))
      .catch((error) => {
        console.error(
          "[renderer-deployment] Unexpected deployment synchronization error:",
          error,
        );
        if (this.stopped || attempt >= MAX_TRANSIENT_APPLY_RETRIES) return;
        const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.enqueueDeployment(snapshot, attempt + 1);
        }, delayMs);
        timer.unref?.();
        this.retryTimers.add(timer);
      });
  }

  private scheduleUnauthenticatedFallback(): void {
    if (this.unauthenticatedFallbackTimer || this.stopped) return;
    this.unauthenticatedFallbackTimer = setTimeout(() => {
      this.unauthenticatedFallbackTimer = null;
      void this.options.artifactService
        .deactivateToBundled()
        .then(async (changed) => {
          if (!changed || this.stopped) return;
          this.lastProcessedDeployment = null;
          await this.options.onArtifactRolledBack();
        })
        .catch((error) => {
          console.error(
            "[renderer-deployment] Failed to clear personal renderer after sign-out:",
            error,
          );
        });
    }, UNAUTHENTICATED_FALLBACK_DELAY_MS);
    this.unauthenticatedFallbackTimer.unref?.();
  }

  private clearUnauthenticatedFallback(): void {
    if (!this.unauthenticatedFallbackTimer) return;
    clearTimeout(this.unauthenticatedFallbackTimer);
    this.unauthenticatedFallbackTimer = null;
  }

  private async rollbackControlPlane(
    expectedRouteRevision: number,
  ): Promise<boolean> {
    const client = this.client;
    if (!client) {
      console.warn(
        "[renderer-deployment] Could not roll back the control-plane route while offline.",
      );
      return false;
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await client.mutation(ROLLBACK_INTERIOR_MUTATION, {
          expectedRouteRevision,
        });
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500 * 2 ** attempt);
            timer.unref?.();
          });
        }
      }
    }
    console.error(
      "[renderer-deployment] Failed to roll back the quarantined control-plane route:",
      lastError,
    );
    return false;
  }

  private disconnect(): void {
    this.connectionGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const client = this.client;
    this.client = null;
    this.connectionFingerprint = null;
    if (client) {
      void client.close().catch(() => undefined);
    }
  }
}

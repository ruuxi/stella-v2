/**
 * A cloud pi agent's container: the owner's world materialized on the
 * container's disk, the attached tool host daemon serving the agent's file
 * and shell tools as the unprivileged tool user, the world synced and the
 * drive hydrated around every command, and what the agent's answer links
 * delivered when the work is done. One lease per agent conversation, booted
 * when the agent's run starts and released when its last run ends; every
 * file and shell tool call goes straight to it.
 *
 * The sandbox attachment is the general agents' own; this module gives it
 * what a BuildSession would: a session, a world, a broker credential (served
 * by the orchestrator object, `pi:<conversation>`) and a release. Every
 * record names the exact lease, so a lease an eviction dropped is found and
 * released when the harness opens again.
 */
import type { SerializedAgentToolResult } from "@stella/executor-cloud/attached-tool-protocol";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  attachedToolFingerprint,
  attachedToolPathsForDirectory,
  isAttachedToolName,
} from "@stella/executor-cloud/attached-tool-protocol";
import { executorSessionEnvironment } from "./executor-session-env.js";
import { normalizeToolWorkspaceRoot, turnBrokerCredentialsPath } from "./build-session/shared/keys.js";
import { sandboxClient, type ExecutionSession, type SandboxHandle } from "./sandbox-client.js";
import {
  issueTurnBrokerCredential,
  revokeTurnBrokerCredential,
  TURN_BROKER_MAX_TTL_MS,
  turnBrokerStorageKey,
  type TurnBrokerRecord,
} from "./turn-credential-broker.js";
import { startTurnExecution } from "./turn-cancellation.js";
import { issueWorldCapability } from "./world-capability.js";
import { worldMaterializationCommand } from "./world-materialization.js";
import { agentSandboxId, WORLD_ROOT, worldName } from "./workspace.js";

export type PiComputeEnv = Pick<
  Cloudflare.Env,
  "OWNER_GATES" | "WORLDS" | "BUILDER_SERVICE_SECRET"
> &
  Partial<Pick<Cloudflare.Env, "Sandbox" | "SANDBOX_IDLE_TIMEOUT_MS" | "CLOUD_BUILDER_PUBLIC_URL">>;

/** Whose agent this is. */
export type PiComputeOwner = { ownerId: string; ownerGeneration: string; conversationId: string };

/** Everything the lease does outside itself. */
export type PiComputeHost = {
  env: PiComputeEnv;
  storage: DurableObjectStorage;
  /** One of the owner's agent container slots for this sandbox, waited for. */
  takeSlot(owner: PiComputeOwner, sandboxId: string, signal: AbortSignal): Promise<void>;
  releaseSlot(owner: PiComputeOwner, sandboxId: string): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
};

/** The exact resources of one lease, kept until it is released. */
export type PiComputeRecord = {
  version: 1;
  owner: PiComputeOwner;
  turnId: string;
  attemptGeneration: number;
  sandboxId: string;
  sessionId: string;
  daemonDirectory: string;
};

/** One file or shell tool call for the agent's container. */
export type PiWorkspaceCall = { toolCallId: string; toolName: string; params: Record<string, unknown> };

export type PiComputeLease = {
  readonly record: PiComputeRecord;
  /** Settles when the container is up: the world on its disk and the daemon serving. */
  readonly ready: Promise<void>;
  /** Run one call in the container, once it is up. */
  call(call: PiWorkspaceCall): Promise<SerializedAgentToolResult>;
  /** Push the world, write the drive back and deliver what the answer links. */
  quiesce(linkedPaths: readonly string[]): Promise<{ deliveredFiles: readonly string[] }>;
  /** Let the container go: its daemon, session and slot. */
  release(): Promise<void>;
  /** When its broker and world credentials stop working. */
  readonly expiresAt: number;
  /** Stops anything still running on it. */
  abort(reason?: unknown): void;
};

/** The broker session every lease of a conversation presents: `pi:<conversation>`. */
export const piBrokerSessionId = (conversationId: string): string => `pi:${conversationId}`;

const generationKey = (agentConversationId: number) => `piComputeGen:${agentConversationId}`;
/** The lease of one agent conversation, while it holds resources. */
export const piComputeKey = (agentConversationId: number) => `piCompute:${agentConversationId}`;
/** Every agent's container is the small instance. */
const INSTANCE_SIZE = "small";

/** A credential's life, the most the broker and the world allow. */
const CREDENTIAL_TTL_MS = Math.min(TURN_BROKER_MAX_TTL_MS, 30 * 60_000);
/** A world materialization or one command, at most. */
const COMMAND_TIMEOUT_MS = 15 * 60_000;

const hex = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sandboxFor = (host: PiComputeHost, sandboxId: string, size: "small" | "large", world: string): SandboxHandle => {
  const namespace = host.env.Sandbox;
  if (!namespace) throw new Error("Cloud containers are not configured.");
  const idle = Number(host.env.SANDBOX_IDLE_TIMEOUT_MS);
  return sandboxClient(namespace, sandboxId, {
    size,
    workload: "world",
    ...(Number.isSafeInteger(idle) && idle > 0 ? { idleTimeoutMs: idle } : {}),
    world,
  });
};

/** This deployment's public origin: where a container reaches the world and the broker. */
const publicOrigin = (host: PiComputeHost): string => {
  const origin = host.env.CLOUD_BUILDER_PUBLIC_URL?.replace(/\/+$/u, "");
  if (!origin) throw new Error("Cloud containers are not configured.");
  return origin;
};

const quoted = (value: string) => `'${value.replace(/'/gu, `'"'"'`)}'`;

/**
 * Release one lease's resources by its record: the daemon's process group
 * and directory, its session, its slot, then the container (which snapshots
 * and stops, the warmest start for the owner's next agent). Each step is
 * best-effort; a container that is not running holds none of them.
 */
export const releasePiCompute = async (host: PiComputeHost, record: PiComputeRecord) => {
  await host.releaseSlot(record.owner, record.sandboxId).catch(() => undefined);
  const sandbox = sandboxFor(host, record.sandboxId, INSTANCE_SIZE, await worldName(record.owner.ownerId));
  const running = await sandbox
    .getState()
    .then((state) => state.status === "running")
    .catch(() => false);
  if (running) {
    const paths = attachedToolPathsForDirectory(record.daemonDirectory);
    const pid = await sandbox
      .exec(`cat -- ${quoted(paths.daemonPid)}`, { origin: "internal" })
      .then((result) => {
        if (!result.success) return undefined;
        const value = JSON.parse(result.stdout) as { pid?: unknown; pgid?: unknown };
        return Number.isSafeInteger(value.pid) && value.pid === value.pgid && Number(value.pid) > 1
          ? Number(value.pgid)
          : undefined;
      })
      .catch(() => undefined);
    if (pid !== undefined) {
      await sandbox.exec(`kill -TERM -- -${pid}`, { origin: "internal" }).catch(() => undefined);
      await scheduler.wait(500);
      await sandbox.exec(`kill -KILL -- -${pid}`, { origin: "internal" }).catch(() => undefined);
    }
    await sandbox.killProcess(`attached-daemon-${record.sessionId}`.slice(0, 64), "SIGKILL").catch(() => undefined);
    await sandbox.exec(`rm -rf -- ${quoted(record.daemonDirectory)}`, { origin: "internal" }).catch(() => undefined);
    await sandbox.deleteSession(record.sessionId).catch(() => undefined);
    await sandbox.release().catch(() => undefined);
  }
  const brokerKey = turnBrokerStorageKey(record);
  const broker = await host.storage.get<TurnBrokerRecord>(brokerKey);
  if (broker) await host.storage.put(brokerKey, revokeTurnBrokerCredential(broker, Date.now())).catch(() => undefined);
};

/**
 * Lease the container for one agent conversation: it starts coming up at
 * once, and `ready` settles when the world and the daemon are up.
 */
export const openPiComputeLease = async (
  host: PiComputeHost,
  args: { owner: PiComputeOwner; agentConversationId: number; threadId: string; turnId: string },
): Promise<PiComputeLease> => {
  const { owner, agentConversationId, threadId, turnId } = args;
  const attemptGeneration = ((await host.storage.get<number>(generationKey(agentConversationId))) ?? 0) + 1;
  await host.storage.put(generationKey(agentConversationId), attemptGeneration);
  const identity = { turnId, attemptGeneration };
  const hash = (await hex(`${turnId}:${attemptGeneration}`)).slice(0, 32);
  const record: PiComputeRecord = {
    version: 1,
    owner,
    turnId,
    attemptGeneration,
    // The thread's container, as before: one per agent, reused across its runs.
    sandboxId: await agentSandboxId(owner.ownerId, `pi:${owner.conversationId}:${threadId}`),
    sessionId: `pi-agent-${hash}`,
    daemonDirectory: attachedToolPathsForDirectory(`/workspace/attached/pi-${hash}-${attemptGeneration}`).directory,
  };
  await host.storage.put(piComputeKey(agentConversationId), record);
  const world = await worldName(owner.ownerId);
  // The lease runs as a supervised execution until it is released: its
  // signal is what a stop aborts, and what a slot wait and the attach watch.
  let released!: () => void;
  const held = new Promise<void>((resolve) => {
    released = resolve;
  });
  const execution = startTurnExecution({ work: async () => await held });
  const context = {
    cancellation: execution.cancellation,
    signal: execution.signal,
    assertActive: () => {
      execution.signal.throwIfAborted();
      if (execution.cancellation.aborted) throw new Error("This agent's workspace was released.");
    },
  };
  const expiresAt = Date.now() + CREDENTIAL_TTL_MS;
  let sandbox: SandboxHandle | undefined;

  const attachWorld = async (target: { sandboxId: string; sessionId: string }) => {
    const started = Date.now();
    await host.takeSlot(owner, target.sandboxId, execution.signal);
    sandbox = sandboxFor(host, target.sandboxId, INSTANCE_SIZE, world);
    const options = {
      id: target.sessionId,
      cwd: "/opt/stella",
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      env: executorSessionEnvironment(),
    };
    // A failed attach leaves its session behind; the retry owns the same id.
    const session: ExecutionSession = await sandbox.createSession(options).catch(async (error: unknown) => {
      if (!/already exists/iu.test(error instanceof Error ? error.message : String(error))) throw error;
      await sandbox!.deleteSession(target.sessionId).catch(() => undefined);
      return await sandbox!.createSession(options);
    });
    context.assertActive();
    const coldContainerStartMs = Date.now() - started;
    const restoring = Date.now();
    await normalizeToolWorkspaceRoot(session, WORLD_ROOT);
    // The disk is a projection of the owner's world: brought down whole here,
    // then kept in step by the daemon around every command.
    const head = await host.env.WORLDS.getByName(world).head();
    const capability = await issueWorldCapability({
      secret: host.env.BUILDER_SERVICE_SECRET,
      worldName: world,
      turnId,
      attemptGeneration,
      now: Date.now(),
      ttlMs: CREDENTIAL_TTL_MS,
    });
    const exportUrl = new URL(`${publicOrigin(host)}/internal/worlds/${world}/export`);
    exportUrl.searchParams.set("manifest", head.manifestId);
    const materialized = await session.exec(
      worldMaterializationCommand({ worldRoot: WORLD_ROOT, manifestId: head.manifestId, exportUrl: exportUrl.toString(), capability }),
      { origin: "internal", timeout: COMMAND_TIMEOUT_MS },
    );
    if (!materialized.success) throw new Error("Stella could not bring this world into the agent's workspace.");
    // Materialization replaces the world root, including the drive directory the daemon expects.
    await normalizeToolWorkspaceRoot(session, WORLD_ROOT);
    context.assertActive();
    host.log("pi_agent_world_attached", {
      threadId,
      turnId,
      attemptGeneration,
      revision: head.revision,
      ms: Date.now() - started,
    });
    return { session, coldContainerStartMs, restoreMs: Date.now() - restoring };
  };

  const prepareBrokerHandoff = async ({ session }: { session: ExecutionSession }) => {
    const brokerIdentity = {
      sessionId: piBrokerSessionId(owner.conversationId),
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      turnId,
      attemptGeneration,
    };
    const origin = publicOrigin(host);
    const issued = await issueTurnBrokerCredential({
      identity: brokerIdentity,
      endpoint: `${origin}/sessions/${encodeURIComponent(brokerIdentity.sessionId)}/turn-broker`,
      now: Date.now(),
      ttlMs: Math.max(1, expiresAt - Date.now()),
    });
    // Durable before the container can present it.
    await host.storage.put(turnBrokerStorageKey(brokerIdentity), issued.record);
    const credentialsPath = turnBrokerCredentialsPath("/workspace");
    await session.writeFile(credentialsPath, JSON.stringify(issued.handoff));
    const protectedHandoff = await session.exec(`chmod 600 ${credentialsPath}`);
    if (!protectedHandoff.success) throw new Error("Turn broker handoff could not be protected.");
    return {
      turnId,
      attemptGeneration,
      threadId,
      prompt: "",
      // The drive copy on a reused container is this agent's own earlier hydration.
      workspaceRestored: true,
      turnBroker: { credentialsPath },
      world: {
        origin,
        name: world,
        capability: await issueWorldCapability({
          secret: host.env.BUILDER_SERVICE_SECRET,
          worldName: world,
          turnId,
          attemptGeneration,
          now: Date.now(),
          ttlMs: Math.max(1, expiresAt - Date.now()),
        }),
      },
    };
  };

  const { createAgentSandboxAttachment } = await import("./agent-sandbox-attachment.js");
  const attachment = createAgentSandboxAttachment({
    context,
    attachWorld,
    prepareBrokerHandoff,
    startDaemon: async (command, options) => {
      if (!sandbox) throw new Error("The agent's container has not been attached.");
      return await sandbox.startProcess(command, {
        cwd: options.cwd,
        env: executorSessionEnvironment(),
        processId: options.processId,
      });
    },
    release: async () => await releasePiCompute(host, record),
    destroy: async (target) => {
      await host.releaseSlot(owner, target.sandboxId).catch(() => undefined);
      await sandboxFor(host, target.sandboxId, INSTANCE_SIZE, world)
        .destroy()
        .catch(() => undefined);
    },
    emitEvent: (kind, payload) => host.log("pi_agent_compute_event", { threadId, kind, payload }),
  });
  const target = {
    sandboxId: record.sandboxId,
    instanceSize: INSTANCE_SIZE,
    sessionId: record.sessionId,
    daemonDirectory: record.daemonDirectory,
  } as const;

  /** What the daemon noticed while it came up, said once with the first call's result. */
  let bootNotice: string | undefined;
  const ready = (async () => {
    await attachment.boot(target);
    const report = await attachment.control({ sandboxId: record.sandboxId, control: "boot_report", ...identity });
    if (report.status === "boot_report" && report.notices.length > 0) bootNotice = report.notices.join(" ");
  })();
  // A caller that needs the container hears why it did not come up.
  ready.catch(() => undefined);
  let quiesced: Promise<{ deliveredFiles: readonly string[] }> | undefined;
  let releasing: Promise<void> | undefined;

  const failure = (message: string): SerializedAgentToolResult => ({
    outcome: { kind: "error", message },
    details: null,
    authorizedImages: [],
  });

  return {
    record,
    ready,
    expiresAt,
    async call({ toolCallId, toolName, params }) {
      if (!isAttachedToolName(toolName)) return failure(`${toolName} is not a tool the workspace can run.`);
      await ready;
      context.assertActive();
      const response = await attachment.callTool({
        sandboxId: record.sandboxId,
        request: {
          version: ATTACHED_TOOL_PROTOCOL_VERSION,
          ...identity,
          toolCallId,
          fingerprint: await attachedToolFingerprint({ toolName, params }),
          toolName,
          params,
        },
      });
      if (response.status === "pending") {
        // The daemon is still running the call this replays; running it again could do it twice.
        return failure("That command is still running in the workspace. Wait for it before trying again.");
      }
      if (response.status !== "completed") return failure(response.error);
      const result = response.result;
      if (!bootNotice || result.outcome.kind !== "ok") return result;
      const notice = bootNotice;
      bootNotice = undefined;
      return { ...result, outcome: { kind: "ok", text: `${result.outcome.text}\n\n${notice}` } };
    },
    quiesce: (linkedPaths) =>
      (quiesced ??= (async () => {
        const response = await attachment.control({
          sandboxId: record.sandboxId,
          control: "quiesce",
          linkedPaths: [...linkedPaths],
          ...identity,
        });
        return { deliveredFiles: response.status === "quiesced" ? response.deliveredFiles : [] };
      })()),
    release: () => (releasing ??= attachment.release(target)),
    abort: (reason) => {
      void execution.interrupt(reason).catch(() => undefined);
      released();
    },
  };
};

/** Forget a released lease's records. */
export const forgetPiCompute = async (host: PiComputeHost, agentConversationId: number, record: PiComputeRecord) => {
  await host.storage.delete([piComputeKey(agentConversationId), turnBrokerStorageKey(record)]);
};

/**
 * The sandbox Durable Object. It owns one container through the Durable Object
 * scheduling policy: it chooses the image and instance size when it starts the
 * container, registers the egress intercept, and runs every command, file
 * operation, and background process itself through `ctx.container`.
 *
 * Callers never hold a container handle. `src/sandbox-client.ts` wraps the
 * stub in the session/process shapes the turn code uses.
 */
import {
  DirectoryBackup,
  Files,
  SandboxBackupError,
  SandboxFileError,
} from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { appBuildEgress, generalAgentEgress } from "./sandbox-egress-policy.js";
import {
  DEPENDENCY_BACKUP_DIR,
  DEPENDENCY_BACKUP_EXCLUDES,
  DEPENDENCY_BACKUP_MAX_BYTES,
  DEPENDENCY_FOREIGN_LIMIT,
  DEPENDENCY_PLACE_TOOL_HOME_SCRIPT,
  DEPENDENCY_PROBE_SCRIPT,
  DEPENDENCY_RESTORE_ROOT,
  DEPENDENCY_TRANSFER_TIMEOUT_MS,
  dependencyBackupPrefix,
  dependencyExcludeForPath,
  parseDependencyProbe,
  type StoredDependencyBackup,
} from "./sandbox-dependencies.js";
import type { Env } from "./build-session/shared/env.js";

export type SandboxInstanceSize = "small" | "large";
export type SandboxWorkloadKind = "world" | "app-build";

/** What a caller asks for when its call may need a running container. */
export type SandboxBoot = {
  size: SandboxInstanceSize;
  workload: SandboxWorkloadKind;
  idleTimeoutMs?: number;
};

export type SandboxExecRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type SandboxExecResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxProcessStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

export type SandboxProcessInfo = {
  id: string;
  status: SandboxProcessStatus;
  exitCode?: number;
};

export type SandboxSessionConfig = {
  id: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  commandTimeoutMs?: number;
};

/** A filesystem snapshot of this world's container and the image it came from. */
type StoredSnapshot = {
  id: string;
  size: number;
  image: string;
  takenAt: number;
};

export type SandboxState = {
  status: "running" | "stopped";
  size?: SandboxInstanceSize;
};

const INSTANCE: Record<SandboxInstanceSize, "standard-2" | "standard-4"> = {
  small: "standard-2",
  large: "standard-4",
};

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_IDLE_TIMEOUT_MS = 6 * 60 * 60_000;
const READY_DEADLINE_MS = 120_000;
const SESSION_PREFIX = "session:";
const PROCESS_ROOT = "/run/stella-processes";
const SNAPSHOT_KEY = "snapshot";
const SNAPSHOT_DUE_KEY = "snapshotDueAt";
const DEPENDENCY_BACKUP_KEY = "dependencyBackup";
/** Lets a released turn finish its last writes before the filesystem is frozen. */
const SNAPSHOT_DELAY_MS = 2_000;
/** The 0.12 SDK ran commands here unless a call named another directory. */
const DEFAULT_CWD = "/workspace";

/**
 * Commands no longer inherit an environment from a long-lived session shell,
 * and `exec()` inherits only PATH from `start()`. Every command gets this base.
 */
const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/root",
  LANG: "C.UTF-8",
  DEBIAN_FRONTEND: "noninteractive",
});

const SIGNALS: Record<string, string> = {
  SIGKILL: "KILL",
  SIGTERM: "TERM",
  SIGINT: "INT",
  SIGHUP: "HUP",
};

const resolvedIdleTimeoutMs = (boot: SandboxBoot): number =>
  Math.min(
    MAX_IDLE_TIMEOUT_MS,
    boot.idleTimeoutMs && boot.idleTimeoutMs > 0
      ? boot.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS,
  );

// Runs the command in its own process group so a kill reaches its children.
// The group leader records its pid and then becomes the command; output goes
// to files so the process outlives the request that started it.
const RUN_SCRIPT = `dir=$1; shift
setsid -w bash -c 'echo "$$" >"$0/pid"; exec "$@"' "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

const STATUS_SCRIPT = `dir=$1
[ -d "$dir" ] || { echo missing; exit 0; }
if [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif [ -e "$dir/killed" ] && [ -e "$dir/pid" ] && ! kill -0 "$(cat "$dir/pid")" 2>/dev/null; then echo killed
elif [ ! -e "$dir/pid" ]; then echo starting
elif kill -0 "$(cat "$dir/pid")" 2>/dev/null; then echo "running $(cat "$dir/pid")"
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
else echo lost
fi`;

const WAIT_FOR_EXIT_SCRIPT = `dir=$1
while [ ! -e "$dir/exit-code" ]; do
  if [ -e "$dir/pid" ] && ! kill -0 "$(cat "$dir/pid")" 2>/dev/null && [ ! -e "$dir/exit-code" ]; then echo lost; exit 0; fi
  sleep 0.1
done
cat "$dir/exit-code"`;

const KILL_SCRIPT = `dir=$1; signal=$2
[ -e "$dir/pid" ] || exit 3
pid=$(cat "$dir/pid")
kill -0 "$pid" 2>/dev/null || exit 3
: >"$dir/killed"
kill -s "$signal" -- "-$pid" 2>/dev/null || kill -s "$signal" "$pid"`;

const decoder = new TextDecoder();

const cleanEnv = (
  ...layers: Array<Record<string, string | undefined> | undefined>
): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
  }
  return merged;
};

const timeoutArgv = (timeoutMs: number | undefined): string[] =>
  typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? ["timeout", "-k", "5", `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`]
    : [];

const processDirectory = (id: string): string => {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id)) {
    throw new TypeError(`Invalid sandbox process id: ${id}`);
  }
  return `${PROCESS_ROOT}/${id}`;
};

const statusFromLine = (
  id: string,
  line: string,
): SandboxProcessInfo | null => {
  const [state, value] = line.trim().split(" ");
  switch (state) {
    case "missing":
      return null;
    case "starting":
      return { id, status: "starting" };
    case "running":
      return { id, status: "running" };
    case "killed":
      return { id, status: "killed", exitCode: 137 };
    case "exited": {
      const exitCode = Number(value);
      if (!Number.isSafeInteger(exitCode)) return { id, status: "error" };
      return {
        id,
        status:
          exitCode === 0 ? "completed" : exitCode > 128 ? "killed" : "failed",
        exitCode,
      };
    }
    default:
      return { id, status: "error" };
  }
};

const base64ToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

type EgressProps = { containerId: string; policy: "general" | "sealed" };

/**
 * Receives every plain-HTTP request a sandbox container sends and applies the
 * workload's policy. HTTPS and other ports are decided by `enableInternet`.
 */
export class SandboxEgress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const { containerId, policy } = this.ctx.props;
    return policy === "sealed"
      ? await appBuildEgress(request)
      : await generalAgentEgress(request, this.env, { containerId });
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class Sandbox extends DurableObject<Env> {
  #booting: Promise<void> | null = null;
  #files?: Files;
  #dependencies?: DirectoryBackup;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A restarted object that finds its container running re-arms the
    // inactivity timeout and the intercept, which a deploy may have dropped.
    if (ctx.container?.running) {
      const boot = ctx.storage.kv.get<SandboxBoot>("boot");
      if (boot) {
        this.#booting = this.#configure(boot).catch(() => {
          this.#booting = null;
        });
      }
    }
  }

  get #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The sandbox container is not configured.");
    return container;
  }

  get #fs(): Files {
    this.#files ??= new Files(this.#container);
    return this.#files;
  }

  /** This world's caches and dependencies archive (`sandbox-dependencies.ts`). */
  get #dependencyBackups(): DirectoryBackup {
    this.#dependencies ??= new DirectoryBackup(
      this.#container,
      this.ctx.exports.DirectoryBackupGateway,
      {
        binding: "BACKUP_BUCKET",
        prefix: dependencyBackupPrefix(this.ctx.id.toString()),
      },
    );
    return this.#dependencies;
  }

  async #configure(boot: SandboxBoot): Promise<void> {
    const container = this.#container;
    const policy = boot.workload === "app-build" ? "sealed" : "general";
    // The archive's own host must be registered before the catch-all, which
    // takes every hostname registered after it.
    await this.#dependencyBackups.intercept();
    await container.interceptAllOutboundHttp(
      this.ctx.exports.SandboxEgress({
        props: { containerId: this.ctx.id.toString(), policy },
      }),
    );
    await container.setInactivityTimeout(resolvedIdleTimeoutMs(boot));
  }

  /**
   * A container that is already running was started with the idle timeout of
   * whoever started it. A prewarm starts it with a short one so an unused
   * prewarm releases its capacity quickly; the turn that then attaches asks for
   * the full one and must get it. Only ever lengthens: a prewarm arriving while
   * a turn holds the container cannot shorten that turn's window.
   */
  async #extendIdleTimeout(boot: SandboxBoot): Promise<void> {
    const stored = this.ctx.storage.kv.get<SandboxBoot>("boot");
    const next = resolvedIdleTimeoutMs(boot);
    const current = stored
      ? resolvedIdleTimeoutMs(stored)
      : DEFAULT_IDLE_TIMEOUT_MS;
    if (current >= next) return;
    this.ctx.storage.kv.put("boot", {
      ...(stored ?? boot),
      idleTimeoutMs: next,
    });
    await this.#container.setInactivityTimeout(next);
  }

  get #snapshotsEnabled(): boolean {
    return this.env.SANDBOX_SNAPSHOTS === "1";
  }

  /**
   * Start from this world's last snapshot when it was taken on the image this
   * deploy runs, so the world projection, native state, and caches are already
   * on disk. A snapshot cannot cross images; any other case starts clean, with
   * the world's caches and dependencies brought back from their archive.
   */
  async #start(boot: SandboxBoot): Promise<void> {
    const container = this.#container;
    const image = container.images.sandbox!;
    const stored = this.#snapshotsEnabled
      ? this.ctx.storage.kv.get<StoredSnapshot>(SNAPSHOT_KEY)
      : undefined;
    const snapshot = stored?.image === image ? stored : undefined;
    const startedAt = Date.now();
    let restored = false;
    if (snapshot) {
      try {
        await this.#boot(boot, { containerSnapshot: { id: snapshot.id } });
        restored = true;
      } catch (error) {
        this.ctx.storage.kv.delete(SNAPSHOT_KEY);
        console.log(
          JSON.stringify({
            level: "error",
            event: "sandbox_snapshot_restore_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (!restored) await this.#boot(boot, { image });
    if (restored) {
      // Process records belong to the container that wrote them.
      await this.#run(["rm", "-rf", "--", PROCESS_ROOT]);
    } else if (boot.workload === "world") {
      await this.#restoreDependencies();
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "sandbox_container_started",
        workload: boot.workload,
        instanceSize: boot.size,
        source: restored ? "snapshot" : "image",
        ...(stored && !snapshot ? { snapshotSkipped: "image_changed" } : {}),
        readyMs: Date.now() - startedAt,
      }),
    );
  }

  async #boot(
    boot: SandboxBoot,
    from: { image: string } | { containerSnapshot: { id: string } },
  ): Promise<void> {
    const container = this.#container;
    const startedAt = Date.now();
    container.start({
      ...from,
      instance: INSTANCE[boot.size],
      enableInternet: boot.workload !== "app-build",
      labels: { service: "stella-v2", workload: boot.workload, size: boot.size },
    } as ContainerStartupOptions);
    this.ctx.storage.kv.put("boot", boot);
    try {
      await this.#configure(boot);
      // `start()` returns before the container accepts commands.
      let delayMs = 25;
      while (true) {
        try {
          const probe = await container.exec(["true"]);
          if ((await probe.exitCode) === 0) break;
        } catch (error) {
          if (Date.now() - startedAt > READY_DEADLINE_MS) throw error;
        }
        if (Date.now() - startedAt > READY_DEADLINE_MS) {
          throw new Error("The sandbox container did not become ready.");
        }
        await scheduler.wait(delayMs);
        delayMs = Math.min(500, delayMs * 2);
      }
    } catch (error) {
      await container.destroy().catch(() => undefined);
      throw error;
    }
  }

  async #ensure(boot: SandboxBoot): Promise<void> {
    if (this.#booting) {
      await this.#booting;
      if (this.#container.running) {
        await this.#extendIdleTimeout(boot);
        return;
      }
    }
    if (this.#container.running) {
      await this.#extendIdleTimeout(boot);
      return;
    }
    this.#booting = this.#start(boot).finally(() => {
      this.#booting = null;
    });
    await this.#booting;
  }

  async #run(
    argv: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<SandboxExecResult> {
    const process = await this.#container.exec(argv, {
      cwd: options.cwd ?? "/",
      env: cleanEnv(BASE_ENV, options.env),
    });
    const output = await process.output();
    return {
      success: output.exitCode === 0,
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  // ---- lifecycle ---------------------------------------------------------

  async state(): Promise<SandboxState> {
    if (!this.ctx.container?.running) return { status: "stopped" };
    const boot = this.ctx.storage.kv.get<SandboxBoot>("boot");
    return { status: "running", ...(boot ? { size: boot.size } : {}) };
  }

  async ensure(boot: SandboxBoot): Promise<SandboxState> {
    await this.#ensure(boot);
    return await this.state();
  }

  /**
   * Stop the container. Unless the caller is only resizing it, also forget the
   * snapshot so the next start cannot bring back the state being discarded.
   * The platform has no snapshot delete; an unreferenced one expires in 30 days.
   */
  async destroy(options: { keepSnapshot?: boolean } = {}): Promise<void> {
    if (!options.keepSnapshot) {
      this.ctx.storage.kv.delete(SNAPSHOT_KEY);
      this.ctx.storage.kv.delete(SNAPSHOT_DUE_KEY);
    }
    if (this.#booting) await this.#booting.catch(() => undefined);
    if (this.ctx.container?.running) {
      await this.#container.destroy();
    }
  }

  /**
   * Owner purge: discard the container, its snapshot and its caches and
   * dependencies archive, so neither a later start nor a later archive can
   * bring any of it back. The caller sweeps the archive prefix afterwards.
   */
  async purge(): Promise<void> {
    await this.destroy();
    const stored = this.ctx.storage.kv.get<StoredDependencyBackup>(
      DEPENDENCY_BACKUP_KEY,
    );
    this.ctx.storage.kv.delete(DEPENDENCY_BACKUP_KEY);
    if (stored) await this.#dependencyBackups.delete(stored.record);
  }

  /**
   * Ask for a snapshot, and for the caches and dependencies archive to catch
   * up, once the turn using the container has let go of it. The alarm does
   * both, so the caller's turn never waits on either.
   */
  async requestSnapshot(): Promise<void> {
    if (!this.ctx.container?.running) return;
    const due = Date.now() + SNAPSHOT_DELAY_MS;
    this.ctx.storage.kv.put(SNAPSHOT_DUE_KEY, due);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    // 0.12 left an alarm armed while its container ran; that one finds no key.
    const due = this.ctx.storage.kv.get<number>(SNAPSHOT_DUE_KEY);
    if (due === undefined) return;
    if (due > Date.now()) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    this.ctx.storage.kv.delete(SNAPSHOT_DUE_KEY);
    if (this.#booting) await this.#booting.catch(() => undefined);
    const container = this.ctx.container;
    if (!container?.running) return;
    try {
      if (this.#snapshotsEnabled) {
        const startedAt = Date.now();
        const info = await container.inspect();
        const snapshot = await container.snapshotContainer({
          name: "stella-world",
        });
        const stored: StoredSnapshot = {
          id: snapshot.id,
          size: snapshot.size,
          image: info?.image ?? container.images.sandbox!,
          takenAt: Date.now(),
        };
        this.ctx.storage.kv.put(SNAPSHOT_KEY, stored);
        console.log(
          JSON.stringify({
            level: "info",
            event: "sandbox_snapshot_taken",
            sizeBytes: snapshot.size,
            snapshotMs: Date.now() - startedAt,
          }),
        );
      }
    } finally {
      await this.#backupDependencies();
    }
  }

  /**
   * Bring the world's caches and dependencies back into a container that just
   * started from the image. Never fails the start: without the archive the
   * container is only slower.
   */
  async #restoreDependencies(): Promise<void> {
    const stored = this.ctx.storage.kv.get<StoredDependencyBackup>(
      DEPENDENCY_BACKUP_KEY,
    );
    if (!stored) return;
    const startedAt = Date.now();
    try {
      await this.#run(["rm", "-rf", "--", DEPENDENCY_RESTORE_ROOT]);
      await this.#dependencyBackups.restore(stored.record, {
        dir: DEPENDENCY_RESTORE_ROOT,
        signal: AbortSignal.timeout(DEPENDENCY_TRANSFER_TIMEOUT_MS),
      });
      const placed = await this.#run([
        "bash",
        "-c",
        DEPENDENCY_PLACE_TOOL_HOME_SCRIPT,
      ]);
      if (!placed.success) {
        throw new Error(placed.stderr.trim().slice(-500) || "placement failed");
      }
      console.log(
        JSON.stringify({
          level: "info",
          event: "sandbox_dependencies_restored",
          sizeBytes: stored.record.size,
          sourceBytes: stored.bytes,
          restoreMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      // An archive that is gone or altered can never restore; a transfer
      // failure may be transient, so that record is kept for the next start.
      if (
        SandboxBackupError.is(error) &&
        (error.code === "BACKUP_NOT_FOUND" || error.code === "BACKUP_INTEGRITY")
      ) {
        this.ctx.storage.kv.delete(DEPENDENCY_BACKUP_KEY);
      }
      await this.#run(["rm", "-rf", "--", DEPENDENCY_RESTORE_ROOT]).catch(
        () => undefined,
      );
      console.log(
        JSON.stringify({
          level: "error",
          event: "sandbox_dependencies_restore_failed",
          restoreMs: Date.now() - startedAt,
          message: errorText(error),
        }),
      );
    }
  }

  /**
   * Archive the tool home and the world's `node_modules` when anything in them
   * changed since the last archive and the whole is under the cap. A skipped or
   * failed archive keeps the previous one.
   */
  async #backupDependencies(): Promise<void> {
    if (this.ctx.storage.kv.get<SandboxBoot>("boot")?.workload !== "world") {
      return;
    }
    const previous = this.ctx.storage.kv.get<StoredDependencyBackup>(
      DEPENDENCY_BACKUP_KEY,
    );
    const startedAt = Date.now();
    const skipped = (reason: string, fields: Record<string, unknown> = {}) =>
      console.log(
        JSON.stringify({
          level: "info",
          event: "sandbox_dependencies_backup_skipped",
          reason,
          ...fields,
          probeMs: Date.now() - startedAt,
        }),
      );
    try {
      const result = await this.#run(
        [
          "bash",
          "-c",
          DEPENDENCY_PROBE_SCRIPT,
          "probe",
          String(previous?.mark ?? 0),
          previous?.fingerprint ?? "",
        ],
        { cwd: DEPENDENCY_BACKUP_DIR },
      );
      const probe = parseDependencyProbe(result.stdout);
      if (!probe) {
        throw new Error(
          result.stderr.trim().slice(-500) || "the probe printed no result",
        );
      }
      if (probe.state !== "changed") return skipped(probe.state);
      if (probe.bytes > DEPENDENCY_BACKUP_MAX_BYTES) {
        return skipped("over_cap", {
          sourceBytes: probe.bytes,
          capBytes: DEPENDENCY_BACKUP_MAX_BYTES,
        });
      }
      const foreign = probe.foreign.map(dependencyExcludeForPath);
      if (
        probe.foreign.length > DEPENDENCY_FOREIGN_LIMIT ||
        foreign.some((pattern) => pattern === null)
      ) {
        return skipped("foreign_files", { foreignCount: probe.foreign.length });
      }
      const archiveStartedAt = Date.now();
      const record = await this.#dependencyBackups.backup({
        dir: DEPENDENCY_BACKUP_DIR,
        name: "stella-dependencies",
        exclude: [...DEPENDENCY_BACKUP_EXCLUDES, ...(foreign as string[])],
        signal: AbortSignal.timeout(DEPENDENCY_TRANSFER_TIMEOUT_MS),
      });
      this.ctx.storage.kv.put(DEPENDENCY_BACKUP_KEY, {
        record,
        fingerprint: probe.fingerprint,
        mark: probe.now,
        bytes: probe.bytes,
        takenAt: Date.now(),
      } satisfies StoredDependencyBackup);
      if (previous) {
        await this.#dependencyBackups
          .delete(previous.record)
          .catch(() => undefined);
      }
      console.log(
        JSON.stringify({
          level: "info",
          event: "sandbox_dependencies_backed_up",
          sizeBytes: record.size,
          sourceBytes: probe.bytes,
          excludedForeign: probe.foreign.length,
          probeMs: archiveStartedAt - startedAt,
          backupMs: Date.now() - archiveStartedAt,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          level: "error",
          event: "sandbox_dependencies_backup_failed",
          backupMs: Date.now() - startedAt,
          message: errorText(error),
        }),
      );
    }
  }

  // ---- sessions ----------------------------------------------------------

  async putSession(config: SandboxSessionConfig): Promise<void> {
    this.ctx.storage.kv.put(`${SESSION_PREFIX}${config.id}`, config);
  }

  async getSession(id: string): Promise<SandboxSessionConfig | null> {
    return this.ctx.storage.kv.get<SandboxSessionConfig>(
      `${SESSION_PREFIX}${id}`,
    ) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`${SESSION_PREFIX}${id}`);
  }

  // ---- commands ----------------------------------------------------------

  async exec(
    boot: SandboxBoot,
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult> {
    await this.#ensure(boot);
    return await this.#run(
      [...timeoutArgv(request.timeoutMs), "bash", "-c", request.command],
      { cwd: request.cwd ?? DEFAULT_CWD, env: cleanEnv(request.env) },
    );
  }

  // ---- files -------------------------------------------------------------

  async readFile(
    boot: SandboxBoot,
    path: string,
    encoding: "base64" | "utf-8" | "none" = "utf-8",
  ): Promise<
    | { success: true; encoding: "base64" | "utf-8"; content: string; size: number }
    | { success: true; encoding: "none"; content: ReadableStream; size: number }
  > {
    await this.#ensure(boot);
    const stat = await this.#fs.stat(path);
    const response = await this.#fs.readFile(path);
    const size = Number(stat.size);
    if (encoding === "none") {
      return { success: true, encoding, content: response.body!, size };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      success: true,
      encoding,
      content: encoding === "base64" ? bytesToBase64(bytes) : decoder.decode(bytes),
      size,
    };
  }

  async writeFile(
    boot: SandboxBoot,
    path: string,
    content: string | ReadableStream<Uint8Array>,
    encoding: "base64" | "utf-8" = "utf-8",
  ): Promise<{ success: true }> {
    await this.#ensure(boot);
    const bytes =
      typeof content === "string" && encoding === "base64"
        ? base64ToBytes(content)
        : content;
    try {
      await this.#fs.writeFile(path, bytes);
    } catch (error) {
      // 0.12 created missing parents. The destination opens before a stream
      // is read, so a stream body is still unread when this retries.
      if (!SandboxFileError.is(error) || error.code !== "ENOENT") throw error;
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      await this.#fs.mkdir(parent, { recursive: true });
      await this.#fs.writeFile(path, bytes);
    }
    return { success: true };
  }

  async deleteFile(boot: SandboxBoot, path: string): Promise<{ success: true }> {
    await this.#ensure(boot);
    await this.#fs.remove(path);
    return { success: true };
  }

  async mkdir(
    boot: SandboxBoot,
    path: string,
    recursive: boolean,
  ): Promise<{ success: true }> {
    await this.#ensure(boot);
    await this.#fs.mkdir(path, { recursive });
    return { success: true };
  }

  async exists(boot: SandboxBoot, path: string): Promise<boolean> {
    await this.#ensure(boot);
    try {
      await this.#fs.lstat(path);
      return true;
    } catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  // ---- background processes ---------------------------------------------

  async startProcess(
    boot: SandboxBoot,
    request: SandboxExecRequest & { processId: string },
  ): Promise<SandboxProcessInfo> {
    await this.#ensure(boot);
    const dir = processDirectory(request.processId);
    const existing = await this.getProcess(request.processId);
    if (existing && (existing.status === "running" || existing.status === "starting")) {
      throw new Error(`Sandbox process ${request.processId} is already running.`);
    }
    await this.#run(["rm", "-rf", "--", dir]);
    await this.#fs.mkdir(dir, { recursive: true });
    await this.#container.exec(
      [
        "bash",
        "-c",
        RUN_SCRIPT,
        "run",
        dir,
        ...timeoutArgv(request.timeoutMs),
        "bash",
        "-c",
        request.command,
      ],
      {
        cwd: request.cwd ?? DEFAULT_CWD,
        env: cleanEnv(BASE_ENV, request.env),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return { id: request.processId, status: "running" };
  }

  async getProcess(id: string): Promise<SandboxProcessInfo | null> {
    // A stopped container took every process with it, most often by running
    // out of memory; 137 is what the OOM handling recognizes.
    if (!this.ctx.container?.running) {
      return { id, status: "killed", exitCode: 137 };
    }
    const result = await this.#run([
      "bash",
      "-c",
      STATUS_SCRIPT,
      "status",
      processDirectory(id),
    ]);
    return statusFromLine(id, result.stdout);
  }

  async processLogs(id: string): Promise<{ stdout: string; stderr: string }> {
    if (!this.ctx.container?.running) return { stdout: "", stderr: "" };
    const dir = processDirectory(id);
    const read = async (name: string) => {
      try {
        return await (await this.#fs.readFile(`${dir}/${name}`)).text();
      } catch (error) {
        if (SandboxFileError.is(error) && error.code === "ENOENT") return "";
        throw error;
      }
    };
    const [stdout, stderr] = await Promise.all([
      read("stdout.log"),
      read("stderr.log"),
    ]);
    return { stdout, stderr };
  }

  async waitForExit(
    id: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number }> {
    if (!this.ctx.container?.running) {
      throw new Error(`Sandbox process ${id} is not running.`);
    }
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    const process = await this.#container.exec(
      ["bash", "-c", WAIT_FOR_EXIT_SCRIPT, "wait", processDirectory(id)],
      { signal, env: { ...BASE_ENV } },
    );
    const output = await process.output();
    if (signal.aborted) {
      throw new Error(`Sandbox process ${id} did not exit in time.`);
    }
    const value = decoder.decode(output.stdout).trim();
    if (value === "lost") return { exitCode: 137 };
    const exitCode = Number(value);
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error(`Sandbox process ${id} reported no exit code.`);
    }
    return { exitCode };
  }

  async killProcess(id: string, signal = "SIGTERM"): Promise<boolean> {
    if (!this.ctx.container?.running) return false;
    const name = SIGNALS[signal] ?? signal.replace(/^SIG/u, "");
    const result = await this.#run([
      "bash",
      "-c",
      KILL_SCRIPT,
      "kill",
      processDirectory(id),
      name,
    ]);
    return result.exitCode === 0;
  }
}

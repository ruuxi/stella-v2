import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type {
  UserAppProjectDescriptor,
  UserAppProjectListResult,
  UserAppProjectStartResult,
  UserAppProjectStatus,
  UserAppProjectStopResult,
} from "@stella/contracts/user-app-projects";

const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROCESS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Port map keys are either a bare slug (the frontend) or `slug:<qualifier>`.
const PORT_MAP_KEY_RE = /^[a-z][a-z0-9-]{0,31}(?::[a-z][a-z0-9-]{0,64})?$/;
const MANIFEST_FILE = "stella.app.json";
const PACKAGE_FILE = "package.json";
const PORT_MAP_FILE = ".stella-app-ports.json";
const PORT_RANGE_START = 41_000;
const PORT_RANGE_SIZE = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const READINESS_TIMEOUT_MS = 30_000;
const PROCESS_READINESS_DELAY_MS = 250;
const STOP_GRACE_MS = 1_500;
const RESTART_BACKOFF_MS = 2_000;
const WATCH_DEBOUNCE_MS = 100;
const MAX_SUPERVISED_PROCESSES = 8;

type ProjectProcessReadiness =
  | { type: "http"; path: string; timeoutMs: number }
  | { type: "tcp"; timeoutMs: number }
  | { type: "process"; delayMs: number };

type ProjectProcess = {
  id: string;
  command: string;
  args: string[];
  port: "auto" | null;
  ports: Array<{ id: string; protocol: "tcp" | "udp" }>;
  readiness: ProjectProcessReadiness;
};

type ProjectRuntime = {
  frontend: string;
  processes: ProjectProcess[];
};

type ProjectPackage = {
  scripts: Record<string, string>;
  dependencyNames: Set<string>;
};

type ProjectManifest = {
  schemaVersion: 1;
  slug: string;
  name: string;
  createdAt: string;
  runtime: ProjectRuntime | null;
};

type DiscoveredProject = UserAppProjectDescriptor & {
  projectPath: string;
  runtime: ProjectRuntime | null;
  package: ProjectPackage;
};

type RuntimeEntry = {
  project: DiscoveredProject;
  children: Map<string, ChildProcess>;
  installChild: ChildProcess | null;
  status: UserAppProjectStatus;
  url: string | null;
  error: string | null;
  desiredRunning: boolean;
  startPromise: Promise<UserAppProjectStartResult> | null;
  stopPromise: Promise<void> | null;
  recoveryPromise: Promise<void> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Bumped on every launch, stop, and crash recovery. A supervised process set
   * outlives the async step that started it, so exits from an abandoned
   * generation must not tear down the set that replaced it. The generation
   * captured at launch is the only way to tell the two apart.
   */
  generation: number;
};

export type UserAppProjectServiceOptions = {
  workspacePath: string;
  onChanged?: () => void;
  executablePath?: string;
};

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref?.();
  });

const isPathInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const readRegularFile = async (filePath: string): Promise<string> => {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${path.basename(filePath)} must be a regular file.`);
  }
  return await fs.readFile(filePath, "utf8");
};

const readinessSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    path: z
      .string()
      .regex(
        /^\/(?!\/)[^\s\\]*$/,
        "HTTP readiness path must be a loopback-relative path.",
      )
      .default("/"),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(READINESS_TIMEOUT_MS),
  }),
  z.object({
    type: z.literal("tcp"),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(READINESS_TIMEOUT_MS),
  }),
  z.object({
    type: z.literal("process"),
    delayMs: z
      .number()
      .int()
      .min(50)
      .max(10_000)
      .default(PROCESS_READINESS_DELAY_MS),
  }),
]);

const processSchema = z
  .object({
    id: z.string().regex(PROCESS_ID_RE, "Process id must be a lowercase slug."),
    command: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !value.includes("\0"), {
        message: "Process command must not contain NUL bytes.",
      }),
    args: z
      .array(
        z
          .string()
          .max(4_096)
          .refine((value) => !value.includes("\0"), {
            message: "Process arguments must not contain NUL bytes.",
          }),
      )
      .max(128)
      .default([]),
    port: z.literal("auto").optional(),
    ports: z
      .array(
        z.object({
          id: z
            .string()
            .regex(PROCESS_ID_RE, "Named port id must be a lowercase slug."),
          protocol: z.enum(["tcp", "udp"]),
        }),
      )
      .max(MAX_SUPERVISED_PROCESSES)
      .default([]),
    readiness: readinessSchema.optional(),
  })
  .superRefine((process, context) => {
    const portIds = new Set<string>();
    for (const [index, port] of process.ports.entries()) {
      if (portIds.has(port.id)) {
        context.addIssue({
          code: "custom",
          path: ["ports", index, "id"],
          message: `Named port id ${port.id} is duplicated.`,
        });
      }
      portIds.add(port.id);
    }
    if (
      process.readiness &&
      process.readiness.type !== "process" &&
      process.port !== "auto"
    ) {
      context.addIssue({
        code: "custom",
        path: ["port"],
        message: "HTTP and TCP readiness require port to be auto.",
      });
    }
  });

const runtimeSchema = z
  .object({
    frontend: z
      .string()
      .regex(PROCESS_ID_RE, "Runtime frontend must name a process id."),
    processes: z.array(processSchema).min(1).max(MAX_SUPERVISED_PROCESSES),
  })
  .superRefine((runtime, context) => {
    const ids = new Set<string>();
    // Two processes whose ids differ only by `-` versus `_` would publish
    // their ports under one environment name and silently shadow each other,
    // so the collision is rejected at parse time rather than at spawn time.
    const portEnvironmentNames = new Set<string>();
    for (const [index, process] of runtime.processes.entries()) {
      if (ids.has(process.id)) {
        context.addIssue({
          code: "custom",
          path: ["processes", index, "id"],
          message: `Runtime process id ${process.id} is duplicated.`,
        });
      }
      ids.add(process.id);
      if (process.port === "auto") {
        const environmentName = process.id.toUpperCase().replaceAll("-", "_");
        if (portEnvironmentNames.has(environmentName)) {
          context.addIssue({
            code: "custom",
            path: ["processes", index, "port"],
            message: `Runtime ports produce a duplicate environment name: STELLA_APP_PORT_${environmentName}.`,
          });
        }
        portEnvironmentNames.add(environmentName);
      }
      for (const port of process.ports) {
        const environmentName = `${process.id}_${port.id}`
          .toUpperCase()
          .replaceAll("-", "_");
        if (portEnvironmentNames.has(environmentName)) {
          context.addIssue({
            code: "custom",
            path: ["processes", index, "ports"],
            message: `Runtime ports produce a duplicate environment name: STELLA_APP_PORT_${environmentName}.`,
          });
        }
        portEnvironmentNames.add(environmentName);
      }
    }
    const frontend = runtime.processes.find(
      (process) => process.id === runtime.frontend,
    );
    if (!frontend) {
      context.addIssue({
        code: "custom",
        path: ["frontend"],
        message: "Runtime frontend must name one declared process.",
      });
    } else if (frontend.port !== "auto") {
      context.addIssue({
        code: "custom",
        path: ["processes"],
        message: "Runtime frontend process must declare port as auto.",
      });
    } else if (frontend.readiness?.type === "process") {
      // The frontend's port is embedded in the Apps sidebar the moment the
      // launch resolves, so a delay-only readiness check would hand the
      // renderer a URL that nothing is listening on yet.
      context.addIssue({
        code: "custom",
        path: ["processes"],
        message: "Runtime frontend process must use HTTP or TCP readiness.",
      });
    }
  });

const buildManifestSchema = (expectedSlug: string) =>
  z.object(
    {
      schemaVersion: z.literal(1, {
        error: `${MANIFEST_FILE} schemaVersion must be 1.`,
      }),
      slug: z.custom<string>((value) => value === expectedSlug, {
        message: `${MANIFEST_FILE} slug must match its directory.`,
      }),
      name: z
        .string({ error: `${MANIFEST_FILE} name must be 1-120 characters.` })
        .trim()
        .min(1, `${MANIFEST_FILE} name must be 1-120 characters.`)
        .max(120, `${MANIFEST_FILE} name must be 1-120 characters.`),
      createdAt: z
        .string({
          error: `${MANIFEST_FILE} createdAt must be an ISO date string.`,
        })
        .trim()
        .refine(
          (value) => Number.isFinite(Date.parse(value)),
          `${MANIFEST_FILE} createdAt must be an ISO date string.`,
        ),
      runtime: runtimeSchema.optional(),
    },
    { error: `${MANIFEST_FILE} schemaVersion must be 1.` },
  );

const parseManifest = (raw: string, expectedSlug: string): ProjectManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON.`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${MANIFEST_FILE} must contain an object.`);
  }
  const parsed = buildManifestSchema(expectedSlug).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? `${MANIFEST_FILE} is invalid.`,
    );
  }
  return {
    schemaVersion: 1,
    slug: expectedSlug,
    name: parsed.data.name,
    createdAt: parsed.data.createdAt,
    runtime: parsed.data.runtime
      ? {
          frontend: parsed.data.runtime.frontend,
          processes: parsed.data.runtime.processes.map((process) => ({
            id: process.id,
            command: process.command,
            args: process.args,
            port: process.port ?? null,
            ports: process.ports,
            readiness:
              process.readiness ??
              (process.port === "auto"
                ? { type: "tcp" as const, timeoutMs: READINESS_TIMEOUT_MS }
                : {
                    type: "process" as const,
                    delayMs: PROCESS_READINESS_DELAY_MS,
                  }),
          })),
        }
      : null,
  };
};

const FRONTEND_COMMAND_RE =
  /(?:^|[\s"'])(?:bunx\s+|bun\s+x\s+|npx\s+)?(?:vite|next(?:\s+dev)?|astro\s+dev|remix\s+dev|webpack(?:-dev-server)?|react-scripts\s+start)(?=$|[\s"'])/i;
const FRONTEND_SCRIPT_RE = /(?:^|:)(?:web|frontend|client|ui)(?:$|:)/i;
/**
 * Only dev-server scripts are candidates for the frontend process. Lifecycle
 * scripts invoke the same tools (`"build": "tsc --noEmit && vite build"`,
 * `"preview": "vite preview"`) and would otherwise read as a second frontend,
 * which makes even the default scaffold ambiguous against its own dev script.
 */
const DEV_SCRIPT_RE = /^(?:dev|start)(?:[:-]|$)|[:-](?:dev|start)$/i;
const SIBLING_SCRIPT_RE =
  /^(?:dev|start):(?:api|server|backend|worker|workers|job|jobs|queue|livekit|realtime|socket|db|database)(?::|$)|^(?:api|server|backend|worker|workers|job|jobs|queue|livekit|realtime|socket|db|database):(?:dev|start)$/i;
const WORKER_SCRIPT_RE = /(?:^|:)(?:worker|workers|job|jobs|queue)(?:$|:)/i;
const AGGREGATE_COMMAND_RE =
  /(?:^|[\s"'])(?:concurrently|npm-run-all|run-p|turbo\s+dev|nx\s+(?:run-many|affected)|bun\s+run\s+--parallel)(?=$|[\s"'])|(?:^|[\s"'])(?:node|bun)\s+(?:\.\/)?scripts\/(?:dev|start)\.[cm]?[jt]s(?=$|[\s"'])/i;
const BACKEND_COMMAND_RE =
  /(?:^|[\s"'])(?:(?:node|bun|tsx?|nodemon)\b[^\n]*\b(?:api|backend|server)[./_\w-]*|(?:convex|wrangler)\s+dev)(?=$|[\s"'])/i;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const referencesScript = (command: string, scriptName: string) =>
  new RegExp(
    `(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?${escapeRegExp(scriptName)}(?=$|[\\s"'])`,
    "i",
  ).test(command);

const automaticScriptProcess = (
  scriptName: string,
  id: string,
  kind: "frontend" | "server" | "worker",
  scriptCommand: string,
  aggregate = false,
): ProjectProcess => ({
  id,
  command: "bun",
  // A bare Vite dev server picks its own port and host, so the allocated port
  // is forced through. An aggregate script forwards nothing, and a non-Vite
  // frontend has its own flags, so both are left to read PORT instead.
  args:
    kind === "frontend" &&
    !aggregate &&
    /(?:^|\s)vite(?:\s|$)/i.test(scriptCommand)
      ? [
          "run",
          scriptName,
          "--",
          "--host",
          "127.0.0.1",
          "--port",
          "${PORT}",
          "--strictPort",
        ]
      : ["run", scriptName],
  port: kind === "worker" ? null : "auto",
  ports: [],
  readiness:
    kind === "worker"
      ? { type: "process", delayMs: PROCESS_READINESS_DELAY_MS }
      : { type: "tcp", timeoutMs: READINESS_TIMEOUT_MS },
});

const processIdForScript = (scriptName: string): string => {
  const normalized = scriptName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (
    normalized.match(/^[a-z]/) ? normalized : `process-${normalized}`
  ).slice(0, 32);
};

/**
 * Derive the supervised process set from ordinary package scripts, so an app
 * only needs a Stella-specific `runtime` declaration for a topology that
 * cannot be read off its own conventions.
 */
export const detectUserAppRuntime = (
  scripts: Record<string, string>,
  dependencyNames: ReadonlySet<string> = new Set(),
): ProjectRuntime => {
  const entries = Object.entries(scripts).filter(
    ([name, command]) =>
      name.length > 0 && typeof command === "string" && command.trim(),
  );
  if (entries.length === 0) {
    if (dependencyNames.size > 0 && !dependencyNames.has("vite")) {
      throw new Error(
        "No standard frontend dev script was found. Add an ordinary package.json dev script.",
      );
    }
    return {
      frontend: "frontend",
      processes: [
        {
          id: "frontend",
          command: "bun",
          args: [
            "x",
            "vite",
            "--host",
            "127.0.0.1",
            "--port",
            "${PORT}",
            "--strictPort",
          ],
          port: "auto",
          ports: [],
          readiness: { type: "tcp", timeoutMs: READINESS_TIMEOUT_MS },
        },
      ],
    };
  }

  const devCommand = scripts.dev?.trim();
  const siblingNames = entries
    .map(([name]) => name)
    .filter((name) => name !== "dev" && SIBLING_SCRIPT_RE.test(name));
  const namedFrontendCandidates = entries
    .filter(
      ([name, command]) =>
        name !== "dev" &&
        DEV_SCRIPT_RE.test(name) &&
        (FRONTEND_SCRIPT_RE.test(name) || FRONTEND_COMMAND_RE.test(command)),
    )
    .map(([name]) => name);
  const referencedNames = devCommand
    ? entries
        .map(([name]) => name)
        .filter((name) => name !== "dev" && referencesScript(devCommand, name))
    : [];
  // A dev script that merely fans out to scripts we can identify is worth
  // splitting: supervising the children individually gives per-process
  // readiness and a real process tree to stop. An aggregate we cannot see
  // through stays a single opaque child instead, or its children would run
  // twice.
  const splitAggregate =
    namedFrontendCandidates.length === 1 &&
    siblingNames.length > 0 &&
    referencedNames.includes(namedFrontendCandidates[0]!) &&
    siblingNames.every((name) => referencedNames.includes(name));
  const aggregate =
    !!devCommand &&
    !splitAggregate &&
    (AGGREGATE_COMMAND_RE.test(devCommand) ||
      siblingNames.some((name) => referencesScript(devCommand, name)));
  if (aggregate) {
    return {
      frontend: "frontend",
      processes: [
        automaticScriptProcess("dev", "frontend", "frontend", devCommand, true),
      ],
    };
  }

  let frontendScript: string;
  let devIsBackend = false;
  if (devCommand && FRONTEND_COMMAND_RE.test(devCommand)) {
    if (namedFrontendCandidates.length > 0) {
      throw new Error(
        `Frontend discovery is ambiguous between dev and ${namedFrontendCandidates.join(", ")}. Make dev own the full process set or use the optional manifest runtime override.`,
      );
    }
    frontendScript = "dev";
  } else if (devCommand && splitAggregate) {
    frontendScript = namedFrontendCandidates[0]!;
  } else if (devCommand) {
    if (
      namedFrontendCandidates.length === 1 &&
      BACKEND_COMMAND_RE.test(devCommand)
    ) {
      devIsBackend = true;
      frontendScript = namedFrontendCandidates[0]!;
    } else if (namedFrontendCandidates.length > 0) {
      throw new Error(
        `The dev script does not clearly own frontend script ${namedFrontendCandidates.join(", ")}. Make dev the ordinary aggregate command or use the optional manifest runtime override.`,
      );
    } else {
      frontendScript = "dev";
    }
  } else if (namedFrontendCandidates.length === 1) {
    frontendScript = namedFrontendCandidates[0]!;
  } else if (namedFrontendCandidates.length === 0) {
    throw new Error(
      "No usable frontend dev script was found. Add a standard dev, dev:web, or dev:frontend package script.",
    );
  } else {
    throw new Error(
      `Frontend discovery is ambiguous between ${namedFrontendCandidates.join(", ")}. Add one ordinary aggregate dev script or use the optional manifest runtime override.`,
    );
  }

  const auxiliaryNames = [
    ...(devIsBackend ? ["dev"] : []),
    ...siblingNames.filter((name) => name !== frontendScript),
  ];
  const ids = new Set<string>(["frontend"]);
  // Auxiliaries come first so the frontend starts against listening backends.
  const processes = auxiliaryNames.map((scriptName) => {
    const id = processIdForScript(scriptName);
    if (ids.has(id)) {
      throw new Error(
        `Process discovery produced duplicate id ${id}. Rename the package scripts or use the optional manifest runtime override.`,
      );
    }
    ids.add(id);
    return automaticScriptProcess(
      scriptName,
      id,
      WORKER_SCRIPT_RE.test(scriptName) ? "worker" : "server",
      scripts[scriptName]!,
    );
  });
  processes.push(
    automaticScriptProcess(
      frontendScript,
      "frontend",
      "frontend",
      scripts[frontendScript]!,
    ),
  );
  if (processes.length > MAX_SUPERVISED_PROCESSES) {
    throw new Error(
      `Process discovery found ${processes.length} dev scripts, above the ${MAX_SUPERVISED_PROCESSES} process limit. Use the optional manifest runtime override.`,
    );
  }
  return { frontend: "frontend", processes };
};

const killProcessTree = async (child: ChildProcess): Promise<void> => {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  // Signalling the group rather than the child is what reaches grandchildren
  // (a dev script's own spawned tools), and the group outliving the direct
  // child is why liveness is polled instead of awaiting its exit event.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const groupExists = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupExists() && Date.now() < deadline) {
    await sleep(25);
  }
  if (!groupExists()) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group exited after the final check.
  }
};

export class UserAppProjectService {
  readonly appsRoot: string;
  private entries = new Map<string, RuntimeEntry>();
  private watcher: FSWatcher | null = null;
  private projectWatchers = new Map<string, FSWatcher>();
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private portMap = new Map<string, number>();
  private portMapLoaded = false;
  private portAllocationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: UserAppProjectServiceOptions) {
    this.appsRoot = path.join(path.resolve(options.workspacePath), "apps");
  }

  /**
   * User apps are hosted by child processes owned by this worker. Keep the
   * worker alive while one is starting, running, stopping, recovering, or
   * awaiting a scheduled restart; otherwise detached-worker idle shutdown
   * tears down a healthy app moments after the start RPC returns.
   */
  hasActiveWork(): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.startPromise ||
        entry.stopPromise ||
        entry.recoveryPromise ||
        entry.restartTimer ||
        entry.status === "installing" ||
        entry.status === "starting" ||
        entry.status === "stopping" ||
        (entry.status === "running" && entry.desiredRunning)
      ) {
        return true;
      }
    }
    return false;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.appsRoot, { recursive: true, mode: 0o700 });
    await this.loadPortMap();
    if (this.watcher) return;
    await this.refreshProjectWatchers();
    this.watcher = watch(
      this.appsRoot,
      { persistent: false },
      (_event, fileName) => {
        const changedName = fileName?.toString() ?? "";
        if (
          changedName === PORT_MAP_FILE ||
          changedName.startsWith(`${PORT_MAP_FILE}.`)
        ) {
          return;
        }
        this.scheduleChanged(true);
      },
    );
    this.watcher.on("error", () => {
      this.watcher?.close();
      this.watcher = null;
    });
  }

  async list(): Promise<UserAppProjectListResult> {
    await fs.mkdir(this.appsRoot, { recursive: true, mode: 0o700 });
    const dirents = await fs.readdir(this.appsRoot, { withFileTypes: true });
    await this.refreshProjectWatchers(dirents);
    const apps: UserAppProjectDescriptor[] = [];
    for (const dirent of dirents) {
      if (
        !dirent.isDirectory() ||
        dirent.isSymbolicLink() ||
        !SLUG_RE.test(dirent.name)
      ) {
        continue;
      }
      try {
        const project = await this.resolveProject(dirent.name);
        const runtime = this.entries.get(project.slug);
        apps.push({
          slug: project.slug,
          meta: project.meta,
          status: runtime?.status ?? "stopped",
        });
      } catch {
        // Invalid or incomplete projects are not exposed to the renderer.
      }
    }
    apps.sort((a, b) => a.slug.localeCompare(b.slug));
    return { apps };
  }

  async startProject(slug: string): Promise<UserAppProjectStartResult> {
    this.assertSlug(slug);
    if (this.shuttingDown) {
      return {
        slug,
        url: null,
        status: "error",
        error: "App service is stopping.",
      };
    }
    const project = await this.resolveProject(slug);
    const existing = this.entries.get(slug);
    if (existing?.status === "running" && existing.url) {
      existing.desiredRunning = true;
      return { slug, url: existing.url, status: "running" };
    }
    if (existing?.stopPromise) {
      await existing.stopPromise;
      return await this.startProject(slug);
    }
    if (existing?.recoveryPromise) {
      await existing.recoveryPromise;
      return await this.startProject(slug);
    }
    if (existing?.startPromise) return await existing.startPromise;

    const entry: RuntimeEntry = existing ?? {
      project,
      children: new Map(),
      installChild: null,
      status: "stopped",
      url: null,
      error: null,
      desiredRunning: true,
      startPromise: null,
      stopPromise: null,
      recoveryPromise: null,
      restartTimer: null,
      generation: 0,
    };
    entry.project = project;
    entry.desiredRunning = true;
    entry.error = null;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
    this.entries.set(slug, entry);
    const promise = this.launch(entry);
    entry.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (entry.startPromise === promise) entry.startPromise = null;
    }
  }

  async stopProject(slug: string): Promise<UserAppProjectStopResult> {
    this.assertSlug(slug);
    await this.stopEntry(slug);
    return { slug, status: "stopped" };
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return await this.shutdownPromise;
    const promise = (async () => {
      this.shuttingDown = true;
      this.watcher?.close();
      this.watcher = null;
      for (const watcher of this.projectWatchers.values()) watcher.close();
      this.projectWatchers.clear();
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = null;
      await Promise.all(
        [...this.entries.keys()].map((slug) => this.stopEntry(slug)),
      );
    })();
    this.shutdownPromise = promise;
    await promise;
  }

  private assertSlug(slug: string) {
    if (!SLUG_RE.test(slug)) throw new Error("Invalid app slug.");
  }

  private scheduleChanged(refreshWatchers = false) {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const notify = () => this.options.onChanged?.();
      if (refreshWatchers) {
        void this.refreshProjectWatchers().finally(notify);
      } else {
        notify();
      }
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  private async refreshProjectWatchers(knownDirents?: Dirent[]): Promise<void> {
    if (this.shuttingDown) return;
    const dirents =
      knownDirents ??
      (await fs.readdir(this.appsRoot, { withFileTypes: true }));
    const desired = new Set(
      dirents
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            SLUG_RE.test(entry.name),
        )
        .map((entry) => entry.name),
    );
    await Promise.all(
      [...this.entries.keys()]
        .filter((slug) => !desired.has(slug))
        .map((slug) => this.stopEntry(slug)),
    );
    for (const [slug, watcher] of this.projectWatchers) {
      if (desired.has(slug)) continue;
      watcher.close();
      this.projectWatchers.delete(slug);
    }
    for (const slug of desired) {
      if (this.projectWatchers.has(slug)) continue;
      try {
        const watcher = watch(
          path.join(this.appsRoot, slug),
          { persistent: false },
          () => {
            this.scheduleChanged(false);
          },
        );
        watcher.on("error", () => {
          watcher.close();
          if (this.projectWatchers.get(slug) === watcher) {
            this.projectWatchers.delete(slug);
          }
        });
        this.projectWatchers.set(slug, watcher);
      } catch {
        // The project may have disappeared between readdir and watch.
      }
    }
  }

  private async resolveProject(slug: string): Promise<DiscoveredProject> {
    this.assertSlug(slug);
    const rootReal = await fs.realpath(this.appsRoot);
    const projectPath = path.join(rootReal, slug);
    const projectStat = await fs.lstat(projectPath);
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
      throw new Error("App project must be a regular directory.");
    }
    const projectReal = await fs.realpath(projectPath);
    if (!isPathInside(rootReal, projectReal) || projectReal !== projectPath) {
      throw new Error("App project escapes the Stella apps directory.");
    }
    const manifest = parseManifest(
      await readRegularFile(path.join(projectReal, MANIFEST_FILE)),
      slug,
    );
    const packageRaw = await readRegularFile(
      path.join(projectReal, PACKAGE_FILE),
    );
    let packageJson: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(packageRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error();
      }
      packageJson = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`${PACKAGE_FILE} must contain a JSON object.`);
    }
    const scripts = Object.fromEntries(
      Object.entries(
        packageJson.scripts && typeof packageJson.scripts === "object"
          ? packageJson.scripts
          : {},
      ).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const dependencyNames = new Set<string>();
    for (const field of ["dependencies", "devDependencies"] as const) {
      const dependencies = packageJson[field];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const name of Object.keys(dependencies)) dependencyNames.add(name);
    }
    return {
      slug,
      projectPath: projectReal,
      meta: { label: manifest.name, createdAt: manifest.createdAt },
      runtime: manifest.runtime,
      package: { scripts, dependencyNames },
    };
  }

  private async launch(
    entry: RuntimeEntry,
  ): Promise<UserAppProjectStartResult> {
    const slug = entry.project.slug;
    const generation = ++entry.generation;
    try {
      entry.status = "installing";
      this.options.onChanged?.();
      if (!(await this.dependenciesReady(entry.project))) {
        const installed = await this.installDependencies(entry);
        if (!installed)
          throw new Error(entry.error || "Dependency installation failed.");
      }
      if (!entry.desiredRunning || this.shuttingDown) {
        return { slug, url: null, status: "stopped" };
      }
      entry.status = "starting";
      this.options.onChanged?.();
      const runtime = this.runtimeForProject(entry.project);
      const processes = runtime.processes;
      // Every port is claimed before anything spawns, so each process can be
      // told where its siblings will be even though they start in sequence.
      const ports = new Map<string, number>();
      const namedPorts = new Map<string, number>();
      for (const process of processes) {
        if (process.port === "auto") {
          ports.set(
            process.id,
            await this.portForProcess(
              slug,
              process.id,
              process.id === runtime.frontend,
            ),
          );
        }
        for (const namedPort of process.ports) {
          namedPorts.set(
            `${process.id}:${namedPort.id}`,
            await this.portForProcess(
              slug,
              process.id,
              false,
              namedPort.id,
              namedPort.protocol,
            ),
          );
        }
      }
      if (
        !entry.desiredRunning ||
        this.shuttingDown ||
        this.entries.get(slug) !== entry ||
        entry.generation !== generation
      ) {
        return { slug, url: null, status: "stopped" };
      }

      const sharedEnv = this.processEnvironment(slug, ports, namedPorts);
      for (const processDefinition of processes) {
        if (
          !entry.desiredRunning ||
          this.shuttingDown ||
          this.entries.get(slug) !== entry ||
          entry.generation !== generation
        ) {
          await this.stopProcesses(entry);
          return { slug, url: null, status: "stopped" };
        }
        const ownPort = ports.get(processDefinition.id) ?? null;
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...sharedEnv,
          BROWSER: "none",
          FORCE_COLOR: "0",
          STELLA_APP_PROCESS_ID: processDefinition.id,
          ...(ownPort
            ? { PORT: String(ownPort), STELLA_APP_PORT: String(ownPort) }
            : {}),
        };
        for (const namedPort of processDefinition.ports) {
          childEnv[`STELLA_APP_PORT_${this.environmentSuffix(namedPort.id)}`] =
            String(namedPorts.get(`${processDefinition.id}:${namedPort.id}`));
        }
        // `bun` is the only command Stella resolves itself; a manifest command
        // runs as written so an app can name its own tool.
        const executable =
          processDefinition.command === "bun"
            ? (this.options.executablePath ?? process.execPath)
            : processDefinition.command;
        const args = processDefinition.args.map((argument) =>
          this.expandProcessArgument(argument, childEnv),
        );
        const child = spawn(executable, args, {
          cwd: entry.project.projectPath,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
        // Piped output with no reader fills its buffer and stalls the child.
        child.stdout?.resume();
        child.stderr?.resume();
        entry.children.set(processDefinition.id, child);
        this.observeProcess(entry, processDefinition.id, child, generation);
        await this.waitForProcessReady(processDefinition, child, ownPort);
      }

      if (
        processes.some((processDefinition) => {
          const child = entry.children.get(processDefinition.id);
          return !child || child.exitCode !== null || child.signalCode !== null;
        })
      ) {
        throw new Error("An app process exited during startup.");
      }
      const frontendPort = ports.get(runtime.frontend);
      if (!frontendPort)
        throw new Error("The frontend process did not receive a port.");
      const url = `http://127.0.0.1:${frontendPort}/`;
      entry.status = "running";
      entry.url = url;
      entry.error = null;
      this.options.onChanged?.();
      return { slug, url, status: "running" };
    } catch (error) {
      // A partially started set is rolled back whole: a lone surviving backend
      // would hold its port and mislead the next launch.
      entry.url = null;
      await this.stopProcesses(entry);
      if (
        !entry.desiredRunning ||
        this.shuttingDown ||
        this.entries.get(slug) !== entry ||
        entry.generation !== generation
      ) {
        entry.status = "stopped";
        entry.error = null;
      } else {
        entry.status = "error";
        entry.error = error instanceof Error ? error.message : String(error);
      }
      this.options.onChanged?.();
      return {
        slug,
        url: null,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      };
    }
  }

  private runtimeForProject(project: DiscoveredProject): ProjectRuntime {
    return (
      project.runtime ??
      detectUserAppRuntime(
        project.package.scripts,
        project.package.dependencyNames,
      )
    );
  }

  /**
   * Sibling addresses every process receives, so app code can reach a backend
   * by name (`STELLA_APP_PORT_API`) without knowing the allocation order.
   */
  private processEnvironment(
    slug: string,
    ports: Map<string, number>,
    namedPorts: Map<string, number>,
  ): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { STELLA_APP_SLUG: slug };
    for (const [processId, port] of ports) {
      const suffix = this.environmentSuffix(processId);
      environment[`STELLA_APP_PORT_${suffix}`] = String(port);
      environment[`STELLA_APP_URL_${suffix}`] = `http://127.0.0.1:${port}`;
    }
    for (const [key, port] of namedPorts) {
      const [processId, portId] = key.split(":");
      const suffix = `${this.environmentSuffix(processId!)}_${this.environmentSuffix(portId!)}`;
      environment[`STELLA_APP_PORT_${suffix}`] = String(port);
    }
    return environment;
  }

  private environmentSuffix(value: string): string {
    return value.toUpperCase().replaceAll("-", "_");
  }

  /**
   * Process arguments are passed to `spawn` without a shell, so `${PORT}` is
   * expanded here rather than being left for a shell that never runs.
   */
  private expandProcessArgument(
    argument: string,
    environment: NodeJS.ProcessEnv,
  ): string {
    return argument.replace(
      /\$\{([A-Z][A-Z0-9_]*)\}/g,
      (_match, name: string) => {
        const value = environment[name];
        if (value === undefined) {
          throw new Error(
            `Process argument references unknown environment variable ${name}.`,
          );
        }
        return value;
      },
    );
  }

  private async dependenciesReady(
    project: DiscoveredProject,
  ): Promise<boolean> {
    try {
      // A scripted project can depend on anything, so only the install root
      // is checked; a script-less project is always the scaffold's bare Vite
      // app, where Vite itself is the sentinel that survives a partial install.
      const dependencyStat = await fs.stat(
        project.runtime || Object.keys(project.package.scripts).length > 0
          ? path.join(project.projectPath, "node_modules")
          : path.join(project.projectPath, "node_modules", "vite"),
      );
      return dependencyStat.isDirectory();
    } catch {
      return false;
    }
  }

  private async installDependencies(entry: RuntimeEntry): Promise<boolean> {
    const child = spawn(
      this.options.executablePath ?? process.execPath,
      ["install", "--silent"],
      {
        cwd: entry.project.projectPath,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    entry.installChild = child;
    let output = "";
    const append = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 4_000) output = output.slice(-4_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        entry.error = "Dependency installation timed out.";
        void killProcessTree(child).finally(() => resolve(null));
      }, INSTALL_TIMEOUT_MS);
      timer.unref?.();
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        entry.error = error.message;
        resolve(null);
      });
    });
    if (entry.installChild === child) entry.installChild = null;
    if (code === 0) return true;
    entry.error ||= output.trim() || "Dependency installation failed.";
    return false;
  }

  /**
   * Dev-server console output is not a runtime contract and has changed across
   * tool versions, so readiness is taken from the bound loopback port instead
   * of parsed from stdout.
   */
  private async waitForProcessReady(
    processDefinition: ProjectProcess,
    child: ChildProcess,
    port: number | null,
  ): Promise<void> {
    const readiness = processDefinition.readiness;
    // A failed spawn reports through the error event, not a throw, so yield
    // once before reading the pid.
    await sleep(0);
    if (!child.pid) {
      throw new Error(`Process ${processDefinition.id} could not be launched.`);
    }
    if (readiness.type === "process") {
      await sleep(readiness.delayMs);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Process ${processDefinition.id} exited before it was ready.`,
        );
      }
      return;
    }
    if (!port)
      throw new Error(`Process ${processDefinition.id} has no readiness port.`);
    const deadline = Date.now() + readiness.timeoutMs;
    let consecutiveReadyProbes = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Process ${processDefinition.id} exited before it was ready.`,
        );
      }
      const ready =
        readiness.type === "http"
          ? await this.probeHttp(port, readiness.path)
          : await this.probeTcp(port);
      consecutiveReadyProbes = ready ? consecutiveReadyProbes + 1 : 0;
      // Two successful probes keep a pre-existing listener from being mistaken
      // for this child during the brief strict-port failure window.
      if (consecutiveReadyProbes >= 2) return;
      await sleep(ready ? 100 : 50);
    }
    throw new Error(`Process ${processDefinition.id} readiness timed out.`);
  }

  private async probeTcp(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(250);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    });
  }

  private async probeHttp(
    port: number,
    readinessPath: string,
  ): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${readinessPath}`, {
        signal: AbortSignal.timeout(500),
      });
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    }
  }

  /**
   * A process set is supervised as a unit: one member exiting takes the whole
   * set down and schedules a restart, because a surviving sibling holds ports
   * and serves stale state the frontend can no longer reach.
   */
  private observeProcess(
    entry: RuntimeEntry,
    processId: string,
    child: ChildProcess,
    generation: number,
  ) {
    const onFailure = (detail: string) => {
      if (entry.generation !== generation) return;
      // During startup `launch` already rolls the set back; recording the
      // detail lets it report which process failed.
      if (entry.status === "starting") {
        entry.error ||= detail;
        return;
      }
      if (
        entry.status !== "running" ||
        !entry.desiredRunning ||
        this.shuttingDown
      ) {
        return;
      }
      entry.generation += 1;
      entry.status = "error";
      entry.url = null;
      entry.error = detail;
      this.options.onChanged?.();
      const recovery = this.stopProcesses(entry);
      entry.recoveryPromise = recovery;
      void recovery.finally(() => {
        if (entry.recoveryPromise === recovery) entry.recoveryPromise = null;
        this.scheduleRestart(entry);
      });
    };
    child.once("error", (error) =>
      onFailure(`Process ${processId} failed: ${error.message}`),
    );
    child.once("exit", (code, signal) =>
      onFailure(
        `Process ${processId} exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`,
      ),
    );
  }

  private async stopProcesses(entry: RuntimeEntry): Promise<void> {
    const children = [...entry.children.values()];
    entry.children.clear();
    await Promise.all(
      children.map((child) => killProcessTree(child).catch(() => undefined)),
    );
  }

  private scheduleRestart(entry: RuntimeEntry) {
    if (entry.restartTimer || this.shuttingDown || !entry.desiredRunning)
      return;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (!entry.desiredRunning || this.shuttingDown) return;
      const promise = this.launch(entry);
      entry.startPromise = promise;
      void promise.finally(() => {
        if (entry.startPromise === promise) entry.startPromise = null;
      });
    }, RESTART_BACKOFF_MS);
    entry.restartTimer.unref?.();
  }

  private async loadPortMap(): Promise<void> {
    if (this.portMapLoaded) return;
    this.portMapLoaded = true;
    try {
      const raw = await readRegularFile(
        path.join(this.appsRoot, PORT_MAP_FILE),
      );
      const parsed = JSON.parse(raw) as {
        schemaVersion?: unknown;
        ports?: unknown;
      };
      if (
        parsed.schemaVersion !== 1 ||
        !parsed.ports ||
        typeof parsed.ports !== "object"
      ) {
        return;
      }
      const claimed = new Set<number>();
      for (const [key, value] of Object.entries(parsed.ports)) {
        if (
          !PORT_MAP_KEY_RE.test(key) ||
          !Number.isInteger(value) ||
          (value as number) < PORT_RANGE_START ||
          (value as number) >= PORT_RANGE_START + PORT_RANGE_SIZE ||
          claimed.has(value as number)
        ) {
          continue;
        }
        claimed.add(value as number);
        this.portMap.set(key, value as number);
      }
    } catch {
      // Missing or malformed mappings are rebuilt on first start.
    }
  }

  private hashSlug(slug: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < slug.length; index += 1) {
      hash ^= slug.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
  }

  private async isPortAvailable(
    port: number,
    protocol: "tcp" | "udp" = "tcp",
  ): Promise<boolean> {
    if (protocol === "udp") {
      return await new Promise<boolean>((resolve) => {
        const socket = createSocket("udp4");
        socket.unref();
        socket.once("error", () => {
          try {
            socket.close();
          } catch {
            // The socket is already closed after a bind error.
          }
          resolve(false);
        });
        socket.bind(port, "127.0.0.1", () => socket.close(() => resolve(true)));
      });
    }
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
  }

  /**
   * The frontend keeps the bare slug as its port-map key so port maps written
   * before multi-process support stay valid; siblings are qualified below it.
   * A pinned port that something else now holds is re-drawn rather than
   * handed out, since strict-port processes would just fail to bind.
   */
  private async portForProcess(
    slug: string,
    processId: string,
    frontend: boolean,
    portId?: string,
    protocol: "tcp" | "udp" = "tcp",
  ): Promise<number> {
    const key = frontend
      ? slug
      : `${slug}:${processId}${portId ? `-${portId}` : ""}`;
    await this.loadPortMap();
    let resolveQueue = () => {};
    const previous = this.portAllocationQueue;
    this.portAllocationQueue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    await previous;
    try {
      const racedExisting = this.portMap.get(key);
      if (
        racedExisting &&
        (await this.isPortAvailable(racedExisting, protocol))
      ) {
        return racedExisting;
      }
      if (racedExisting) this.portMap.delete(key);
      const claimed = new Set(this.portMap.values());
      const startOffset = this.hashSlug(key) % PORT_RANGE_SIZE;
      for (let offset = 0; offset < PORT_RANGE_SIZE; offset += 1) {
        const port =
          PORT_RANGE_START + ((startOffset + offset) % PORT_RANGE_SIZE);
        if (claimed.has(port) || !(await this.isPortAvailable(port, protocol)))
          continue;
        this.portMap.set(key, port);
        try {
          await this.persistPortMap();
        } catch (error) {
          this.portMap.delete(key);
          throw error;
        }
        return port;
      }
      throw new Error("No loopback port is available for this app.");
    } finally {
      resolveQueue();
    }
  }

  private async persistPortMap(): Promise<void> {
    const target = path.join(this.appsRoot, PORT_MAP_FILE);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const ports = Object.fromEntries(
      [...this.portMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, ports }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => undefined);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async stopEntry(slug: string): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry) return;
    entry.desiredRunning = false;
    entry.generation += 1;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
    if (entry.stopPromise) return await entry.stopPromise;
    entry.status = "stopping";
    this.options.onChanged?.();
    const promise = (async () => {
      if (entry.installChild)
        await killProcessTree(entry.installChild).catch(() => undefined);
      entry.installChild = null;
      // An in-flight crash recovery is already killing this set; waiting for
      // it keeps the two teardowns from racing over the same children.
      if (entry.recoveryPromise) await entry.recoveryPromise;
      await this.stopProcesses(entry);
      entry.url = null;
      entry.status = "stopped";
      entry.error = null;
      this.entries.delete(slug);
      this.options.onChanged?.();
    })();
    entry.stopPromise = promise;
    try {
      await promise;
    } finally {
      entry.stopPromise = null;
    }
  }
}

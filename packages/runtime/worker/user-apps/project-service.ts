import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
  UserAppProjectDescriptor,
  UserAppProjectListResult,
  UserAppProjectStartResult,
  UserAppProjectStatus,
  UserAppProjectStopResult,
} from "@stella/contracts/user-app-projects";

const SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MANIFEST_FILE = "stella.app.json";
const PACKAGE_FILE = "package.json";
const PORT_MAP_FILE = ".stella-app-ports.json";
const PORT_RANGE_START = 41_000;
const PORT_RANGE_SIZE = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const URL_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 1_500;
const RESTART_BACKOFF_MS = 2_000;
const WATCH_DEBOUNCE_MS = 100;
const URL_RE =
  /Local:\s+https?:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})(?:\/[^\s]*)?/i;

type ProjectManifest = {
  schemaVersion: 1;
  slug: string;
  name: string;
  createdAt: string;
};

type DiscoveredProject = UserAppProjectDescriptor & {
  projectPath: string;
};

type RuntimeEntry = {
  project: DiscoveredProject;
  child: ChildProcess | null;
  status: UserAppProjectStatus;
  url: string | null;
  error: string | null;
  desiredRunning: boolean;
  startPromise: Promise<UserAppProjectStartResult> | null;
  stopPromise: Promise<void> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

export type UserAppProjectServiceOptions = {
  workspacePath: string;
  onChanged?: () => void;
  executablePath?: string;
};

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
  const manifest = value as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const createdAt =
    typeof manifest.createdAt === "string" ? manifest.createdAt.trim() : "";
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${MANIFEST_FILE} schemaVersion must be 1.`);
  }
  if (manifest.slug !== expectedSlug) {
    throw new Error(`${MANIFEST_FILE} slug must match its directory.`);
  }
  if (!name || name.length > 120) {
    throw new Error(`${MANIFEST_FILE} name must be 1-120 characters.`);
  }
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`${MANIFEST_FILE} createdAt must be an ISO date string.`);
  }
  return {
    schemaVersion: 1,
    slug: expectedSlug,
    name,
    createdAt,
  };
};

const killProcessTree = async (child: ChildProcess): Promise<void> => {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
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
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };

    child.once("exit", finish);
    timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already exited.
      }
      finish();
    }, STOP_GRACE_MS);
    timer.unref?.();

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
    }
  });
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
   * User apps are hosted by child Vite processes owned by this worker. Keep the
   * worker alive while one is starting, running, stopping, or awaiting a
   * scheduled restart; otherwise detached-worker idle shutdown tears down a
   * healthy app moments after the start RPC returns.
   */
  hasActiveWork(): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.startPromise ||
        entry.stopPromise ||
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
    if (existing?.startPromise) return await existing.startPromise;

    const entry: RuntimeEntry = existing ?? {
      project,
      child: null,
      status: "stopped",
      url: null,
      error: null,
      desiredRunning: true,
      startPromise: null,
      stopPromise: null,
      restartTimer: null,
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
    try {
      const packageJson = JSON.parse(packageRaw);
      if (!packageJson || typeof packageJson !== "object") {
        throw new Error();
      }
    } catch {
      throw new Error(`${PACKAGE_FILE} must contain a JSON object.`);
    }
    return {
      slug,
      projectPath: projectReal,
      meta: { label: manifest.name, createdAt: manifest.createdAt },
    };
  }

  private async launch(
    entry: RuntimeEntry,
  ): Promise<UserAppProjectStartResult> {
    const slug = entry.project.slug;
    try {
      entry.status = "installing";
      this.options.onChanged?.();
      if (!(await this.dependenciesReady(entry.project.projectPath))) {
        const installed = await this.installDependencies(entry);
        if (!installed)
          throw new Error(entry.error || "Dependency installation failed.");
      }
      if (!entry.desiredRunning || this.shuttingDown) {
        return { slug, url: null, status: "stopped" };
      }
      entry.status = "starting";
      this.options.onChanged?.();
      const port = await this.portForSlug(slug);
      if (
        !entry.desiredRunning ||
        this.shuttingDown ||
        this.entries.get(slug) !== entry
      ) {
        return { slug, url: null, status: "stopped" };
      }
      const child = spawn(
        this.options.executablePath ?? process.execPath,
        [
          "x",
          "vite",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--strictPort",
        ],
        {
          cwd: entry.project.projectPath,
          env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        },
      );
      entry.child = child;
      const url = await this.waitForUrl(entry, child, port);
      if (!url)
        throw new Error(entry.error || "Vite did not report a loopback URL.");
      entry.status = "running";
      entry.url = url;
      entry.error = null;
      this.options.onChanged?.();
      return { slug, url, status: "running" };
    } catch (error) {
      entry.status = entry.desiredRunning ? "error" : "stopped";
      entry.url = null;
      entry.error = error instanceof Error ? error.message : String(error);
      if (entry.child)
        await killProcessTree(entry.child).catch(() => undefined);
      entry.child = null;
      this.options.onChanged?.();
      return {
        slug,
        url: null,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      };
    }
  }

  private async dependenciesReady(projectPath: string): Promise<boolean> {
    try {
      const viteStat = await fs.stat(
        path.join(projectPath, "node_modules", "vite"),
      );
      return viteStat.isDirectory();
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
    entry.child = child;
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
    if (entry.child === child) entry.child = null;
    if (code === 0) return true;
    entry.error ||= output.trim() || "Dependency installation failed.";
    return false;
  }

  private async waitForUrl(
    entry: RuntimeEntry,
    child: ChildProcess,
    expectedPort: number,
  ): Promise<string | null> {
    let buffer = "";
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      let probeSocket: net.Socket | null = null;
      let consecutiveReadyProbes = 0;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
        probeSocket?.destroy();
        probeSocket = null;
        resolve(value);
      };
      const probeLoopback = () => {
        if (settled || probeSocket) return;
        const socket = net.createConnection({
          host: "127.0.0.1",
          port: expectedPort,
        });
        probeSocket = socket;
        let probeSettled = false;
        const finishProbe = (ready: boolean) => {
          if (probeSettled) return;
          probeSettled = true;
          socket.destroy();
          if (probeSocket === socket) probeSocket = null;
          if (settled) return;
          if (ready) {
            consecutiveReadyProbes += 1;
            // Two successful probes keep a pre-existing listener from being
            // mistaken for this child during the brief strict-port failure
            // window.
            if (
              consecutiveReadyProbes >= 2 &&
              child.exitCode === null &&
              child.signalCode === null
            ) {
              finish(`http://127.0.0.1:${expectedPort}/`);
              return;
            }
          } else {
            consecutiveReadyProbes = 0;
          }
          probeTimer = setTimeout(probeLoopback, ready ? 100 : 50);
          probeTimer.unref?.();
        };
        socket.setTimeout(250);
        socket.once("connect", () => finishProbe(true));
        socket.once("error", () => finishProbe(false));
        socket.once("timeout", () => finishProbe(false));
      };
      const timeout = setTimeout(() => {
        entry.error = "Vite startup timed out.";
        void killProcessTree(child).finally(() => finish(null));
      }, URL_TIMEOUT_MS);
      timeout.unref?.();
      // Vite's console format is not a runtime contract and has changed across
      // versions. Keep parsing it as a fast path, but treat the actual bound
      // loopback port as the source of truth for readiness.
      probeLoopback();
      const onData = (chunk: Buffer | string) => {
        buffer = `${buffer}${chunk.toString()}`.slice(-8_000);
        const match = buffer.match(URL_RE);
        if (!match) return;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
        if (port !== expectedPort) {
          entry.error = "Vite reported an unexpected port.";
          void killProcessTree(child).finally(() => finish(null));
          return;
        }
        finish(`http://127.0.0.1:${port}/`);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (error) => {
        entry.error = error.message;
        finish(null);
      });
      child.once("exit", (code) => {
        const wasRunning = entry.status === "running";
        if (!settled) {
          entry.error ||= `Vite exited before startup${code == null ? "" : ` (code ${code})`}.`;
          finish(null);
        }
        if (entry.child === child) entry.child = null;
        entry.url = null;
        if (
          !entry.desiredRunning ||
          entry.status === "stopping" ||
          this.shuttingDown
        ) {
          entry.status = "stopped";
        } else {
          entry.status = "error";
          if (wasRunning) this.scheduleRestart(entry);
        }
        this.options.onChanged?.();
      });
    });
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
      for (const [slug, value] of Object.entries(parsed.ports)) {
        if (
          !SLUG_RE.test(slug) ||
          !Number.isInteger(value) ||
          (value as number) < PORT_RANGE_START ||
          (value as number) >= PORT_RANGE_START + PORT_RANGE_SIZE ||
          claimed.has(value as number)
        ) {
          continue;
        }
        claimed.add(value as number);
        this.portMap.set(slug, value as number);
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

  private async isPortAvailable(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async portForSlug(slug: string): Promise<number> {
    await this.loadPortMap();
    const existing = this.portMap.get(slug);
    if (existing) return existing;
    let resolveQueue = () => {};
    const previous = this.portAllocationQueue;
    this.portAllocationQueue = new Promise<void>((resolve) => {
      resolveQueue = resolve;
    });
    await previous;
    try {
      const racedExisting = this.portMap.get(slug);
      if (racedExisting) return racedExisting;
      const claimed = new Set(this.portMap.values());
      const startOffset = this.hashSlug(slug) % PORT_RANGE_SIZE;
      for (let offset = 0; offset < PORT_RANGE_SIZE; offset += 1) {
        const port =
          PORT_RANGE_START + ((startOffset + offset) % PORT_RANGE_SIZE);
        if (claimed.has(port) || !(await this.isPortAvailable(port))) continue;
        this.portMap.set(slug, port);
        try {
          await this.persistPortMap();
        } catch (error) {
          this.portMap.delete(slug);
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
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
    if (entry.stopPromise) return await entry.stopPromise;
    entry.status = "stopping";
    this.options.onChanged?.();
    const promise = (async () => {
      if (entry.child)
        await killProcessTree(entry.child).catch(() => undefined);
      entry.child = null;
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

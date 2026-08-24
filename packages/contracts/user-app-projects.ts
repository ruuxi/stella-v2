export type UserAppProjectStatus =
  | "stopped"
  | "installing"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type UserAppProjectProcessReadiness =
  | { type: "http"; path?: string; timeoutMs?: number }
  | { type: "tcp"; timeoutMs?: number }
  | { type: "process"; delayMs?: number };

export type UserAppProjectProcessManifest = {
  /** Stable lowercase id, also used in STELLA_APP_PORT_<ID> environment names. */
  id: string;
  /** Executable launched directly without a shell. Use "bun" for Stella's bundled Bun. */
  command: string;
  /** Supports ${PORT} and other STELLA_APP_* variables supplied by the runtime. */
  args?: string[];
  /** Requests a stable, loopback-only port and exposes it through PORT/STELLA_APP_PORT. */
  port?: "auto";
  /** Additional stable ports exposed as STELLA_APP_PORT_<PORT_ID>. */
  ports?: Array<{ id: string; protocol: "tcp" | "udp" }>;
  /** Defaults to TCP for port processes and a short process-liveness delay otherwise. */
  readiness?: UserAppProjectProcessReadiness;
};

export type UserAppProjectRuntimeManifest = {
  /** Process whose loopback URL Stella opens after every process is ready. */
  frontend: string;
  /** Started and readiness-checked in declaration order; stopped in one lifecycle. */
  processes: UserAppProjectProcessManifest[];
};

export type UserAppProjectMeta = {
  label: string;
  createdAt: string;
};

export type UserAppProjectDescriptor = {
  slug: string;
  meta: UserAppProjectMeta;
  status?: UserAppProjectStatus;
};

export type UserAppProjectListResult = {
  apps: UserAppProjectDescriptor[];
};

export type UserAppProjectStartResult = {
  slug: string;
  url: string | null;
  status: UserAppProjectStatus;
  error?: string;
};

export type UserAppProjectStopResult = {
  slug: string;
  status: "stopped";
};

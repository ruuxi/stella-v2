/**
 * The owner's copy of the app's source (v3). The release process publishes
 * the app to the `upstream` repo in this environment's Artifacts namespace;
 * each owner gets a fork of it on first use, which their local clone pushes
 * self-modifications to and merges upstream updates into. Git access is by
 * short-lived tokens minted per request.
 */

import type { AppSourceCalls, AppSourceRemote } from "@stella/contracts/backend/app-source";
import { empty } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDomain } from "../registry.js";

const UPSTREAM_REPO = "upstream";
const TOKEN_TTL_SECONDS = 60 * 60;
const FORK_RETRY_MS = 2_000;

export const APP_SOURCE_MIGRATION = {
  id: "app-source.1-fork",
  statements: [
    `CREATE TABLE app_source_fork (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       name TEXT NOT NULL,
       remote TEXT NOT NULL,
       default_branch TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ],
};

type ForkRow = { name: string; remote: string; default_branch: string };

const artifactsCode = (error: unknown): string | null =>
  error instanceof Error && error.name === "ArtifactsError"
    ? String((error as { code?: unknown }).code ?? "")
    : null;

/** `u-<24 hex of sha256(owner)>`: stable, unguessable, and never the raw id. */
const forkName = async (ownerId: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`stella-app-fork-v1\0${ownerId}`)),
  );
  return `u-${[...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const unavailable = (message: string) =>
  new RpcError("UNAVAILABLE", message, { retryable: true, retryAfterMs: FORK_RETRY_MS });

/** Run `work` against a repo handle and release it afterwards. */
const withRepo = async <T>(artifacts: Artifacts, name: string, work: (repo: ArtifactsRepo) => Promise<T>): Promise<T> => {
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(name);
  } catch (error) {
    const code = artifactsCode(error);
    if (code === "FORK_IN_PROGRESS" || code === "CREATE_IN_PROGRESS") {
      throw unavailable("Your copy of Stella's source is still being prepared.");
    }
    if (code === "NOT_FOUND" && name === UPSTREAM_REPO) {
      throw unavailable("Stella's source has not been published yet.");
    }
    throw error;
  }
  try {
    return await work(repo);
  } finally {
    (repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  }
};

const mintToken = async (repo: ArtifactsRepo, scope: "read" | "write") => {
  const minted = await repo.createToken(scope, TOKEN_TTL_SECONDS);
  return { token: minted.plaintext, expiresAt: Date.parse(minted.expiresAt) };
};

/** The owner's fork, creating it from upstream the first time. */
const ensureFork = async (ctx: OwnerContext): Promise<ForkRow> => {
  const existing = ctx.db.one<ForkRow>("SELECT name, remote, default_branch FROM app_source_fork WHERE id = 1");
  if (existing) return existing;
  const artifacts = ctx.env.ARTIFACTS;
  const name = await forkName(ctx.ownerId);
  let fork: ForkRow;
  try {
    const created = await withRepo(artifacts, UPSTREAM_REPO, (upstream) =>
      upstream.fork(name, { defaultBranchOnly: true, readOnly: false }),
    );
    fork = { name: created.name, remote: created.remote, default_branch: created.defaultBranch };
    // The creation token outlives the hour every other token gets.
    await withRepo(artifacts, name, (repo) => repo.revokeToken(created.token));
  } catch (error) {
    const code = artifactsCode(error);
    if (code === "FORK_IN_PROGRESS") throw unavailable("Your copy of Stella's source is still being prepared.");
    if (code !== "ALREADY_EXISTS") throw error;
    // A fork whose response was lost: adopt it.
    const info = await withRepo(artifacts, name, (repo) => repo.info());
    fork = { name: info.name, remote: info.remote, default_branch: info.defaultBranch };
  }
  ctx.db.run(
    "INSERT INTO app_source_fork (id, name, remote, default_branch, created_at) VALUES (1, ?, ?, ?, ?)",
    fork.name,
    fork.remote,
    fork.default_branch,
    ctx.now,
  );
  return fork;
};

const access = async (ctx: OwnerContext): Promise<AppSourceCalls["appSource.access"]["result"]> => {
  enforceOwnerRateLimit(ctx.db, ctx.now, "appSource.access", { count: 60, windowMs: 60_000 }, "Too many source requests. Please wait a moment.");
  const artifacts = ctx.env.ARTIFACTS;
  const fork = await ensureFork(ctx);
  const forkToken = await withRepo(artifacts, fork.name, (repo) => mintToken(repo, "write"));
  const upstream: AppSourceRemote = await withRepo(artifacts, UPSTREAM_REPO, async (repo) => ({
    remote: (await repo.info()).remote,
    ...(await mintToken(repo, "read")),
  }));
  return {
    fork: {
      name: fork.name,
      remote: fork.remote,
      defaultBranch: fork.default_branch,
      ...forkToken,
    },
    upstream,
  };
};

export const appSourceDomain = {
  name: "app-source",
  migrations: [APP_SOURCE_MIGRATION],
  calls: {
    "appSource.access": {
      scope: "owner",
      requireAccount: true,
      parse: empty(),
      handler: (ctx: OwnerContext) => access(ctx),
    },
  },
} satisfies OwnerDomain;

/**
 * Cloud projects and the owner's GitHub App installations.
 *
 * The connect handshake is split so that no single leg can bind an
 * installation to the wrong account:
 *
 *   1. `projects.startGithubInstall` records an `install` nonce and signs it
 *      into the install URL's `state`.
 *   2. GitHub's redirect (`src/projects/routes.ts`) spends that nonce
 *      (`projects.githubBeginVerify`) for a `verify` nonce naming the
 *      installation, and sends the browser to GitHub's user authorization.
 *   3. The identity leg proves which GitHub user can reach the installation
 *      and parks it as a `claim` (`projects.githubClaim`), whose id is the
 *      connect code shown on the page. The redirect has no Stella session, so
 *      it never binds.
 *   4. The owner types the code into `projects.finishGithubConnect`. The claim
 *      lives in this owner's object, so a code from anyone else's handshake
 *      is simply not found.
 *
 * D1 `github_installations` maps an installation to its owner so GitHub's
 * webhook (which carries nothing else) can reach this object.
 */

import type {
  CloudProject,
  GithubConnection,
  ProjectCalls,
} from "@stella/contracts/backend/projects";
import { signOAuthState } from "../../oauth-state.js";
import {
  githubAppConfigured,
  githubInstallUrl,
  INSTALLATION_ID_PATTERN,
  installationIndex,
  revokeInstallation,
} from "../../projects/github.js";
import { empty, number, object, optional, string } from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type { OwnerContext, OwnerDbReader, OwnerDomain } from "../registry.js";

export const GITHUB_INSTALL_STATE_KIND = "github_install";
export const GITHUB_VERIFY_STATE_KIND = "github_verify";

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_PROJECTS = 25;
const INSTALL_STATE_TTL_MS = 15 * 60_000;
const VERIFY_STATE_TTL_MS = 10 * 60_000;
const CLAIM_TTL_MS = 10 * 60_000;
// Crockford's alphabet minus I/L/O/U: a hand-typed code can't be mistyped
// into a different valid one.
const CONNECT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONNECT_CODE_LENGTH = 12;

export const PROJECTS_MIGRATION = {
  id: "projects.1-init",
  statements: [
    `CREATE TABLE projects (
       project_id TEXT PRIMARY KEY,
       slug TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       provider TEXT NOT NULL,
       remote_url TEXT,
       installation_id TEXT,
       default_branch TEXT NOT NULL,
       status TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE github_installations (
       installation_id TEXT PRIMARY KEY,
       account_login TEXT NOT NULL,
       account_type TEXT NOT NULL,
       github_login TEXT,
       github_user_id INTEGER,
       status TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    // One row per handshake step: `install` and `verify` nonces, and `claim`
    // rows keyed by their connect code.
    `CREATE TABLE github_connect_states (
       id TEXT PRIMARY KEY,
       phase TEXT NOT NULL,
       installation_id TEXT,
       account_login TEXT,
       account_type TEXT,
       github_login TEXT,
       github_user_id INTEGER,
       expires_at INTEGER NOT NULL
     )`,
  ],
};

type ProjectRow = {
  project_id: string;
  slug: string;
  name: string;
  provider: string;
  remote_url: string | null;
  installation_id: string | null;
  default_branch: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type InstallationRow = {
  installation_id: string;
  account_login: string;
  account_type: string;
  status: string;
  updated_at: number;
};

type StateRow = {
  id: string;
  phase: string;
  installation_id: string | null;
  account_login: string | null;
  account_type: string | null;
  github_login: string | null;
  github_user_id: number | null;
  expires_at: number;
};

const publicProject = (row: ProjectRow): CloudProject => ({
  projectId: row.project_id,
  slug: row.slug,
  name: row.name,
  provider: row.provider,
  ...(row.remote_url ? { remoteUrl: row.remote_url } : {}),
  githubConnected: row.installation_id !== null,
  defaultBranch: row.default_branch,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");

const bad = (message: string) => new RpcError("BAD_REQUEST", message);

/**
 * A github.com remote, normalized. Credentials in the URL are refused: the
 * App installation exists so no long-lived token is ever stored.
 */
const parseGithubRemote = (input: string): string => {
  const raw = input.trim();
  if (!raw) throw bad("Paste a GitHub repository URL.");
  if (raw.length > 300) throw bad("That repository URL is too long.");
  const ssh = /^git@github\.com:(.+)$/.exec(raw);
  if (!ssh && raw.includes("@")) {
    throw bad("Remove the credentials from that URL — Stella connects to GitHub through its app instead.");
  }
  const shapeError = "That doesn't look like a repository URL. Use https://github.com/<owner>/<repo>.";
  let path: string;
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(raw)) {
    path = raw;
  } else if (ssh) {
    path = ssh[1]!;
  } else {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw bad(shapeError);
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw bad("Only github.com repositories can be connected right now. Create a Stella-hosted project instead.");
    }
    path = url.pathname;
  }
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length !== 2) throw bad(shapeError);
  const [owner, repo] = segments as [string, string];
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
    throw bad("That repository owner or name isn't valid on GitHub.");
  }
  return `https://github.com/${owner}/${repo}.git`;
};

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** 60 bits, uniform: the alphabet is exactly 32 characters. */
const randomConnectCode = (): string =>
  [...crypto.getRandomValues(new Uint8Array(CONNECT_CODE_LENGTH))]
    .map((byte) => CONNECT_CODE_ALPHABET[byte & 31])
    .join("");

const normalizeConnectCode = (input: string): string =>
  input
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");

export const formatConnectCode = (code: string): string => code.match(/.{1,4}/g)?.join("-") ?? code;

const listProjects = (db: OwnerDbReader): CloudProject[] =>
  db
    .all<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?", MAX_PROJECTS * 2)
    .map(publicProject);

const listConnections = (db: OwnerDbReader): GithubConnection[] =>
  db
    .all<InstallationRow>(
      "SELECT installation_id, account_login, account_type, status, updated_at FROM github_installations ORDER BY updated_at DESC LIMIT 10",
    )
    .map((row) => ({
      installationId: row.installation_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      status: row.status,
      updatedAt: row.updated_at,
    }));

type CreateArgs = ProjectCalls["projects.create"]["args"];

const createProject = (ctx: OwnerContext, args: CreateArgs): CloudProject => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "projects.create",
    { count: 20, windowMs: 60 * 60_000 },
    "You're creating projects quickly. Wait a moment and try again.",
  );
  const name = args.name.trim();
  if (!name || name.length > 80) throw bad("Give the project a name of 1–80 characters.");
  const slug = slugify(args.slug ?? name);
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw bad("Project names need at least one letter or number, and slugs are limited to 64 characters.");
  }
  if (ctx.db.one("SELECT 1 AS found FROM projects WHERE slug = ?", slug)) {
    throw new RpcError("CONFLICT", `You already have a project called "${slug}". Pick another name.`);
  }
  const count = ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM projects")?.n ?? 0;
  if (count >= MAX_PROJECTS) {
    throw new RpcError("FORBIDDEN", `You can keep ${MAX_PROJECTS} cloud projects. Delete one to make room.`);
  }
  const branch = args.defaultBranch?.trim() || "main";
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..")) throw bad("That branch name isn't valid.");
  const remoteUrl = args.remoteUrl?.trim() ? parseGithubRemote(args.remoteUrl) : null;
  let installationId: string | null = null;
  if (remoteUrl) {
    if (args.installationId) {
      const row = ctx.db.one<{ installation_id: string }>(
        "SELECT installation_id FROM github_installations WHERE installation_id = ?",
        args.installationId.trim(),
      );
      if (!row) {
        throw bad(
          "That GitHub connection isn't available on this account. Connect GitHub from Settings first.",
        );
      }
      installationId = row.installation_id;
    } else {
      // With exactly one connection there is nothing to choose.
      const rows = ctx.db.all<{ installation_id: string }>(
        "SELECT installation_id FROM github_installations LIMIT 2",
      );
      if (rows.length === 0) {
        throw bad("Connect GitHub first — Stella needs its app installed on that repository to clone it.");
      }
      if (rows.length > 1) throw bad("Pick which GitHub connection owns that repository.");
      installationId = rows[0]!.installation_id;
    }
  }
  const projectId = `prj-${crypto.randomUUID().slice(0, 18)}`;
  ctx.db.run(
    `INSERT INTO projects
       (project_id, slug, name, provider, remote_url, installation_id, default_branch, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    projectId,
    slug,
    name,
    remoteUrl ? "github" : "stella",
    remoteUrl,
    installationId,
    branch,
    ctx.now,
    ctx.now,
  );
  return publicProject(ctx.db.one<ProjectRow>("SELECT * FROM projects WHERE project_id = ?", projectId)!);
};

const startGithubInstall = async (ctx: OwnerContext): Promise<{ installUrl: string }> => {
  if (!githubAppConfigured(ctx.env)) {
    throw new RpcError("UNAVAILABLE", "GitHub projects aren't configured on this deployment yet.", {
      retryable: false,
    });
  }
  // Minting states is the cheap half of an installation-guessing loop.
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "projects.githubInstall",
    { count: 10, windowMs: 60 * 60_000 },
    "You've started the GitHub connection several times. Wait a few minutes and try again.",
  );
  ctx.db.run("DELETE FROM github_connect_states WHERE expires_at <= ?", ctx.now);
  const nonce = randomHex(24);
  const exp = ctx.now + INSTALL_STATE_TTL_MS;
  ctx.db.run(
    "INSERT INTO github_connect_states (id, phase, expires_at) VALUES (?, 'install', ?)",
    nonce,
    exp,
  );
  const state = await signOAuthState(ctx.env, {
    ownerId: ctx.ownerId,
    kind: GITHUB_INSTALL_STATE_KIND,
    nonce,
    exp,
  });
  return { installUrl: githubInstallUrl(ctx.env, state) };
};

/** Spend a single-use state row of `phase`. Expired rows are spent too. */
const spendState = (ctx: OwnerContext, id: string, phase: string): StateRow | null => {
  const row = ctx.db.one<StateRow>(
    "SELECT * FROM github_connect_states WHERE id = ? AND phase = ?",
    id,
    phase,
  );
  if (!row) return null;
  ctx.db.run("DELETE FROM github_connect_states WHERE id = ?", id);
  return row.expires_at > ctx.now ? row : null;
};

/** Leg 2: the install nonce, swapped for a verify nonce bound to the installation. */
const beginVerify = (ctx: OwnerContext, args: unknown): { nonce: string; exp: number } | null => {
  const { nonce, installationId } = object({
    nonce: string({ max: 128 }),
    installationId: string({ pattern: INSTALLATION_ID_PATTERN }),
  })(args);
  if (!spendState(ctx, nonce, "install")) return null;
  const verifyNonce = randomHex(24);
  const exp = ctx.now + VERIFY_STATE_TTL_MS;
  ctx.db.run(
    "INSERT INTO github_connect_states (id, phase, installation_id, expires_at) VALUES (?, 'verify', ?, ?)",
    verifyNonce,
    installationId,
    exp,
  );
  return { nonce: verifyNonce, exp };
};

/** Leg 3: a verified installation, parked under a fresh connect code. */
const claim = (ctx: OwnerContext, args: unknown): { connectCode: string } | null => {
  const parsed = object({
    nonce: string({ max: 128 }),
    installationId: string({ pattern: INSTALLATION_ID_PATTERN }),
    accountLogin: string({ max: 200 }),
    accountType: string({ max: 50 }),
    githubLogin: optional(string({ max: 200 })),
    githubUserId: optional(number({ int: true, min: 1 })),
  })(args);
  const row = spendState(ctx, parsed.nonce, "verify");
  if (!row || row.installation_id !== parsed.installationId) return null;
  const connectCode = randomConnectCode();
  ctx.db.run(
    `INSERT INTO github_connect_states
       (id, phase, installation_id, account_login, account_type, github_login, github_user_id, expires_at)
     VALUES (?, 'claim', ?, ?, ?, ?, ?, ?)`,
    connectCode,
    parsed.installationId,
    parsed.accountLogin,
    parsed.accountType,
    parsed.githubLogin ?? null,
    parsed.githubUserId ?? null,
    ctx.now + CLAIM_TTL_MS,
  );
  return { connectCode };
};

type FinishResult = ProjectCalls["projects.finishGithubConnect"]["result"];

/** Leg 4, the bind: needs both the code and this owner's session. */
const finishGithubConnect = async (
  ctx: OwnerContext,
  args: { connectCode: string },
): Promise<FinishResult> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "projects.githubFinish",
    { count: 20, windowMs: 60 * 60_000 },
    "Too many connect attempts. Wait a few minutes and try again.",
  );
  const refuse = (reason: string): FinishResult => ({ ok: false, accountLogin: "", accountType: "", reason });
  const code = normalizeConnectCode(args.connectCode);
  if (code.length !== CONNECT_CODE_LENGTH) {
    return refuse("That connect code isn't complete. Copy the whole code GitHub showed you.");
  }
  const row = spendState(ctx, code, "claim");
  if (!row?.installation_id) {
    return refuse(
      "That connect code has expired, was already used, or belongs to another Stella account. Start the GitHub connection again from this account.",
    );
  }
  const installationId = row.installation_id;
  // Rebinding an installation to a different account would silently detach
  // the first account's projects; reinstalling on GitHub (a new id) is the
  // supported way to move it.
  await installationIndex(ctx.env).prepare(
    "INSERT INTO github_installations (installation_id, owner_id) VALUES (?, ?) ON CONFLICT (installation_id) DO NOTHING",
  )
    .bind(installationId, ctx.ownerId)
    .run();
  const bound = await installationIndex(ctx.env).prepare("SELECT owner_id FROM github_installations WHERE installation_id = ?")
    .bind(installationId)
    .first<{ owner_id: string }>();
  if (bound?.owner_id !== ctx.ownerId) {
    return refuse(
      "That GitHub installation is already connected to another Stella account. Disconnect it there first, or reinstall the app on GitHub.",
    );
  }
  ctx.db.run(
    `INSERT INTO github_installations
       (installation_id, account_login, account_type, github_login, github_user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (installation_id) DO UPDATE SET
       account_login = CASE WHEN excluded.account_login = '' THEN account_login ELSE excluded.account_login END,
       account_type = CASE WHEN excluded.account_type = '' THEN account_type ELSE excluded.account_type END,
       github_login = COALESCE(excluded.github_login, github_login),
       github_user_id = COALESCE(excluded.github_user_id, github_user_id),
       status = 'active',
       updated_at = excluded.updated_at`,
    installationId,
    row.account_login ?? "",
    row.account_type ?? "",
    row.github_login,
    row.github_user_id,
    ctx.now,
    ctx.now,
  );
  return { ok: true, accountLogin: row.account_login ?? "", accountType: row.account_type ?? "" };
};

const dropInstallation = async (ctx: OwnerContext, installationId: string): Promise<void> => {
  ctx.db.run("DELETE FROM github_installations WHERE installation_id = ?", installationId);
  // Projects keep their remote but can no longer authenticate.
  ctx.db.run(
    "UPDATE projects SET installation_id = NULL, updated_at = ? WHERE installation_id = ?",
    ctx.now,
    installationId,
  );
  await installationIndex(ctx.env).prepare("DELETE FROM github_installations WHERE installation_id = ? AND owner_id = ?")
    .bind(installationId, ctx.ownerId)
    .run();
};

/** GitHub's installation webhook: deleted, suspended or unsuspended. */
const installationStatus = async (ctx: OwnerContext, args: unknown): Promise<{ ok: boolean }> => {
  const { installationId, status } = object({
    installationId: string({ pattern: INSTALLATION_ID_PATTERN }),
    status: string({ max: 16 }),
  })(args);
  if (!ctx.db.one("SELECT 1 AS found FROM github_installations WHERE installation_id = ?", installationId)) {
    return { ok: false };
  }
  if (status === "deleted") {
    await dropInstallation(ctx, installationId);
  } else {
    ctx.db.run(
      "UPDATE github_installations SET status = ?, updated_at = ? WHERE installation_id = ?",
      status,
      ctx.now,
      installationId,
    );
  }
  return { ok: true };
};

/** Uninstall each installation from GitHub, then forget it; a failed revoke retries. */
const purgeProjects = async (ctx: OwnerContext): Promise<{ pending: boolean }> => {
  let pending = false;
  for (const { installation_id } of ctx.db.all<{ installation_id: string }>(
    "SELECT installation_id FROM github_installations",
  )) {
    if (githubAppConfigured(ctx.env)) {
      try {
        await revokeInstallation(ctx.env, installation_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "github_installation_revoke_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        pending = true;
        continue;
      }
    }
    await dropInstallation(ctx, installation_id);
  }
  ctx.db.run("DELETE FROM github_connect_states");
  if (!pending) ctx.db.run("DELETE FROM projects");
  return { pending };
};

export const projectsDomain = {
  name: "projects",
  migrations: [PROJECTS_MIGRATION],
  calls: {
    "projects.create": {
      scope: "owner",
      parse: object({
        name: string({ max: 200 }),
        slug: optional(string({ max: 200 })),
        remoteUrl: optional(string({ max: 400 })),
        defaultBranch: optional(string({ max: 200 })),
        installationId: optional(string({ max: 32 })),
      }),
      handler: createProject,
    },
    "projects.startGithubInstall": {
      scope: "owner",
      parse: empty(),
      handler: startGithubInstall,
    },
    "projects.finishGithubConnect": {
      scope: "owner",
      parse: object({ connectCode: string({ max: 64 }) }),
      handler: finishGithubConnect,
    },
  },
  views: {
    "projects.list": {
      parse: empty(),
      read: (ctx) => listProjects(ctx.db),
    },
    "projects.github": {
      parse: empty(),
      read: (ctx) => ({ appConfigured: githubAppConfigured(ctx.env), connections: listConnections(ctx.db) }),
    },
  },
  internal: {
    "projects.githubBeginVerify": beginVerify,
    "projects.githubClaim": claim,
    "projects.githubInstallationStatus": installationStatus,
  },
  purge: purgeProjects,
} satisfies OwnerDomain;

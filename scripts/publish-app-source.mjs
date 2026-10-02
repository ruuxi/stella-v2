#!/usr/bin/env node
/**
 * Publish the desktop app's source to an environment's upstream Artifacts
 * repo, where each owner's fork pulls updates from (v3).
 *
 *   node scripts/publish-app-source.mjs [--namespace stella-app-dev] [--ref HEAD]
 *
 * The published tree is the ref minus the server, the mobile app and repo
 * tooling, with `bun.lock` regenerated for the workspaces that remain so a
 * frozen install works. Each publish is one commit on upstream `main`,
 * parented on the previous publish, with the source commit in a
 * `Stella-Source:` trailer. An unchanged tree publishes nothing.
 *
 * Needs a Wrangler login (or CLOUDFLARE_API_TOKEN) for the account.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_REPO = "upstream";

/** Not part of the desktop app a user's agents can modify. */
const EXCLUDED_PATHS = [
  ".agents",
  ".github",
  "infra",
  "workers",
  "packages/backend",
  "packages/executor-cloud",
  "packages/mobile",
  "packages/mobile-screenshots",
  "packages/runtime-rust",
  "packages/website",
];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const namespace = option("namespace", "stella-app-dev");
const ref = option("ref", "HEAD");

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();

const wrangler = (commandArgs) => {
  const result = spawnSync("bunx", ["wrangler", "artifacts", ...commandArgs, "--json"], {
    cwd: path.join(repoRoot, "workers/cloud-builder"),
    encoding: "utf8",
  });
  if (result.status !== 0) return { ok: false, output: `${result.stdout}\n${result.stderr}` };
  return { ok: true, value: JSON.parse(result.stdout) };
};

const sourceSha = run("git", ["rev-parse", ref], { cwd: repoRoot });
const workDir = mkdtempSync(path.join(tmpdir(), "stella-app-source-"));

try {
  // 1. The app tree at the ref.
  const archive = spawnSync("git", ["archive", sourceSha], { cwd: repoRoot, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error("git archive failed");
  const untar = spawnSync("tar", ["-x", "-C", workDir], { input: archive.stdout });
  if (untar.status !== 0) throw new Error("tar failed");
  for (const excluded of EXCLUDED_PATHS) {
    rmSync(path.join(workDir, excluded), { recursive: true, force: true });
  }
  run("bun", ["install", "--lockfile-only"], { cwd: workDir });

  // 2. The upstream repo and a short write token for it.
  let upstream = wrangler(["repos", "get", UPSTREAM_REPO, "--namespace", namespace]);
  if (!upstream.ok) {
    upstream = wrangler(["repos", "create", UPSTREAM_REPO, "--namespace", namespace, "--default-branch", "main"]);
    if (!upstream.ok) throw new Error(`Could not create the upstream repo:\n${upstream.output}`);
  }
  const remote = upstream.value.remote;
  const issued = wrangler(["repos", "issue-token", UPSTREAM_REPO, "--namespace", namespace, "--scope", "write", "--ttl", "900"]);
  if (!issued.ok) throw new Error(`Could not issue a token:\n${issued.output}`);
  const token = issued.value.plaintext ?? issued.value.token;
  const git = (gitArgs) =>
    run("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...gitArgs], {
      cwd: workDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Stella",
        GIT_AUTHOR_EMAIL: "release@stella.sh",
        GIT_COMMITTER_NAME: "Stella",
        GIT_COMMITTER_EMAIL: "release@stella.sh",
      },
    });

  // 3. One commit on top of the previous publish.
  git(["init", "-q", "-b", "main"]);
  const fetched = spawnSync(
    "git",
    ["-c", `http.extraHeader=Authorization: Bearer ${token}`, "fetch", "-q", remote, "main"],
    { cwd: workDir, encoding: "utf8" },
  ).status === 0;
  if (fetched) git(["reset", "-q", "--soft", "FETCH_HEAD"]);
  git(["add", "-A"]);
  if (fetched && spawnSync("git", ["diff", "--cached", "--quiet", "FETCH_HEAD"], { cwd: workDir }).status === 0) {
    console.log(`Upstream already matches ${sourceSha.slice(0, 12)}; nothing to publish.`);
  } else {
    git(["commit", "-q", "-m", `Stella ${sourceSha.slice(0, 12)}`, "-m", `Stella-Source: ${sourceSha}`]);
    git(["push", "-q", remote, "HEAD:refs/heads/main"]);
    console.log(`Published ${sourceSha.slice(0, 12)} to ${namespace}/${UPSTREAM_REPO} as ${git(["rev-parse", "HEAD"])}.`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

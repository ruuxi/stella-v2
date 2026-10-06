import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyUpdate } from "@stella/desktop/electron/services/app-source/update-plan.js";

/**
 * The three cases pressing Update can be in, built as real repositories.
 *
 * The one that matters is the middle one: a checkout whose history is not
 * upstream's ancestor, so the app cannot fast-forward it, but whose files
 * merge without a single conflict. That used to be reported as a conflict and
 * handed to an agent. Its sub-case — a local tree with no net difference from
 * the upstream commit it last merged, which is what a change and its revert
 * leave behind — has no merge judgement in it at all, and the plan says so.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.stella.local",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.stella.local",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const commit = async (cwd: string, file: string, body: string, message: string) => {
  await fs.writeFile(path.join(cwd, file), body);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
};

const newRepo = async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stella-update-plan-"));
  roots.push(cwd);
  git(cwd, ["init", "-q", "-b", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 1;\n", "U0");
  await commit(cwd, "shell.ts", "export const shell = 'plain';\n", "U0 shell");
  return cwd;
};

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
const plan = (cwd: string) => classifyUpdate(cwd, head(cwd), "refs/heads/upstream");

/**
 * An install's own branch: a change of the user's, their revert of it, and a
 * past update-merge. Upstream then moves on twice.
 */
const divergedInstall = async () => {
  const cwd = await newRepo();
  git(cwd, ["checkout", "-q", "-b", "main"]);
  await commit(cwd, "notes.md", "local notes\n", "A local change");
  git(cwd, ["revert", "--no-edit", "HEAD"]);
  git(cwd, ["checkout", "-q", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 2;\n", "U1");
  git(cwd, ["checkout", "-q", "main"]);
  git(cwd, ["merge", "--no-ff", "-q", "-m", "Merge update U1", "upstream"]);
  git(cwd, ["checkout", "-q", "upstream"]);
  await commit(cwd, "app.ts", "export const app = 3;\n", "U2");
  await commit(cwd, "extra.ts", "export const extra = true;\n", "U3");
  git(cwd, ["checkout", "-q", "main"]);
  return cwd;
};

describe("classifyUpdate", () => {
  it("has nothing to do when upstream is already in", async () => {
    const cwd = await newRepo();
    git(cwd, ["checkout", "-q", "-b", "main"]);
    expect((await plan(cwd)).kind).toBe("none");
  });

  it("fast-forwards when the branch is upstream's ancestor", async () => {
    const cwd = await newRepo();
    git(cwd, ["branch", "main"]);
    await commit(cwd, "app.ts", "export const app = 2;\n", "U1");
    git(cwd, ["checkout", "-q", "main"]);
    const result = await plan(cwd);
    expect(result.kind).toBe("fast-forward");
    if (result.kind !== "fast-forward") return;
    expect(result.count).toBe(1);
    expect(result.subject).toBe("U1");
  });

  it("is clean with nothing to preserve when the local tree matches the merge base", async () => {
    const cwd = await divergedInstall();
    const result = await plan(cwd);
    expect(result.kind).toBe("clean");
    if (result.kind !== "clean") return;
    // Diverged by history alone: three local commits the upstream tip lacks.
    expect(git(cwd, ["rev-list", "--count", `${result.base}..HEAD`])).toBe("3");
    expect(result.localChanges).toBe(false);
    expect(result.identical).toBe(true);
    expect(result.tree).toBe(git(cwd, ["rev-parse", `${result.tip}^{tree}`]));
  });

  it("is clean but has something to preserve when local changes survive the merge", async () => {
    const cwd = await divergedInstall();
    await commit(cwd, "shell.ts", "export const shell = 'redesigned';\n", "Redesign");
    const result = await plan(cwd);
    expect(result.kind).toBe("clean");
    if (result.kind !== "clean") return;
    expect(result.localChanges).toBe(true);
    expect(result.identical).toBe(false);
  });

  it("names the conflicting files when both sides changed the same lines", async () => {
    const cwd = await divergedInstall();
    await commit(cwd, "app.ts", "export const app = 99;\n", "Local app change");
    const result = await plan(cwd);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") return;
    expect(result.conflicts).toEqual(["app.ts"]);
    expect(result.localChanges).toBe(true);
  });

  it("advances the branch to upstream's tree without losing local history", async () => {
    const cwd = await divergedInstall();
    const before = await plan(cwd);
    expect(before.kind).toBe("clean");
    if (before.kind !== "clean") return;
    const at = head(cwd);
    const merged = git(cwd, [
      "commit-tree",
      before.tree,
      "-p",
      at,
      "-p",
      before.tip,
      "-m",
      "Merge the published Stella update",
    ]);
    git(cwd, ["merge", "--ff-only", merged]);
    expect(git(cwd, ["diff", "--name-only", "refs/heads/upstream"])).toBe("");
    expect(git(cwd, ["status", "--porcelain"])).toBe("");
    expect(git(cwd, ["merge-base", "--is-ancestor", at, "HEAD"])).toBe("");
    expect((await plan(cwd)).kind).toBe("none");
  });
});

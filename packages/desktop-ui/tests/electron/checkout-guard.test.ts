import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installCheckoutGuard } from "@stella/desktop/electron/services/app-source/checkout-guard.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("STELLA_") || key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  const shims = process.env.STELLA_NODE_SHIM_DIR;
  return {
    ...env,
    PATH: (env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => !shims || path.resolve(entry) !== path.resolve(shims))
      .join(path.delimiter),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.stella.local",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.stella.local",
    GIT_CONFIG_NOSYSTEM: "1",
  };
};

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync("git", args, {
    cwd,
    env: { ...baseEnv(), ...env },
    encoding: "utf8",
  });

const mustGit = (cwd: string, args: string[]) => {
  const result = git(cwd, args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

const makeRepo = async (root: string, name: string) => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  mustGit(dir, ["init", "-q", "-b", "master"]);
  mustGit(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return dir;
};

const setup = async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "checkout-guard-")),
  );
  roots.push(root);
  const checkout = await makeRepo(root, "checkout");
  const other = await makeRepo(root, "other");
  await installCheckoutGuard(checkout, () => {});
  const drafts = path.join(root, "drafts");
  return { root, checkout, other, drafts };
};

const head = (dir: string) => mustGit(dir, ["rev-parse", "refs/heads/master"]);

describe("checkout guard", () => {
  it("refuses an agent of the Stella running from the checkout moving its branch", async () => {
    const { checkout, drafts } = await setup();
    const before = head(checkout);
    const result = git(checkout, ["commit", "--allow-empty", "-m", "direct"], {
      STELLA_DRAFTS_DIR: drafts,
      STELLA_APP_DIR: checkout,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Stella's running checkout can't be changed directly");
    expect(head(checkout)).toBe(before);
  });

  it("refuses it from a draft worktree too, while draft branches move freely and note their agent", async () => {
    const { checkout, drafts } = await setup();
    const draft = path.join(drafts, "tweak");
    mustGit(checkout, ["worktree", "add", "-q", "-b", "draft/tweak", draft]);
    const env = {
      STELLA_DRAFTS_DIR: drafts,
      STELLA_APP_DIR: checkout,
      STELLA_AGENT_ID: "agent-7",
    };
    const before = head(checkout);
    expect(git(draft, ["commit", "--allow-empty", "-m", "draft"], env).status).toBe(0);
    const noted = await fs.readFile(
      path.join(checkout, ".git", "stella-drafts", "tweak"),
      "utf8",
    );
    expect(noted.trim()).toBe("agent-7");
    const merge = git(draft, ["update-ref", "refs/heads/master", "draft/tweak"], env);
    expect(merge.status).not.toBe(0);
    expect(head(checkout)).toBe(before);
  });

  it("lets an agent of a Stella running from somewhere else move the branch", async () => {
    const { checkout, other, drafts } = await setup();
    const before = head(checkout);
    const result = git(checkout, ["commit", "--allow-empty", "-m", "dev work"], {
      STELLA_DRAFTS_DIR: drafts,
      STELLA_APP_DIR: other,
    });
    expect(result.status).toBe(0);
    expect(head(checkout)).not.toBe(before);
  });

  it("lets agents through when their app dir is gone", async () => {
    const { root, checkout, drafts } = await setup();
    const result = git(checkout, ["commit", "--allow-empty", "-m", "x"], {
      STELLA_DRAFTS_DIR: drafts,
      STELLA_APP_DIR: path.join(root, "missing"),
    });
    expect(result.status).toBe(0);
  });

  it("never blocks shells without an agent's drafts dir", async () => {
    const { checkout } = await setup();
    const result = git(checkout, ["commit", "--allow-empty", "-m", "user"], {
      STELLA_APP_DIR: checkout,
    });
    expect(result.status).toBe(0);
  });

  it("matches the checkout through a symlinked app dir", async () => {
    const { root, checkout, drafts } = await setup();
    const link = path.join(root, "link");
    await fs.symlink(checkout, link);
    const result = git(checkout, ["commit", "--allow-empty", "-m", "x"], {
      STELLA_DRAFTS_DIR: drafts,
      STELLA_APP_DIR: link,
    });
    expect(result.status).not.toBe(0);
  });

  it("replaces an older guard and leaves a foreign hook alone", async () => {
    const { checkout, other } = await setup();
    const hook = path.join(checkout, ".git", "hooks", "reference-transaction");
    expect(await fs.readFile(hook, "utf8")).toContain("stella-checkout-guard v5");

    await fs.writeFile(hook, "#!/bin/sh\n# stella-checkout-guard v4\nexit 1\n");
    await installCheckoutGuard(checkout, () => {});
    expect(await fs.readFile(hook, "utf8")).toContain("stella-checkout-guard v5");

    const foreign = path.join(other, ".git", "hooks", "reference-transaction");
    await fs.writeFile(foreign, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const events: string[] = [];
    await installCheckoutGuard(other, (event) => events.push(event));
    expect(await fs.readFile(foreign, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(events).toEqual(["app-source.checkout-guard-skipped"]);
  });
});

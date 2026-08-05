import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const SCAFFOLD_SCRIPT = path.join(
  REPO_ROOT,
  "packages/home-seed/skills/create-stella-app/scripts/program.ts",
);
const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "stella-app-scaffold-"));
  tempRoots.push(root);
  return root;
}

function runScaffold(stellaDataDir: string, ...args: string[]) {
  return spawnSync("bun", [SCAFFOLD_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, STELLA_DATA_DIR: stellaDataDir },
  });
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("create-stella-app scaffold", () => {
  it("creates one self-contained Vite app under the configured Stella data directory", async () => {
    const stellaDataDir = await makeTempRoot();
    const name = 'Focus <Timer> & "Notes"';
    const result = runScaffold(stellaDataDir, "focus-timer", name);

    expect(result.status, result.stderr).toBe(0);
    const appRoot = path.join(
      stellaDataDir,
      "workspace",
      "apps",
      "focus-timer",
    );
    await expect(stat(appRoot)).resolves.toMatchObject({});
    await expect(listFiles(appRoot)).resolves.toEqual([
      ".gitignore",
      "index.html",
      "package.json",
      "src/App.tsx",
      "src/app.css",
      "src/main.tsx",
      "src/vite-env.d.ts",
      "stella.app.json",
      "tsconfig.json",
      "vite.config.ts",
    ]);

    const manifest = JSON.parse(
      await readFile(path.join(appRoot, "stella.app.json"), "utf8"),
    );
    expect(Object.keys(manifest).sort()).toEqual([
      "createdAt",
      "name",
      "schemaVersion",
      "slug",
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      slug: "focus-timer",
      name,
    });
    expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);

    const packageJson = JSON.parse(
      await readFile(path.join(appRoot, "package.json"), "utf8"),
    );
    expect(packageJson).toMatchObject({
      name: "stella-app-focus-timer",
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        check: "tsc --noEmit",
        build: "tsc --noEmit && vite build",
      },
      dependencies: {
        react: expect.any(String),
        "react-dom": expect.any(String),
      },
    });
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      "react",
      "react-dom",
    ]);

    const viteConfig = await readFile(
      path.join(appRoot, "vite.config.ts"),
      "utf8",
    );
    expect(viteConfig).toContain('base: "./"');
    expect(viteConfig).toContain('host: "127.0.0.1"');
    expect(viteConfig).toContain("port: 0");

    const html = await readFile(path.join(appRoot, "index.html"), "utf8");
    expect(html).toContain(
      "<title>Focus &lt;Timer&gt; &amp; &quot;Notes&quot;</title>",
    );
    const appSource = await readFile(path.join(appRoot, "src/App.tsx"), "utf8");
    expect(appSource).toContain(JSON.stringify(name));
  });

  it("rejects invalid and existing slugs without touching existing app files", async () => {
    const stellaDataDir = await makeTempRoot();
    const first = runScaffold(stellaDataDir, "notes", "Notes");
    expect(first.status, first.stderr).toBe(0);

    const appRoot = path.join(stellaDataDir, "workspace", "apps", "notes");
    const sentinel = path.join(appRoot, "sentinel.txt");
    await writeFile(sentinel, "keep me", "utf8");

    const duplicate = runScaffold(stellaDataDir, "notes", "Replacement");
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("refusing to overwrite existing app");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep me");

    const traversal = runScaffold(stellaDataDir, "../escape", "Escape");
    expect(traversal.status).not.toBe(0);
    expect(traversal.stderr).toContain("invalid slug");
    await expect(
      listFiles(path.join(stellaDataDir, "workspace", "apps")),
    ).resolves.not.toContain("escape/stella.app.json");
  });

  it("does not remove a creation lock owned by another process", async () => {
    const stellaDataDir = await makeTempRoot();
    const appsRoot = path.join(stellaDataDir, "workspace", "apps");
    const lockPath = path.join(appsRoot, ".notes.create.lock");
    await mkdir(appsRoot, { recursive: true });
    await writeFile(lockPath, "other creator", "utf8");

    const result = runScaffold(stellaDataDir, "notes", "Notes");

    expect(result.status).not.toBe(0);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("other creator");
  });

  it("keeps the legacy command as a thin wrapper around the canonical scaffold", async () => {
    const wrapper = await readFile(
      path.join(REPO_ROOT, "packages/desktop/scripts/create-workspace-app.mjs"),
      "utf8",
    );
    const rootPackage = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    );

    expect(wrapper).toContain(
      "../../home-seed/skills/create-stella-app/scripts/program.ts",
    );
    expect(wrapper).not.toContain("desktop/templates/workspace-app");
    expect(wrapper).not.toContain("desktop/workspace");
    expect(rootPackage.scripts["app:create"]).toBe(
      "node packages/desktop/scripts/create-workspace-app.mjs",
    );
    expect(rootPackage.scripts["workspace:create-app"]).toBeUndefined();
  });
});

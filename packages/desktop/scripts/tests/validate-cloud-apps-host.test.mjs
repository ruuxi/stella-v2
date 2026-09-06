import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const validator = path.join(
  repoRoot,
  "packages/desktop/scripts/validate-cloud-apps-host.mjs",
);
const developmentHost = "https://stella-v2-apps-host-dev.lolruuxi.workers.dev";

const runValidator = ({ host, allowDevelopmentHost = false } = {}) =>
  spawnSync(
    process.execPath,
    [validator, ...(allowDevelopmentHost ? ["--allow-development-host"] : [])],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_STELLA_APPS_HOST: host ?? "",
      },
      encoding: "utf8",
    },
  );

test("production validation rejects a missing or development Apps host", () => {
  const missing = runValidator();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /must be configured/);

  const development = runValidator({ host: developmentHost });
  assert.notEqual(development.status, 0);
  assert.match(development.stderr, /development Apps host cannot be embedded/);
});

test("production validation accepts only a configured HTTPS origin", () => {
  const configured = runValidator({ host: "https://apps.stella.example/" });
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /https:\/\/apps\.stella\.example/);

  for (const host of [
    "http://apps.stella.example",
    "https://apps.stella.example/path",
    "https://user@apps.stella.example",
  ]) {
    const invalid = runValidator({ host });
    assert.notEqual(invalid.status, 0, host);
    assert.match(invalid.stderr, /valid HTTPS origin/);
  }
});

test("the development host requires the explicit harness-only flag", () => {
  const development = runValidator({
    host: developmentHost,
    allowDevelopmentHost: true,
  });
  assert.equal(development.status, 0, development.stderr);
});

test("workflows keep the development host out of production packages", () => {
  const release = readFileSync(
    path.join(repoRoot, ".github/workflows/build-desktop-release.yml"),
    "utf8",
  );
  const workflow = YAML.parse(release);
  const resolveStep = workflow.jobs.validate_stable_tag.steps[0];
  const buildStep = workflow.jobs["build-desktop-js"].steps.find(
    (step) => step.name === "Build and validate shared desktop JavaScript",
  );
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push'");
  assert.equal(
    buildStep.env.VITE_STELLA_DEV_APPS_HOST_HARNESS,
    "${{ needs.validate_stable_tag.outputs.target == 'development' && '1' || '0' }}",
  );
  const scratch = mkdtempSync(path.join(tmpdir(), "stella-desktop-release-"));
  try {
    for (const [event, target] of [
      ["workflow_dispatch", "development"],
      ["workflow_dispatch", "production"],
      ["push", "development"], // Tags must ignore any requested dev target.
    ]) {
      const output = path.join(scratch, `${event}-${target}.txt`);
      const resolved = spawnSync("bash", ["-c", resolveStep.run], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          REQUESTED_TARGET: target,
          GITHUB_REF_NAME: "desktop-v2-v0.2.17",
          GITHUB_RUN_NUMBER: "54",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "abcdef0123456789",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: path.join(scratch, "summary"),
        },
      });
      assert.equal(resolved.status, 0, resolved.stderr);
      const values = Object.fromEntries(
        readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")),
      );
      const isDev = event === "workflow_dispatch" && target === "development";
      assert.equal(values.target, isDev ? "development" : "production");
      assert.equal(values.auto_update, event === "push" ? "true" : "false");
      assert.equal(values.convex_url, `https://${isDev ? "outgoing-bulldog-865" : "intent-jackal-330"}.convex.cloud`);
      const buildEnv = Object.fromEntries(Object.entries(buildStep.env).map(([key, value]) => [
        key,
        key === "VITE_STELLA_DEV_APPS_HOST_HARNESS" ? (isDev ? "1" : "0") : value.replace(
          /\$\{\{ needs\.validate_stable_tag\.outputs\.(\w+) \}\}/g,
          (_, name) => { assert.ok(name in values); return values[name]; },
        ),
      ]));
      // Execute the exact workflow validation prefix, without building shared dist.
      const validation = spawnSync("bash", ["-c", buildStep.run.split("bun run build")[0]], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...buildEnv },
      });
      assert.equal(validation.status, 0, validation.stderr);
      assert.match(validation.stdout, /Validated Stella Apps host/);
      assert.equal(buildEnv.VITE_STELLA_DEV_APPS_HOST_HARNESS, isDev ? "1" : "0");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const ci = readFileSync(
    path.join(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(ci, new RegExp(developmentHost.replaceAll(".", "\\.")));
  assert.match(ci, /VITE_STELLA_DEV_APPS_HOST_HARNESS: "1"/);
  assert.match(ci, /validate-cloud-apps-host\.mjs --allow-development-host/);
});

test("manual prerelease versions retain the explicitly configured updater filenames", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { Platform } = builderRequire("app-builder-lib");
  const { getPublishConfigs } = builderRequire("app-builder-lib/out/publish/PublishManager.js");
  const { createUpdateInfoTasks } = builderRequire("app-builder-lib/out/publish/updateInfoBuilder.js");
  const config = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).build;
  for (const target of ["development", "production"]) {
    const version = `0.0.54-${target}.1.abcdef01`;
    for (const [platform, extension, expected] of [
      [Platform.MAC, "zip", "latest-v2-mac.yml"],
      [Platform.WINDOWS, "exe", "latest-v2.yml"],
      [Platform.LINUX, "AppImage", "latest-v2-linux.yml"],
    ]) {
      const appInfo = { version, channel: target };
      const packager = {
        platform,
        config,
        appInfo,
        info: { config, appInfo },
        platformSpecificBuildOptions: {},
        expandMacro: (value) => value.replace("${os}", platform.buildConfigurationKey).replace("${arch}", "x64"),
        getResource: async () => null,
      };
      const publish = await getPublishConfigs(packager, null, 1, true);
      assert.equal(publish[0].channel, "latest-v2");
      const tasks = await createUpdateInfoTasks({
        packager,
        arch: 1, // electron-builder Arch.x64
        file: `/tmp/Stella-${version}.${extension}`,
        target: { outDir: "/tmp" },
        updateInfo: { sha512: "fixture-hash" },
      }, publish);
      assert.deepEqual(tasks.map((task) => path.basename(task.file)), [expected]);
      assert.equal(tasks[0].info.version, version);
    }
  }
});

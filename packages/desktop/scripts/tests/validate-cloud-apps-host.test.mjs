import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(
    release,
    /VITE_STELLA_APPS_HOST: \$\{\{ vars\.VITE_STELLA_APPS_HOST \|\| 'https:\/\/stella-v2-apps-host-prod\.lolruuxi\.workers\.dev' \}\}/,
  );
  assert.match(release, /https:\/\/intent-jackal-330\.convex\.cloud/);
  assert.match(release, /https:\/\/intent-jackal-330\.convex\.site/);
  assert.match(
    release,
    /node packages\/desktop\/scripts\/validate-cloud-apps-host\.mjs/,
  );
  assert.doesNotMatch(
    release,
    new RegExp(developmentHost.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(release, /VITE_STELLA_DEV_APPS_HOST_HARNESS/);

  const ci = readFileSync(
    path.join(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(ci, new RegExp(developmentHost.replaceAll(".", "\\.")));
  assert.match(ci, /VITE_STELLA_DEV_APPS_HOST_HARNESS: "1"/);
  assert.match(ci, /validate-cloud-apps-host\.mjs --allow-development-host/);
});

#!/usr/bin/env node
// Container image metadata is the difference between a working sandbox and
// `Image or container snapshot must be set`. A Worker version that carries no
// `containers` array cannot start one, and the metadata is per version: any
// upload that is not a full Wrangler deploy of this config — a dashboard
// settings save, a raw API script PUT, an account-wide workers.dev rewrite —
// publishes a version without it and silently removes sandboxes from the
// deployment. Production ran that way on 2026-10-07.
//
// The sandbox image holds no Stella code: an agent container installs the code
// bundle its Worker version serves from its static assets (`ASSETS`,
// src/sandbox-code.ts). A version without that binding starts containers that
// cannot run an executor, so the same checks cover it.
//
// `--config` refuses to deploy a config that would upload without containers
// or the code bundle's assets. `--deployed` reads the version actually
// receiving traffic and fails when its metadata lost either.
// `bun run containers:check` runs both.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const environment = option("env") ?? "";
const checkConfig = flag("config") || !flag("deployed");
const checkDeployed = flag("deployed") || !flag("config");

const fail = (message) => {
  console.error(`check-container-metadata: ${message}`);
  process.exit(1);
};

const { rawConfig } = experimental_readRawConfig({
  config: path.join(workerRoot, "wrangler.jsonc"),
});
const envConfig = environment ? rawConfig.env?.[environment] : rawConfig;
if (!envConfig) fail(`wrangler.jsonc has no environment ${environment}.`);
const scriptName = envConfig.name ?? rawConfig.name;

const describeConfigured = (containers) =>
  containers
    .map((container) => {
      const images = container.images
        ? Object.keys(container.images).join(", ")
        : (container.image ?? "unset");
      return `${container.class_name ?? "?"} (${images})`;
    })
    .join("; ");

const configuredContainers = envConfig.containers ?? [];
if (checkConfig) {
  if (configuredContainers.length === 0) {
    fail(
      `environment ${environment || "(default)"} declares no containers; a deploy would publish ${scriptName} without sandbox images.`,
    );
  }
  for (const container of configuredContainers) {
    const hasImage =
      typeof container.image === "string" ||
      (container.images && Object.keys(container.images).length > 0);
    if (!container.class_name || !hasImage) {
      fail(
        `environment ${environment || "(default)"} has a container without a class_name and image.`,
      );
    }
  }
  // `assets` is inherited unless the environment sets its own.
  const assets = envConfig.assets ?? rawConfig.assets;
  if (
    assets?.binding !== "ASSETS" ||
    typeof assets.directory !== "string" ||
    assets.run_worker_first !== true
  ) {
    fail(
      `environment ${environment || "(default)"} must bind the sandbox code bundle's assets as ASSETS with run_worker_first: true; without them agent containers cannot install Stella's code.`,
    );
  }
  console.log(
    `check-container-metadata: config ok — ${scriptName}: ${describeConfigured(configuredContainers)}; code bundle assets ${assets.directory}`,
  );
}

if (!checkDeployed) process.exit(0);

// The Wrangler login is what can read container metadata; the .dev.vars token
// cannot, exactly as deploys require.
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

const wrangler = (commandArgs) => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(workerRoot, "node_modules/wrangler/bin/wrangler.js"),
      ...commandArgs,
      ...(environment ? ["--env", environment] : ["--env", ""]),
      "--json",
    ],
    {
      cwd: workerRoot,
      encoding: "utf8",
      env: wranglerEnv,
    },
  );
  if (result.status !== 0) {
    fail(
      `wrangler ${commandArgs.join(" ")} failed (${result.status}). ${result.stderr?.trim() ?? ""}`,
    );
  }
  const text = result.stdout ?? "";
  const start = text.search(/[[{]/u);
  if (start < 0) fail(`wrangler ${commandArgs.join(" ")} returned no JSON.`);
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return fail(`wrangler ${commandArgs.join(" ")} returned unreadable JSON.`);
  }
};

const deployments = wrangler(["deployments", "list"]);
if (!Array.isArray(deployments) || deployments.length === 0) {
  fail(`${scriptName} has no deployments.`);
}
const live = deployments.reduce((latest, entry) =>
  Date.parse(entry.created_on) > Date.parse(latest.created_on) ? entry : latest,
);
const serving = (live.versions ?? []).reduce(
  (highest, entry) =>
    !highest || (entry.percentage ?? 0) > (highest.percentage ?? 0)
      ? entry
      : highest,
  undefined,
);
if (!serving?.version_id) fail(`${scriptName} has no version serving traffic.`);

const version = wrangler(["versions", "view", serving.version_id]);
const deployed = version?.resources?.script_runtime?.containers ?? [];
const source = version?.metadata?.source ?? "unknown";
if (deployed.length === 0) {
  console.error(
    [
      `check-container-metadata: ${scriptName} version ${serving.version_id} (source ${source}) carries no container image metadata.`,
      "Sandboxes on this deployment fail with: Image or container snapshot must be set for the new runtime.",
      "Restore it by deploying this config again (it builds and uploads the image):",
      `  cd workers/cloud-builder && env -u CLOUDFLARE_API_TOKEN bun run deploy:${environment === "production" ? "production" : environment || "dev"}`,
    ].join("\n"),
  );
  process.exit(1);
}
const bindings = version?.resources?.bindings ?? [];
if (
  !bindings.some(
    (binding) => binding?.name === "ASSETS" && binding?.type === "assets",
  )
) {
  console.error(
    [
      `check-container-metadata: ${scriptName} version ${serving.version_id} (source ${source}) has no ASSETS binding, so it serves no sandbox code bundle.`,
      "Agent containers on this deployment start but cannot install Stella's code, and every agent turn fails.",
      "Restore it by deploying this config again (it builds and uploads the bundle):",
      `  cd workers/cloud-builder && env -u CLOUDFLARE_API_TOKEN bun run deploy:${environment === "production" ? "production" : environment || "dev"}`,
    ].join("\n"),
  );
  process.exit(1);
}
console.log(
  `check-container-metadata: deployed ok — ${scriptName} version ${serving.version_id} (source ${source}) carries ${deployed
    .map(
      (container) =>
        `${container.class_name}=${Object.values(container.images ?? {}).join(",")}`,
    )
    .join("; ")} and the ASSETS code bundle binding`,
);

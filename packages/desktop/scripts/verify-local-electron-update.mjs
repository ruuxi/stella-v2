#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";

if (process.platform !== "darwin") {
  throw new Error(
    "The M4 local apply verification currently runs on macOS; Windows remains unsigned and CI-gated.",
  );
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(
    `Unsupported local verification architecture: ${process.arch}`,
  );
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const oldVersion = process.env.STELLA_V2_LOCAL_OLD_VERSION ?? "0.0.41";
const newVersion = process.env.STELLA_V2_LOCAL_NEW_VERSION ?? "0.0.42";
const arch = process.arch;
const verificationAppId = "com.stella.v2.updateverification";
const verificationProductName = "Stella V2 Update Verification";
const fixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "stella-v2-electron-update-"),
);
const oldOutput = path.join(fixtureRoot, "old");
const newOutput = path.join(fixtureRoot, "new");
const feedDir = path.join(
  fixtureRoot,
  "feed",
  "desktop-v2",
  "stable",
  `mac-${arch}`,
);
const resultPath = path.join(fixtureRoot, "update-result.json");
const isolatedUserData = path.join(fixtureRoot, "user-data");
const verificationMainBundle = path.join(
  repoRoot,
  "packages",
  "desktop",
  "dist-electron",
  "electron",
  "update-verification-main.js",
);
const verificationUpdaterCacheDir = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "stella-v2-update-verification-updater",
);
const verificationShipItCacheDir = path.join(
  os.homedir(),
  "Library",
  "Caches",
  `${verificationAppId}.ShipIt`,
);

const createVerificationEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("STELLA_")) delete environment[key];
  }
  return environment;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}).`);
  }
};

const buildVersion = (version, outputDir) => {
  run(
    path.join(repoRoot, "node_modules", ".bin", "electron-builder"),
    [
      "--mac",
      "zip",
      `--${arch}`,
      "--publish",
      "never",
      `--config.directories.output=${outputDir}`,
      `--config.extraMetadata.version=${version}`,
      "--config.extraMetadata.name=stella-v2-update-verification",
      `--config.extraMetadata.productName=${verificationProductName}`,
      "--config.extraMetadata.main=dist-electron/electron/update-verification-main.js",
      "--config.extraMetadata.stellaUpdateVerification=true",
      `--config.extraMetadata.stellaUpdateVerificationBundleId=${verificationAppId}`,
      `--config.appId=${verificationAppId}`,
      `--config.productName=${verificationProductName}`,
      "--config.mac.identity=-",
      "--config.mac.hardenedRuntime=false",
      "--config.forceCodeSigning=false",
    ],
    {
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        STELLA_SKIP_NOTARIZE: "1",
      },
    },
  );
};

const findFile = (root, predicate) => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(candidate, predicate);
      if (nested) return nested;
    } else if (predicate(candidate)) {
      return candidate;
    }
  }
  return null;
};

const serveFile = (request, response, root) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const decoded = decodeURIComponent(requestUrl.pathname);
  const resolved = path.resolve(root, `.${decoded}`);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    response.writeHead(404).end();
    return;
  }
  const size = statSync(resolved).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  const contentType = resolved.endsWith(".yml")
    ? "application/x-yaml"
    : resolved.endsWith(".zip")
      ? "application/zip"
      : "application/octet-stream";
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Type", contentType);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    response.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    createReadStream(resolved, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { "Content-Length": size });
  createReadStream(resolved).pipe(response);
};

const waitForVerificationResult = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(resultPath, "utf8"));
      if (last.phase === "downloaded" || last.phase === "failed") {
        return last;
      }
    } catch {
      // The old build has not emitted its first updater state yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for the updater to download ${newVersion}; last state: ${JSON.stringify(last)}`,
  );
};

let server;
let child;
let succeeded = false;
try {
  console.log(`[local-update] Fixture: ${fixtureRoot}`);
  run("bun", ["run", "packaging:prepare-bun"]);
  run("bun", ["run", "build"]);
  run("bun", ["run", "electron:typecheck"]);
  run("node", [
    "packages/desktop/scripts/dev-electron-build.mjs",
    "--once",
    "--local-update-verification",
  ]);

  console.log(`[local-update] Building old packaged app ${oldVersion}.`);
  buildVersion(oldVersion, oldOutput);
  console.log(`[local-update] Building new packaged app ${newVersion}.`);
  buildVersion(newVersion, newOutput);

  const metadataPath = path.join(newOutput, "latest-v2-mac.yml");
  const metadata = parseYaml(await readFile(metadataPath, "utf8"));
  if (metadata.version !== newVersion) {
    throw new Error(
      `Updater metadata version mismatch: ${metadata.version} !== ${newVersion}`,
    );
  }
  await mkdir(feedDir, { recursive: true });
  for (const entry of readdirSync(newOutput, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (entry.name === "latest-v2-mac.yml" ||
        entry.name.endsWith(".zip") ||
        entry.name.endsWith(".blockmap"))
    ) {
      await copyFile(
        path.join(newOutput, entry.name),
        path.join(feedDir, entry.name),
      );
    }
  }

  server = http.createServer((request, response) =>
    serveFile(request, response, path.join(fixtureRoot, "feed")),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local updater server did not expose a TCP port.");
  }
  const feedUrl = `http://127.0.0.1:${address.port}/desktop-v2/stable/mac-${arch}`;
  const oldApp = findFile(oldOutput, (candidate) =>
    candidate.endsWith(
      `${verificationProductName}.app/Contents/MacOS/${verificationProductName}`,
    ),
  );
  if (!oldApp)
    throw new Error("Could not find the old packaged Stella executable.");

  console.log(`[local-update] Serving isolated feed at ${feedUrl}.`);
  child = spawn(oldApp, ["--stella-verify-local-update"], {
    cwd: fixtureRoot,
    env: {
      ...createVerificationEnvironment(),
      STELLA_V2_LOCAL_UPDATE_EXPECTED: newVersion,
      STELLA_V2_LOCAL_UPDATE_FEED_URL: feedUrl,
      STELLA_V2_LOCAL_UPDATE_RESULT: resultPath,
      STELLA_V2_LOCAL_UPDATE_USER_DATA: isolatedUserData,
      STELLA_V2_LOCAL_UPDATE_VERIFY_TOKEN: randomUUID(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childLog = "";
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    childLog += text;
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    childLog += text;
    process.stderr.write(text);
  });

  const result = await waitForVerificationResult(4 * 60 * 1_000);
  if (
    result.phase !== "downloaded" ||
    result.currentVersion !== oldVersion ||
    result.downloadedVersion !== newVersion
  ) {
    throw new Error(
      `Packaged update was not downloaded: ${JSON.stringify(result)}\n${childLog}`,
    );
  }
  console.log(
    `[local-update] PASS ${oldVersion} detected and downloaded ${newVersion} from the isolated feed.`,
  );
  succeeded = true;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  // Squirrel.Mac can finish materializing its test-only cache just after the
  // Electron process exits. Give that helper a bounded drain window, then
  // retry exact-path cleanup so the automated verifier leaves no payload.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Promise.all([
      rm(verificationUpdaterCacheDir, { recursive: true, force: true }),
      rm(verificationShipItCacheDir, { recursive: true, force: true }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await rm(verificationMainBundle, { force: true });
  if (succeeded && process.env.STELLA_KEEP_LOCAL_UPDATE_FIXTURE !== "1") {
    await rm(fixtureRoot, { recursive: true, force: true });
  } else {
    console.log(`[local-update] Preserved fixture at ${fixtureRoot}`);
  }
}

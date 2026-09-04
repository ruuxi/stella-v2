#!/usr/bin/env node

/**
 * Exercise the production Apps Host bundle in the actual local workerd runtime.
 *
 * This is deliberately not a unit-test adapter: Wrangler creates the same
 * bundle used for deployment, its local KV/R2 implementations are seeded
 * through Wrangler's public CLI, and `wrangler dev --local` starts workerd.
 * The caller receives only bounded, credential-free observations and hashes.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { realpathSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKER_ROOT = realpathSync(path.resolve(path.dirname(SCRIPT_FILE), ".."));
const REPO_ROOT = realpathSync(path.resolve(WORKER_ROOT, "../.."));
const LIVE_STELLA_ROOT = path.resolve(homedir(), ".stella");
const WRANGLER = path.join(
  WORKER_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const CONFIG = path.join(WORKER_ROOT, "wrangler.jsonc");
const WRANGLER_ENV = "bn118";
const EXPECTED_DEPLOYMENT = "preview:basic-nightingale-118";
const EXPECTED_WORKER_NAME = "stella-v2-apps-host-basic-nightingale-118";
const EXPECTED_CONVEX_SITE_ORIGIN = "https://basic-nightingale-118.convex.site";
const APP_BUILDS_BUCKET = "stella-v2-app-builds-basic-nightingale-118";
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 45_000;

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const pathExists = async (candidate) => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const boundedString = (value, label, maximum = 512) => {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `${label} must be a bounded string without control characters.`,
  );
  return value;
};

const safeStateDirectory = async (declared) => {
  assert(
    path.isAbsolute(declared),
    "Apps Host workerd state must be absolute.",
  );
  const parent = realpathSync(path.dirname(path.resolve(declared)));
  const resolved = path.join(parent, path.basename(declared));
  assert(
    path.basename(resolved) === "apps-host-workerd" &&
      resolved !== parent &&
      !inside(resolved, REPO_ROOT) &&
      !inside(REPO_ROOT, resolved) &&
      !inside(resolved, LIVE_STELLA_ROOT) &&
      !inside(LIVE_STELLA_ROOT, resolved),
    "Apps Host workerd state must be the narrow disposable apps-host-workerd directory outside protected state.",
  );
  try {
    await lstat(resolved);
    throw new Error("Apps Host workerd state already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolved;
};

const runCommand = async (args, { timeoutMs = 120_000 } = {}) => {
  const startedAt = Date.now();
  const child = spawn(WRANGLER, args, {
    cwd: WORKER_ROOT,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      WRANGLER_LOG: "none",
      WRANGLER_SEND_METRICS: "false",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  const take = (chunk) => {
    if (overflow) return;
    const copy = Buffer.from(chunk);
    bytes += copy.byteLength;
    if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(copy);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Wrangler command timed out."));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const output = Buffer.concat(chunks).toString("utf8");
  assert(!overflow, "Wrangler command output exceeded 4 MiB.");
  assert(
    result.code === 0 && !result.signal,
    `Wrangler command failed (output ${sha256(output)}).`,
  );
  return {
    outputSha256: sha256(output),
    durationMs: Date.now() - startedAt,
  };
};

const availablePort = async () =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(
        address && typeof address === "object",
        "Could not reserve a local workerd port.",
      );
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const startWorkerd = async ({ persistenceDirectory, extraVars = [] }) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--local",
      "--config",
      CONFIG,
      "--env",
      WRANGLER_ENV,
      "--persist-to",
      persistenceDirectory,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      ...extraVars.flatMap(([key, value]) => ["--var", `${key}:${value}`]),
    ],
    {
      cwd: WORKER_ROOT,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_LOG: "none",
        WRANGLER_SEND_METRICS: "false",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  let outputBytes = 0;
  let overflow = false;
  const take = (chunk) => {
    if (overflow) return;
    const copy = Buffer.from(chunk);
    outputBytes += copy.byteLength;
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    chunks.push(copy);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let closed = false;
  let closeResult;
  const closedPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      resolve(closeResult);
    });
  });

  const stop = async () => {
    if (!closed) {
      child.kill("SIGTERM");
      await Promise.race([
        closedPromise,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (!closed) {
      child.kill("SIGKILL");
      await closedPromise;
    }
    const output = Buffer.concat(chunks).toString("utf8");
    assert(!overflow, "Workerd process output exceeded 4 MiB.");
    return {
      processOutputSha256: sha256(output),
      processExitSha256: sha256(canonicalJson(closeResult)),
    };
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (closed) {
      const output = Buffer.concat(chunks).toString("utf8");
      throw new Error(
        `Workerd exited before readiness (output ${sha256(output)}).`,
      );
    }
    try {
      const response = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.arrayBuffer();
      return {
        child,
        origin,
        startDurationMs: Date.now() - startedAt,
        stop,
      };
    } catch {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error("Workerd did not become ready before its deadline.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

const readResponse = async (origin, pathname, init = {}) => {
  const startedAt = Date.now();
  const response = await fetch(`${origin}${pathname}`, {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(
    bytes.byteLength <= 2 * 1024 * 1024,
    "Apps Host response is too large.",
  );
  return {
    status: response.status,
    headers: Object.fromEntries(
      [
        "cache-control",
        "content-length",
        "content-security-policy",
        "content-type",
        "etag",
        "referrer-policy",
        "x-content-type-options",
      ].map((name) => [name, response.headers.get(name)]),
    ),
    bytes,
    responseSha256: sha256(bytes),
    durationMs: Date.now() - startedAt,
  };
};

const receipt = (operation, fields = {}) => ({
  at: new Date().toISOString(),
  surface: "apps-host-workerd",
  operation,
  mocked: false,
  synthetic: false,
  ...fields,
});

export const runAppsHostWorkerdAcceptance = async ({
  stateDirectory: declaredStateDirectory,
  runId,
}) => {
  boundedString(runId, "Apps Host acceptance run id", 128);
  await access(WRANGLER);
  await access(CONFIG);
  const stateDirectory = await safeStateDirectory(declaredStateDirectory);
  const projectWranglerDirectory = path.join(WORKER_ROOT, ".wrangler");
  const projectWranglerDirectoryExisted = await pathExists(
    projectWranglerDirectory,
  );
  const persistenceDirectory = path.join(stateDirectory, "workerd-state");
  const bundleDirectory = path.join(stateDirectory, "bundle");
  const fixtureDirectory = path.join(stateDirectory, "fixtures");
  const receipts = [];
  let workerd;
  let invalidWorkerd;
  let observations;
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(persistenceDirectory, { mode: 0o700 });
    await mkdir(bundleDirectory, { mode: 0o700 });
    await mkdir(fixtureDirectory, { mode: 0o700 });

    const identityHash = sha256(`apps-host-workerd\n${runId}`);
    const slug = `acceptance-${identityHash.slice(0, 24)}`;
    const appPrefix = `builds/${identityHash}/run-${identityHash.slice(0, 20)}`;
    const appBody = `<!doctype html><meta charset="utf-8"><title>Apps Host acceptance</title><p>${runId}</p>`;
    const appFile = path.join(fixtureDirectory, "app-index.html");
    await writeFile(appFile, appBody, { mode: 0o600, flag: "wx" });

    const build = await runCommand([
      "deploy",
      "--dry-run",
      "--outdir",
      bundleDirectory,
      "--config",
      CONFIG,
      "--env",
      WRANGLER_ENV,
    ]);
    const bundlePath = path.join(bundleDirectory, "index.js");
    const bundleBytes = await readFile(bundlePath);
    assert(
      bundleBytes.byteLength > 0,
      "Wrangler emitted an empty Apps Host bundle.",
    );
    const bundleSha256 = sha256(bundleBytes);
    receipts.push(
      receipt("apps-host.bundle.production", {
        outcome: "built",
        processOutputSha256: build.outputSha256,
        responseSha256: bundleSha256,
        bytes: bundleBytes.byteLength,
        durationMs: build.durationMs,
      }),
    );

    const kvSeedStartedAt = Date.now();
    await runCommand([
      "kv",
      "key",
      "put",
      `app:${slug}`,
      JSON.stringify({
        artifactPrefix: appPrefix,
        appId: `app-${identityHash.slice(0, 24)}`,
        slug,
        suspended: false,
      }),
      "--binding",
      "APP_ROUTES",
      "--local",
      "--persist-to",
      persistenceDirectory,
      "--config",
      CONFIG,
      "--env",
      WRANGLER_ENV,
    ]);
    receipts.push(
      receipt("apps-host.binding.kv.seed", {
        outcome: "written",
        resourceIdSha256: sha256(`${slug}\n${appPrefix}`),
        count: 1,
        durationMs: Date.now() - kvSeedStartedAt,
      }),
    );

    const r2SeedStartedAt = Date.now();
    for (const [key, file, contentType] of [
      [`${appPrefix}/index.html`, appFile, "text/html; charset=utf-8"],
    ]) {
      await runCommand([
        "r2",
        "object",
        "put",
        `${APP_BUILDS_BUCKET}/${key}`,
        "--file",
        file,
        "--content-type",
        contentType,
        "--local",
        "--persist-to",
        persistenceDirectory,
        "--config",
        CONFIG,
        "--env",
        WRANGLER_ENV,
      ]);
    }
    receipts.push(
      receipt("apps-host.binding.r2.seed", {
        outcome: "written",
        objectKeySha256: sha256(appPrefix),
        bytes: Buffer.byteLength(appBody),
        count: 1,
        durationMs: Date.now() - r2SeedStartedAt,
      }),
    );

    workerd = await startWorkerd({ persistenceDirectory });
    receipts.push(
      receipt("apps-host.workerd.start", {
        outcome: "ready",
        resourceIdSha256: sha256(workerd.origin),
        durationMs: workerd.startDurationMs,
      }),
    );

    const health = await readResponse(workerd.origin, "/healthz");
    const healthBody = JSON.parse(health.bytes.toString("utf8"));
    assert(health.status === 200, "Apps Host workerd health request failed.");
    assert(
      healthBody?.ok === true &&
        healthBody?.service === "stella-v2-apps-host" &&
        healthBody?.deployment === EXPECTED_DEPLOYMENT,
      "Apps Host workerd health identity drifted.",
    );
    receipts.push(
      receipt("apps-host.http.health", {
        status: health.status,
        requestIdSha256: sha256("GET /healthz"),
        responseSha256: health.responseSha256,
        bytes: health.bytes.byteLength,
        durationMs: health.durationMs,
      }),
    );

    const assetPath = `/_stella/apps-assets/${slug}/`;
    const asset = await readResponse(workerd.origin, assetPath);
    const csp = asset.headers["content-security-policy"] ?? "";
    assert(
      asset.status === 200,
      `Apps Host workerd app asset request failed with ${asset.status}: ${asset.bytes.toString("utf8").slice(0, 512)}`,
    );
    assert(
      asset.bytes.toString("utf8") === appBody,
      "Apps Host asset bytes drifted.",
    );
    assert(
      asset.headers["cache-control"] === "no-cache",
      "Apps Host app shell cache policy drifted.",
    );
    assert(
      asset.headers["x-content-type-options"] === "nosniff",
      "Apps Host omitted nosniff.",
    );
    assert(
      csp.includes("default-src 'self'"),
      "Apps Host CSP omitted its self boundary.",
    );
    assert(
      csp.includes(EXPECTED_CONVEX_SITE_ORIGIN),
      "Apps Host CSP omitted pinned Convex.",
    );
    assert(
      !/outgoing-bulldog-865|impartial-crab-34|flexible-panther-999|benevolent-minnow-586/iu.test(
        csp,
      ),
      "Apps Host CSP retained a forbidden target.",
    );
    receipts.push(
      receipt("apps-host.http.app-asset", {
        status: asset.status,
        requestIdSha256: sha256(`GET ${assetPath}`),
        resourceIdSha256: sha256(appPrefix),
        responseSha256: asset.responseSha256,
        bytes: asset.bytes.byteLength,
        durationMs: asset.durationMs,
      }),
    );

    const head = await readResponse(workerd.origin, assetPath, {
      method: "HEAD",
    });
    assert(
      head.status === 200 && head.bytes.byteLength === 0,
      "Apps Host HEAD semantics drifted.",
    );
    assert(
      Number(head.headers["content-length"]) === Buffer.byteLength(appBody),
      "Apps Host HEAD content length drifted.",
    );
    receipts.push(
      receipt("apps-host.http.app-head", {
        status: head.status,
        requestIdSha256: sha256(`HEAD ${assetPath}`),
        responseSha256: head.responseSha256,
        bytes: head.bytes.byteLength,
        durationMs: head.durationMs,
      }),
    );

    const blockedProxy = await readResponse(workerd.origin, "/api/apps/fetch", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ input: "https://127.0.0.1/private" }),
    });
    assert(
      blockedProxy.status === 401,
      "Apps Host did not reject an unauthenticated proxy request.",
    );
    receipts.push(
      receipt("apps-host.http.proxy-unauthenticated", {
        status: blockedProxy.status,
        requestIdSha256: sha256("POST /api/apps/fetch unauthenticated"),
        responseSha256: blockedProxy.responseSha256,
        bytes: blockedProxy.bytes.byteLength,
        durationMs: blockedProxy.durationMs,
      }),
    );

    const stopped = await workerd.stop();
    workerd = undefined;
    receipts.push(
      receipt("apps-host.workerd.stop", {
        outcome: "disposed",
        processOutputSha256: stopped.processOutputSha256,
        responseSha256: stopped.processExitSha256,
      }),
    );

    invalidWorkerd = await startWorkerd({
      persistenceDirectory,
      extraVars: [["STELLA_DEPLOYMENT_IDENTITY", "preview:rejected-target"]],
    });
    const rejected = await readResponse(invalidWorkerd.origin, "/healthz");
    assert(
      rejected.status === 503,
      "Apps Host served health under an invalid authority binding.",
    );
    const rejectedStopped = await invalidWorkerd.stop();
    invalidWorkerd = undefined;
    receipts.push(
      receipt("apps-host.workerd.invalid-config", {
        status: rejected.status,
        outcome: "rejected",
        requestIdSha256: sha256("GET /healthz invalid-authority"),
        responseSha256: rejected.responseSha256,
        processOutputSha256: rejectedStopped.processOutputSha256,
        bytes: rejected.bytes.byteLength,
        durationMs: rejected.durationMs,
      }),
    );

    observations = {
      workerName: EXPECTED_WORKER_NAME,
      deploymentIdentity: EXPECTED_DEPLOYMENT,
      runtimeEngine: "workerd",
      wranglerVersion: "4.127.1",
      bundleSha256,
      bundleBytes: bundleBytes.byteLength,
      routeSetSha256: sha256(`${slug}\n${appPrefix}`),
      appAssetSha256: asset.responseSha256,
      blockedProxyResponseSha256: blockedProxy.responseSha256,
      healthStatus: health.status,
      appAssetStatus: asset.status,
      appHeadStatus: head.status,
      blockedProxyStatus: blockedProxy.status,
      invalidConfigStatus: rejected.status,
      productionBundleBuilt: true,
      workerdRuntimeStarted: true,
      realKvBindingUsed: true,
      realR2BindingUsed: true,
      strictHostedContentSecurityPolicy: true,
      unauthenticatedProxyBlockedBeforeFetch: true,
      invalidConfigurationFailedClosed: true,
      runtimeDisposed: true,
    };
  } finally {
    if (workerd) await workerd.stop().catch(() => undefined);
    if (invalidWorkerd) await invalidWorkerd.stop().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
    if (!projectWranglerDirectoryExisted) {
      for (const generatedDirectory of [
        path.join(projectWranglerDirectory, "tmp", "email"),
        path.join(projectWranglerDirectory, "tmp"),
        projectWranglerDirectory,
      ]) {
        await rmdir(generatedDirectory).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    }
  }
  assert(
    (await readdir(path.dirname(stateDirectory))).includes(
      path.basename(stateDirectory),
    ) === false,
    "Apps Host workerd state was not removed.",
  );
  assert(
    projectWranglerDirectoryExisted ||
      !(await pathExists(projectWranglerDirectory)),
    "Apps Host acceptance created persistent project-local Wrangler state.",
  );
  receipts.push(
    receipt("apps-host.workerd.cleanup", {
      outcome: "removed",
      resourceIdSha256: sha256(stateDirectory),
    }),
  );
  return {
    observations: {
      ...observations,
      isolatedStateRemoved: true,
      receiptChainSha256: sha256(canonicalJson(receipts)),
    },
    receipts,
  };
};

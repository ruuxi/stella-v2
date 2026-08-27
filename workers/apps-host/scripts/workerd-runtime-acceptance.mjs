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
import { createHash, randomUUID } from "node:crypto";
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
const EXPECTED_DEPLOYMENT = "dev:impartial-crab-34";
const EXPECTED_WORKER_NAME = "stella-v2-apps-host-dev";
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
  const ephemeralServiceSecret = `acceptance-${sha256(randomUUID())}`;
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--local",
      "--config",
      CONFIG,
      "--persist-to",
      persistenceDirectory,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      "--var",
      `BUILDER_SERVICE_SECRET:${ephemeralServiceSecret}`,
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
    const interiorPrefix = `interior/run-${identityHash.slice(0, 20)}`;
    const routeId = "sr_12345678-1234-4123-8123-123456789abc";
    const appBody = `<!doctype html><meta charset="utf-8"><title>Apps Host acceptance</title><p>${runId}</p>`;
    const interiorBody = `<!doctype html><meta charset="utf-8"><title>Interior acceptance</title>`;
    const bundleBody = Buffer.from(`PK\u0003\u0004${identityHash}`, "utf8");
    const appFile = path.join(fixtureDirectory, "app-index.html");
    const interiorFile = path.join(fixtureDirectory, "interior-index.html");
    const bundleFile = path.join(fixtureDirectory, "bundle.zip");
    await writeFile(appFile, appBody, { mode: 0o600, flag: "wx" });
    await writeFile(interiorFile, interiorBody, { mode: 0o600, flag: "wx" });
    await writeFile(bundleFile, bundleBody, { mode: 0o600, flag: "wx" });

    const build = await runCommand([
      "deploy",
      "--dry-run",
      "--outdir",
      bundleDirectory,
      "--config",
      CONFIG,
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
    for (const [key, value] of [
      [
        `app:${slug}`,
        JSON.stringify({ artifactPrefix: appPrefix, suspended: false }),
      ],
      [
        "app:stella-interior",
        JSON.stringify({ artifactPrefix: interiorPrefix, suspended: false }),
      ],
    ]) {
      await runCommand([
        "kv",
        "key",
        "put",
        key,
        value,
        "--binding",
        "APP_ROUTES",
        "--local",
        "--persist-to",
        persistenceDirectory,
        "--config",
        CONFIG,
      ]);
    }
    receipts.push(
      receipt("apps-host.binding.kv.seed", {
        outcome: "written",
        resourceIdSha256: sha256(`${slug}\n${appPrefix}\n${interiorPrefix}`),
        count: 2,
        durationMs: Date.now() - kvSeedStartedAt,
      }),
    );

    const r2SeedStartedAt = Date.now();
    for (const [key, file, contentType] of [
      [`${appPrefix}/index.html`, appFile, "text/html; charset=utf-8"],
      [
        `${interiorPrefix}/index.html`,
        interiorFile,
        "text/html; charset=utf-8",
      ],
      [`${interiorPrefix}/bundle.zip`, bundleFile, "application/zip"],
    ]) {
      await runCommand([
        "r2",
        "object",
        "put",
        `stella-v2-app-builds-dev/${key}`,
        "--file",
        file,
        "--content-type",
        contentType,
        "--local",
        "--persist-to",
        persistenceDirectory,
        "--config",
        CONFIG,
      ]);
    }
    receipts.push(
      receipt("apps-host.binding.r2.seed", {
        outcome: "written",
        objectKeySha256: sha256(`${appPrefix}\n${interiorPrefix}`),
        bytes:
          Buffer.byteLength(appBody) +
          Buffer.byteLength(interiorBody) +
          bundleBody.byteLength,
        count: 3,
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

    const asset = await readResponse(workerd.origin, `/apps/${slug}/`);
    const csp = asset.headers["content-security-policy"] ?? "";
    assert(asset.status === 200, "Apps Host workerd app asset request failed.");
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
      csp.includes("https://impartial-crab-34.convex.site"),
      "Apps Host CSP omitted pinned Convex.",
    );
    assert(
      !/flexible-panther-999|benevolent-minnow-586/iu.test(csp),
      "Apps Host CSP retained a forbidden target.",
    );
    receipts.push(
      receipt("apps-host.http.app-asset", {
        status: asset.status,
        requestIdSha256: sha256(`GET /apps/${slug}/`),
        resourceIdSha256: sha256(appPrefix),
        responseSha256: asset.responseSha256,
        bytes: asset.bytes.byteLength,
        durationMs: asset.durationMs,
      }),
    );

    const head = await readResponse(workerd.origin, `/apps/${slug}/`, {
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
        requestIdSha256: sha256(`HEAD /apps/${slug}/`),
        responseSha256: head.responseSha256,
        bytes: head.bytes.byteLength,
        durationMs: head.durationMs,
      }),
    );

    const manifest = await readResponse(
      workerd.origin,
      "/api/interior/manifest",
    );
    const manifestBody = JSON.parse(manifest.bytes.toString("utf8"));
    assert(manifest.status === 200, "Apps Host interior manifest failed.");
    assert(
      manifestBody?.version === interiorPrefix &&
        manifestBody?.bundleUrl ===
          `${workerd.origin}/apps/stella-interior/bundle.zip` &&
        manifestBody?.remoteUrl === `${workerd.origin}/apps/stella-interior/`,
      "Apps Host same-origin interior manifest drifted.",
    );
    receipts.push(
      receipt("apps-host.http.interior-manifest", {
        status: manifest.status,
        requestIdSha256: sha256("GET /api/interior/manifest"),
        resourceIdSha256: sha256(interiorPrefix),
        responseSha256: manifest.responseSha256,
        bytes: manifest.bytes.byteLength,
        durationMs: manifest.durationMs,
      }),
    );

    const interior = await readResponse(
      workerd.origin,
      "/apps/stella-interior/",
    );
    const interiorBundle = await readResponse(
      workerd.origin,
      "/apps/stella-interior/bundle.zip",
    );
    assert(
      interior.status === 200 &&
        interior.bytes.toString("utf8") === interiorBody,
      "Apps Host interior asset bytes drifted.",
    );
    assert(
      interiorBundle.status === 200 &&
        interiorBundle.responseSha256 === sha256(bundleBody),
      "Apps Host interior bundle bytes drifted.",
    );
    assert(
      interiorBundle.headers["content-type"] === "application/zip",
      "Apps Host interior bundle type drifted.",
    );
    receipts.push(
      receipt("apps-host.http.interior-assets", {
        status: interior.status,
        requestIdSha256: sha256("GET /apps/stella-interior/*"),
        resourceIdSha256: sha256(interiorPrefix),
        responseSha256: sha256(
          `${interior.responseSha256}\n${interiorBundle.responseSha256}`,
        ),
        bytes: interior.bytes.byteLength + interiorBundle.bytes.byteLength,
        count: 2,
        durationMs: interior.durationMs + interiorBundle.durationMs,
      }),
    );

    const handoff = await readResponse(
      workerd.origin,
      `/stella/${routeId}/auth`,
    );
    const handoffScript = await readResponse(
      workerd.origin,
      "/_stella/browser-auth-handoff.js",
    );
    const handoffHtml = handoff.bytes.toString("utf8");
    const handoffJs = handoffScript.bytes.toString("utf8");
    assert(
      handoff.status === 200 && handoffScript.status === 200,
      "Apps Host auth handoff route failed.",
    );
    assert(
      handoffHtml.includes("/_stella/browser-auth-handoff.js"),
      "Auth handoff omitted its reviewed script.",
    );
    assert(
      handoffJs.includes("/api/auth/cross-domain/one-time-token/verify"),
      "Auth handoff omitted one-time verification.",
    );
    assert(
      handoff.headers["cache-control"] === "no-store",
      "Auth handoff must not be cached.",
    );
    assert(
      handoff.headers["referrer-policy"] === "no-referrer",
      "Auth handoff must suppress referrers.",
    );
    receipts.push(
      receipt("apps-host.http.auth-handoff", {
        status: handoff.status,
        requestIdSha256: sha256(`GET /stella/${routeId}/auth`),
        responseSha256: sha256(
          `${handoff.responseSha256}\n${handoffScript.responseSha256}`,
        ),
        bytes: handoff.bytes.byteLength + handoffScript.bytes.byteLength,
        count: 2,
        durationMs: handoff.durationMs + handoffScript.durationMs,
      }),
    );

    const blockedProxy = await readResponse(workerd.origin, "/api/apps/fetch", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ input: "https://127.0.0.1/private" }),
    });
    assert(
      blockedProxy.status === 400,
      "Apps Host did not reject a private proxy target.",
    );
    receipts.push(
      receipt("apps-host.http.proxy-private-target", {
        status: blockedProxy.status,
        requestIdSha256: sha256("POST /api/apps/fetch private-target"),
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
      extraVars: [["STELLA_DEPLOYMENT_IDENTITY", "dev:rejected-target"]],
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
      wranglerVersion: "4.113.0",
      bundleSha256,
      bundleBytes: bundleBytes.byteLength,
      routeSetSha256: sha256(`${slug}\n${appPrefix}\n${interiorPrefix}`),
      appAssetSha256: asset.responseSha256,
      interiorManifestSha256: manifest.responseSha256,
      interiorAssetsSha256: sha256(
        `${interior.responseSha256}\n${interiorBundle.responseSha256}`,
      ),
      authHandoffSha256: sha256(
        `${handoff.responseSha256}\n${handoffScript.responseSha256}`,
      ),
      blockedProxyResponseSha256: blockedProxy.responseSha256,
      healthStatus: health.status,
      appAssetStatus: asset.status,
      appHeadStatus: head.status,
      interiorManifestStatus: manifest.status,
      interiorAssetStatus: interior.status,
      interiorBundleStatus: interiorBundle.status,
      authHandoffStatus: handoff.status,
      blockedProxyStatus: blockedProxy.status,
      invalidConfigStatus: rejected.status,
      productionBundleBuilt: true,
      workerdRuntimeStarted: true,
      realKvBindingUsed: true,
      realR2BindingUsed: true,
      sameOriginInteriorManifest: true,
      strictHostedContentSecurityPolicy: true,
      authHandoffNoStore: true,
      privateProxyTargetBlockedBeforeFetch: true,
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

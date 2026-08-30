import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(root, "src/index.ts");
const secret = "workerd-only-app-token-key-000000000000000000";

const freePort = async () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });

const config = ({ name, role, auth }) => ({
  name,
  main: entrypoint,
  compatibility_date: "2026-07-22",
  compatibility_flags: ["nodejs_compat"],
  ...(auth
    ? {}
    : {
        services: [
          { binding: "APP_AUTH", service: "apps-auth-test", entrypoint: "AppsAuthService" },
        ],
        durable_objects: {
          bindings: [{ name: "APP_FETCH_GATE", class_name: "AppFetchGate" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["AppFetchGate"] }],
      }),
  vars: {
    STELLA_DEPLOYMENT_IDENTITY: "dev:outgoing-bulldog-865",
    HOST_ROLE: role,
    SHARES_DISABLED: "false",
    CONVEX_SITE_URL: "https://outgoing-bulldog-865.convex.site",
    CONVEX_CLOUD_URL: "https://outgoing-bulldog-865.convex.cloud",
    APPS_HOST_ORIGIN: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
    TRUSTED_APPS_HOST_ORIGIN: "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
    CLOUD_BUILDER_ORIGIN: "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev",
    ...(auth
      ? {
          BUILDER_SERVICE_SECRET: "workerd-only-builder-secret-000000000000000000",
          APP_TOKEN_SIGNING_KEY: secret,
        }
      : {}),
  },
  ...(auth
    ? {}
    : {
        r2_buckets: [{ binding: "APP_BUILDS", bucket_name: `${name}-r2` }],
        kv_namespaces: [{ binding: "APP_ROUTES", id: "00000000000000000000000000000000" }],
      }),
});

const encrypt = async (payload) => {
  const key = await crypto.subtle.importKey(
    "raw",
    createHash("sha256").update(secret).digest(),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const encode = (value) => Buffer.from(value).toString("base64url");
  return `v2.${encode(nonce)}.${encode(ciphertext)}`;
};

const waitForHealth = async (port, process) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (process.exitCode !== null) throw new Error("Workerd exited before readiness.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workerd did not become ready.");
};

const stop = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

export const runSecurityTopologyWorkerd = async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "stella-apps-security-workerd-"));
  const persist = path.join(temp, "state");
  const untrusted = path.join(temp, "untrusted.json");
  const auth = path.join(temp, "auth.json");
  await writeFile(untrusted, JSON.stringify(config({ name: "apps-untrusted-test", role: "untrusted", auth: false })));
  await writeFile(auth, JSON.stringify(config({ name: "apps-auth-test", role: "trusted", auth: true })));
  const port = await freePort();
  const inspectorPort = await freePort();
  const start = () =>
    spawn(
      process.execPath,
      [
        "x", "wrangler", "dev", "--config", untrusted, "--config", auth,
        "--ip", "127.0.0.1", "--port", String(port),
        "--inspector-ip", "127.0.0.1", "--inspector-port", String(inspectorPort),
        "--persist-to", persist,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
  let child = start();
  try {
    const health = await waitForHealth(port, child);
    const healthBody = await health.json();
    const now = Date.now();
    const envelope = { input: "https://example.com/", init: {} };
    const requestDocument = JSON.stringify({
      input: "https://example.com/",
      method: "GET",
      headers: {},
      body: null,
    });
    const tokenId = randomUUID();
    const capability = await encrypt({
      version: 1,
      audience: "stella-app-fetch-v1",
      issuer: "dev:outgoing-bulldog-865",
      tokenId,
      appId: "app-workerd",
      viewerNamespace: "viewer-workerd",
      origin: "null",
      method: "GET",
      targetOrigin: "https://example.com",
      targetUrl: "https://example.com/",
      requestHash: createHash("sha256").update(requestDocument).digest("hex"),
      issuedAt: now,
      exp: now + 60_000,
    });
    const request = () =>
      fetch(`http://127.0.0.1:${port}/api/apps/fetch`, {
        method: "POST",
        headers: {
          origin: "null",
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
    const first = await request();
    const replay = await request();
    if (first.status === 401 || replay.status !== 409) {
      throw new Error(`RPC/DO boundary failed: first=${first.status} replay=${replay.status}`);
    }
    await stop(child);
    child = start();
    await waitForHealth(port, child);
    const afterRestart = await request();
    if (afterRestart.status !== 409) {
      throw new Error(`Durable replay state was lost: ${afterRestart.status}`);
    }
    return {
      engine: "workerd",
      role: healthBody.role,
      firstStatus: first.status,
      replayStatus: replay.status,
      replayAfterRestartStatus: afterRestart.status,
      serviceBindingVerified: true,
      sqliteDurabilityVerified: true,
    };
  } finally {
    await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
};

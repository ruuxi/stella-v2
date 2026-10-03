import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const WORKER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONFIG = path.join(WORKER_ROOT, "wrangler.jsonc");
const WRANGLER = path.join(
  WORKER_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const START_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

const availablePort = async () =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a workerd test port."));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolve(address.port),
      );
    });
  });

const startWorkerd = async (temporaryRoot) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--config",
      CONFIG,
      "--local",
      "--persist-to",
      path.join(temporaryRoot, "state"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: temporaryRoot,
      detached: process.platform !== "win32",
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
  let closed = false;
  let closeResult = null;
  const take = (chunk) => {
    if (outputBytes > MAX_OUTPUT_BYTES) return;
    const copy = Buffer.from(chunk);
    outputBytes += copy.byteLength;
    chunks.push(copy);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const closedPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      resolve(closeResult);
    });
  });

  const terminate = (signal) => {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  const stop = async () => {
    if (!closed) {
      terminate("SIGTERM");
      await Promise.race([
        closedPromise,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (!closed) {
      terminate("SIGKILL");
      await closedPromise;
    }
    const output = Buffer.concat(chunks).toString("utf8");
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new Error("Workerd output exceeded its 1 MiB test limit.");
    }
    return {
      outputSha256: sha256(output),
      closeResult,
    };
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  const boundedOutput = () =>
    Buffer.concat(chunks).toString("utf8").slice(-2_000);
  for (;;) {
    if (closed) {
      throw new Error(
        `Workerd exited before readiness: ${boundedOutput()}`,
      );
    }
    try {
      const response = await fetch(`${origin}/not-found`, {
        signal: AbortSignal.timeout(1_000),
      });
      await response.arrayBuffer();
      return { origin, stop };
    } catch {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error(
          `Workerd did not become ready before its deadline: ${boundedOutput()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};

test(
  "production Worker returns 404 for malformed encoding in real workerd",
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "stella-canvas-share-workerd-"),
    );
    let runtime;
    try {
      runtime = await startWorkerd(temporaryRoot);
      const response = await fetch(`${runtime.origin}/c/%E0%A4%A`, {
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(body).toBe("Not found");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");

      const stopped = await runtime.stop();
      runtime = null;
      expect(stopped.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect([0, 143]).toContain(stopped.closeResult?.code);
      expect(stopped.closeResult?.signal).toBeNull();
    } finally {
      if (runtime) await runtime.stop();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  90_000,
);

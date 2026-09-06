import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.ts";

const port = 18_000 + Math.floor(Math.random() * 1_000);
const persistencePath = await mkdtemp(
  join(tmpdir(), "stella-cloud-code-workerd-"),
);
let child = null;
let output = "";
try {
  const inspectorPort = await allocateWorkerdInspectorPort();
  child = spawn(
    process.execPath,
    [
      "x",
      "wrangler",
      "dev",
      "--config",
      "tests/fixtures/cloud-code-workerd.wrangler.jsonc",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--local",
      "--persist-to",
      persistencePath,
      "--inspector-port",
      String(inspectorPort),
      "--show-interactive-dev-session=false",
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  const observe = (chunk) => {
    output += String(chunk);
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);

  const deadline = Date.now() + 30_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited before readiness:\n${output}`);
    }
    try {
      response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) break;
    } catch {
      // Workerd is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!response?.ok)
    throw new Error(`workerd did not become ready:\n${output}`);
  const payload = await response.json();
  const result = payload?.result;
  const listedNames = Array.isArray(result?.listed)
    ? result.listed.map((entry) => entry?.name)
    : [];
  if (
    payload?.ok !== true ||
    result?.answer !== 42 ||
    result?.outbound !== "blocked" ||
    listedNames.length !== 1 ||
    listedNames[0] !== "read_value" ||
    result?.listed?.[0]?.access !== "tools.read_value" ||
    !Array.isArray(result?.hits) ||
    result.hits[0] !== "read_value" ||
    result?.describedInvocation !== "tools.read_value(args)" ||
    result?.value !== "value:alpha" ||
    result?.caught !== 'No value stored for "missing".' ||
    result?.docsMentionsCall !== true ||
    !Array.isArray(result?.discovered) ||
    result.discovered[0] !== "gmail" ||
    result?.calledEmail !== "me@example.com" ||
    typeof result?.addMcp !== "string" ||
    !result.addMcp.includes("desktop-only") ||
    result?.frozen !== true ||
    payload?.hostProof?.nestedCallCount !== 2 ||
    payload?.hostProof?.connectCallCount !== 2 ||
    payload?.hostProof?.secretLeaked !== false
  ) {
    throw new Error(`unexpected workerd result: ${JSON.stringify(payload)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtime: "workerd",
      nestedCallCount: payload.hostProof.nestedCallCount,
      connectCallCount: payload.hostProof.connectCallCount,
      outbound: payload.result.outbound,
    })}\n`,
  );
} finally {
  try {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  } finally {
    if (persistencePath.includes("stella-cloud-code-workerd-")) {
      await rm(persistencePath, { recursive: true, force: true });
    }
  }
}

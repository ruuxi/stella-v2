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
  const hash = /^[a-f0-9]{64}$/u;
  const catalog = payload?.result?.catalog;
  const listProof = catalog?.proof;
  const describeProof = payload?.result?.describeProof;
  const callProof = payload?.result?.callProof;
  const listRequestHashes = listProof?.toolsListRequestIdSha256s;
  if (
    payload?.ok !== true ||
    payload?.result?.answer !== 42 ||
    payload?.result?.outbound !== "blocked" ||
    payload?.result?.callOutput?.email !== "me@example.com" ||
    !Array.isArray(catalog?.tools) ||
    catalog.tools.length !== 2 ||
    catalog.tools.some(
      (tool) =>
        typeof tool?.name !== "string" ||
        typeof tool?.revision !== "string" ||
        !hash.test(tool?.toolIdSha256 ?? "") ||
        Object.hasOwn(tool, "inputSchema") ||
        Object.hasOwn(tool, "description"),
    ) ||
    listProof?.protocolVersion !== "2025-03-26" ||
    listProof?.initializedNotificationSent !== true ||
    listProof?.toolsListCompleted !== true ||
    listProof?.toolsListPageCount !== 2 ||
    listProof?.toolCount !== 2 ||
    !hash.test(listProof?.serverIdSha256 ?? "") ||
    !hash.test(listProof?.initializeRequestIdSha256 ?? "") ||
    !hash.test(listProof?.initializationReceiptSha256 ?? "") ||
    !hash.test(listProof?.initializedNotificationReceiptSha256 ?? "") ||
    !hash.test(listProof?.catalogSha256 ?? "") ||
    !Array.isArray(listRequestHashes) ||
    listRequestHashes.length !== 2 ||
    listRequestHashes.some((value) => !hash.test(value)) ||
    new Set(listRequestHashes).size !== 2 ||
    describeProof?.describeCompleted !== true ||
    !hash.test(describeProof?.describeRequestIdSha256 ?? "") ||
    !hash.test(describeProof?.toolIdSha256 ?? "") ||
    !hash.test(describeProof?.describeReceiptSha256 ?? "") ||
    listRequestHashes.includes(describeProof?.describeRequestIdSha256) ||
    callProof?.callCompleted !== true ||
    !hash.test(callProof?.callRequestIdSha256 ?? "") ||
    !hash.test(callProof?.toolIdSha256 ?? "") ||
    !hash.test(callProof?.resultReceiptSha256 ?? "") ||
    callProof?.initializeRequestIdSha256 !==
      listProof?.initializeRequestIdSha256 ||
    listRequestHashes.includes(callProof?.callRequestIdSha256) ||
    describeProof?.describeRequestIdSha256 === callProof?.callRequestIdSha256 ||
    describeProof?.toolIdSha256 !== callProof?.toolIdSha256 ||
    payload?.hostProof?.rpcRequestCount !== 5 ||
    payload?.hostProof?.rawRpcIdsDistinct !== true ||
    payload?.hostProof?.rawRpcIdsLeaked !== false ||
    payload?.hostProof?.privateFieldsLeaked !== false ||
    payload?.hostProof?.initializedNotificationCount !== 1 ||
    payload?.hostProof?.toolsListPageCount !== 2 ||
    payload?.hostProof?.toolsDescribeCount !== 1 ||
    payload?.hostProof?.toolsCallCount !== 1
  ) {
    throw new Error(`unexpected workerd result: ${JSON.stringify(payload)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      runtime: "workerd",
      toolCount: listProof.toolCount,
      listPageCount: listProof.toolsListPageCount,
      rpcRequestCount: payload.hostProof.rpcRequestCount,
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

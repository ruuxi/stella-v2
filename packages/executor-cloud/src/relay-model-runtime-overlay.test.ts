import { expect, test } from "bun:test";

test.each([false, true])("relay preserves actual runtime overlays with runtime-first=%s", async (runtimeFirst) => {
  const child = Bun.spawn(
    [process.execPath, "src/relay-model-runtime-overlay.fixture.ts", ...(runtimeFirst ? ["--runtime-first"] : [])],
    { cwd: new URL("..", import.meta.url).pathname, stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    generatedMetadataDetached: true,
    contextWindow: 321_000,
    maxTokens: 12_345,
    provider: "custom-live",
    customHeader: "present",
  });
});

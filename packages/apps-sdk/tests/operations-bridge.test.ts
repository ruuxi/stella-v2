import { expect, test } from "bun:test";

const nonce = "123e4567-e89b-42d3-a456-426614174000";
const parentOrigin = "https://trusted.stella.test";
const posted: Array<{
  message: Record<string, unknown>;
  targetOrigin: string;
}> = [];
const messageListeners: Array<(event: MessageEvent) => void> = [];
const parentWindow = {
  postMessage(message: Record<string, unknown>, targetOrigin: string) {
    posted.push({ message, targetOrigin });
  },
};
const fakeWindow = {
  parent: parentWindow,
  name: "",
  __STELLA_APP_CONTEXT__: {
    appId: "app-proof",
    convexSiteUrl: "https://example.convex.site",
    bridge: true,
  },
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") messageListeners.push(listener);
  },
  setTimeout,
  clearTimeout,
  setInterval,
};

Object.assign(globalThis, { window: fakeWindow });
const { stella } = await import("../src/index.ts");

const emit = (data: Record<string, unknown>, origin = parentOrigin) => {
  for (const listener of messageListeners) {
    listener({
      data,
      source: parentWindow,
      origin,
    } as unknown as MessageEvent);
  }
};

test("operations use the exact nonce-bound bridge for registration and execution", async () => {
  expect(stella).toBeDefined();
  let executions = 0;
  const registration = stella!.operations.register([
    {
      name: "set-count",
      description: "Set the count.",
      args: [{ name: "count", type: "number", required: true }],
      handler: ({ count }) => {
        executions += 1;
        return { count };
      },
    },
  ]);
  expect(posted).toHaveLength(0);

  emit(
    {
      source: "stella-host-init",
      protocol: 2,
      nonce,
      parentOrigin,
    },
    "null",
  );
  await Promise.resolve();
  expect(posted).toHaveLength(0);
  emit({
    source: "stella-host-init",
    protocol: 2,
    nonce,
    parentOrigin,
  });
  await Promise.resolve();

  const describe = posted.at(-1)!;
  expect(describe.targetOrigin).toBe(parentOrigin);
  expect(describe.message).toMatchObject({
    source: "stella-app",
    protocol: 2,
    nonce,
    method: "operations/describe",
  });
  emit({
    source: "stella-host",
    protocol: 2,
    nonce,
    id: describe.message.id,
    result: { eligible: true },
  });
  await registration;

  emit(
    {
      source: "stella-host",
      protocol: 2,
      nonce,
      kind: "stella-operation",
      invocationId: "forged",
      name: "set-count",
      args: { count: 3 },
    },
    "https://attacker.invalid",
  );
  await Promise.resolve();
  expect(executions).toBe(0);

  emit({
    source: "stella-host",
    protocol: 2,
    nonce,
    kind: "stella-operation",
    invocationId: "invocation-1",
    name: "set-count",
    args: { count: 7 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(executions).toBe(1);
  expect(posted.at(-1)).toEqual({
    targetOrigin: parentOrigin,
    message: {
      source: "stella-app",
      protocol: 2,
      nonce,
      kind: "stella-operation-result",
      invocationId: "invocation-1",
      ok: true,
      resultJson: '{"count":7}',
    },
  });
});

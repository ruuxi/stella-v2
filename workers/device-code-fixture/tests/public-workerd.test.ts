import { afterEach, describe, expect, test } from "bun:test";

type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
  output: Promise<string>;
};

const running: RunningWorker[] = [];

afterEach(async () => {
  for (const worker of running.splice(0)) {
    worker.process.kill();
    await worker.process.exited.catch(() => undefined);
  }
});

const freePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  return port;
};

const startWorker = async (port: number): Promise<RunningWorker> => {
  const process = Bun.spawn(
    [
      "./node_modules/.bin/wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: import.meta.dir.replace(/\/tests$/u, ""),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).then((parts) => parts.join("\n").slice(-30_000));
  const worker = { process, output };
  running.push(worker);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      await Promise.race([
        process.exited.then(() => true),
        Bun.sleep(0).then(() => false),
      ])
    ) {
      throw new Error(`Workerd exited before readiness.\n${await output}`);
    }
    try {
      await fetch(`${origin}/activate`);
      return worker;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Workerd did not become ready.\n${await output}`);
};

describe("public fixture boundary in real workerd", () => {
  test("serves activation while keeping the named RPC protocol off HTTP", async () => {
    const port = freePort();
    const origin = `http://127.0.0.1:${port}`;
    await startWorker(port);

    const page = await fetch(`${origin}/activate?user_code=BCDF-2345`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await page.text()).toContain('value="BCDF-2345"');

    const internal = await fetch(`${origin}/internal/authorize`, {
      method: "POST",
    });
    expect(internal.status).toBe(404);

    const decision = await fetch(`${origin}/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({
        user_code: "BCDF-2345",
        decision: "approve",
      }),
    });
    expect(decision.status).toBe(200);
    expect(await decision.text()).toContain(
      "That code was not found or has expired.",
    );
  }, 60_000);
});

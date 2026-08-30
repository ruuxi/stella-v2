import { getSandbox } from "@cloudflare/sandbox";
import {
  AppBuildSandbox as AppBuildSandboxBase,
  ContainerProxy,
  GeneralAgentSandbox as GeneralAgentSandboxBase,
} from "../../src/sandbox-egress-classes.js";
import {
  appBuildEgress,
  generalAgentEgress,
} from "../../src/sandbox-egress-policy.js";
import {
  APP_BUILD_SESSION_ENV,
  startStrictSessionProcess,
  strictSessionExec,
} from "../../src/strict-session-process.js";
export { ContainerProxy };
export class GeneralAgentSandbox extends GeneralAgentSandboxBase {}
GeneralAgentSandbox.outbound = generalAgentEgress;
export class AppBuildSandbox extends AppBuildSandboxBase {}
AppBuildSandbox.outbound = appBuildEgress;

type FixtureEnv = {
  GENERAL_AGENT_SANDBOX: DurableObjectNamespace<GeneralAgentSandbox>;
  APP_BUILD_SANDBOX: DurableObjectNamespace<AppBuildSandbox>;
};

const HTTP_PROOF_URL =
  "http://example.com/?path-secret=never-log-this-query-value";
const HTTPS_PROOF_URL =
  "https://example.com/?path-secret=never-log-this-query-value";
const curl =
  "curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 20 \"$EGRESS_PROOF_URL\"";

const appTurnInput = {
  prompt: "Build a small habit tracker.",
  spec: {
    title: "Proof",
    eyebrow: "Today",
    headline: "Baked build proof",
    subhead: "The app compiles without runtime network access.",
    accent: "#246b4b",
    accentSoft: "#d8eadf",
    habits: [
      {
        name: "Verify",
        detail: "Exercise the production executor and Vite surface.",
        progress: 50,
      },
    ],
    focus: "Keep the runtime sealed",
  },
};

const commandResult = (result: {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}) => ({
  success: result.success,
  exitCode: result.exitCode,
  status: result.stdout.trim(),
  // Do not expose raw stderr in the proof response.
  stderrPresent: result.stderr.length > 0,
});

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return Response.json({ ready: true });
    if (request.method !== "POST" || pathname !== "/proof") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const general = getSandbox(
      env.GENERAL_AGENT_SANDBOX,
      "general-egress-proof",
      {
        transport: "rpc",
        enableDefaultSession: false,
        normalizeId: true,
      },
    );
    const appBuild = getSandbox(
      env.APP_BUILD_SANDBOX,
      "app-build-egress-proof",
      {
        transport: "rpc",
        enableDefaultSession: false,
        normalizeId: true,
      },
    );

    const generalResult = await general.exec(curl, {
      timeout: 30_000,
      env: { EGRESS_PROOF_URL: HTTP_PROOF_URL },
    });
    const session = await appBuild.createSession({
      id: "sealed-app-build-proof",
      cwd: "/opt/stella",
      commandTimeoutMs: 120_000,
      env: { ...APP_BUILD_SESSION_ENV },
    });
    const normalized = await session.exec(
      [
        "set -eu",
        "test ! -L /workspace",
        'test "$(readlink -f /workspace)" = /workspace',
        "test \"$(stat -c '%u:%g:%a' /workspace)\" = 0:42424:750",
        "if [ -e /workspace/app ] || [ -L /workspace/app ]; then test -d /workspace/app && test ! -L /workspace/app; else mkdir /workspace/app; fi",
        "chown 42424:42424 /workspace/app",
        "chmod 0750 /workspace/app",
        "if [ -e /workspace/.stella-tool-home ] || [ -L /workspace/.stella-tool-home ]; then test -d /workspace/.stella-tool-home && test ! -L /workspace/.stella-tool-home; else mkdir /workspace/.stella-tool-home; fi",
        "chown 42424:42424 /workspace/.stella-tool-home",
        "chmod 0700 /workspace/.stella-tool-home",
      ].join("; "),
    );
    if (!normalized.success) {
      throw new Error("App-build workspace normalization failed.");
    }
    await session.writeFile(
      "/workspace/turn-input.json",
      JSON.stringify(appTurnInput),
    );
    const execution = await strictSessionExec(
      session,
      ["bun", "packages/executor-cloud/src/cli.ts", "--app-turn"],
      { timeout: 120_000 },
    );
    if (!execution.success) {
      throw new Error("Sealed production app executor failed.");
    }
    const executor = JSON.parse(
      execution.stdout.trim().split("\n").at(-1) ?? "{}",
    ) as { ok?: boolean };
    const vite = await startStrictSessionProcess(
      session,
      ["/usr/local/bin/vite", "--host", "0.0.0.0", "--port", "5173"],
      { cwd: "/workspace/app" },
    );
    await vite.waitForPort(5173, {
      path: "/",
      status: 200,
      timeout: 120_000,
    });
    const preview = await session.exec(
      "curl --fail --silent --show-error --max-time 20 http://127.0.0.1:5173/",
    );
    const previewBody = preview.stdout;
    const files = await session.listFiles("/workspace/app/dist", {
      recursive: true,
    });
    const filePaths = files.files
      .filter((file) => file.type === "file")
      .map((file) => file.absolutePath);
    const sealedHttpResult = await appBuild.exec(curl, {
      timeout: 30_000,
      env: { EGRESS_PROOF_URL: HTTP_PROOF_URL },
    });
    const sealedHttpsResult = await appBuild.exec(curl, {
      timeout: 30_000,
      env: { EGRESS_PROOF_URL: HTTPS_PROOF_URL },
    });

    await appBuild.killAllProcesses(session.id);
    await appBuild.deleteSession(session.id).catch(() => undefined);
    await Promise.all([general.destroy(), appBuild.destroy()]);

    return Response.json({
      runtime: "workerd+sandbox-sdk",
      general: commandResult(generalResult),
      appBuild: {
        executorOk: executor.ok === true,
        previewStatus: preview.success ? 200 : 0,
        previewHasRoot: previewBody.includes('id="root"'),
        distIndex: filePaths.includes("/workspace/app/dist/index.html"),
        distAssets: filePaths.some((file) =>
          file.startsWith("/workspace/app/dist/assets/"),
        ),
        publishableFileCount: filePaths.length,
        sealedHttpEgress: commandResult(sealedHttpResult),
        sealedHttpsEgress: commandResult(sealedHttpsResult),
      },
    });
  },
} satisfies ExportedHandler<FixtureEnv>;

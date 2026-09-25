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
    const sealedHttpResult = await appBuild.exec(curl, {
      timeout: 30_000,
      env: { EGRESS_PROOF_URL: HTTP_PROOF_URL },
    });
    const sealedHttpsResult = await appBuild.exec(curl, {
      timeout: 30_000,
      env: { EGRESS_PROOF_URL: HTTPS_PROOF_URL },
    });

    await Promise.all([general.destroy(), appBuild.destroy()]);

    return Response.json({
      runtime: "workerd+sandbox-sdk",
      general: commandResult(generalResult),
      appBuild: {
        sealedHttpEgress: commandResult(sealedHttpResult),
        sealedHttpsEgress: commandResult(sealedHttpsResult),
      },
    });
  },
} satisfies ExportedHandler<FixtureEnv>;

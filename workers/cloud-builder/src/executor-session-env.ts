import { WORLD_ROOT } from "./workspace.js";

const LOCAL_EXECUTOR_NO_PROXY = "127.0.0.1,localhost,::1";

/**
 * Cloudflare may provide an HTTP(S) egress proxy to sandbox sessions. The
 * executor's credential broker is deliberately loopback-only, so every client
 * spelling must bypass that proxy rather than sending its dummy bearer and
 * request body to the egress path.
 */
export const executorSessionEnvironment = (): Record<string, string> => ({
  STELLA_CLOUD_WORKSPACE_ROOT: WORLD_ROOT,
  NO_PROXY: LOCAL_EXECUTOR_NO_PROXY,
  no_proxy: LOCAL_EXECUTOR_NO_PROXY,
});

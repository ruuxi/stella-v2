import { describe, expect, test } from "bun:test";
import { executorSessionEnvironment } from "../src/executor-session-env.js";

describe("executor session environment", () => {
  test("keeps the turn credential proxy off every HTTP egress proxy spelling", () => {
    const environment = executorSessionEnvironment();

    expect(environment).toEqual({
      STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/world",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    });
    expect(environment).not.toHaveProperty("HTTP_PROXY");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("authorization");
  });
});

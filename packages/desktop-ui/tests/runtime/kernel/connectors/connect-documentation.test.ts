import { describe, expect, test } from "vitest";
import { CONNECT_DOCUMENTATION } from "../../../../../runtime/kernel/connectors/connect-documentation.js";
import { installConnectWorkerApi } from "../../../../../runtime/kernel/connectors/connect-worker-api.js";

describe("connect documentation", () => {
  test("the stringified worker copy matches the shared constant", () => {
    const connect = installConnectWorkerApi(async () => undefined);
    expect(connect.documentation()).toBe(CONNECT_DOCUMENTATION);
  });
});

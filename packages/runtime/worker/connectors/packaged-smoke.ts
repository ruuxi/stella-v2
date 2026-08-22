import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReplConnectClient } from "../../kernel/connectors/connect-service.js";

const stellaDataDir = await mkdtemp(
  path.join(os.tmpdir(), "stella-packaged-connectors-"),
);

try {
  const connect = createReplConnectClient({ stellaAppDir: stellaDataDir });
  const connectors = await connect.connectors();
  if (!Array.isArray(connectors)) {
    throw new Error("connect.connectors() did not return a connector list.");
  }

  for (const connectorId of ["gmail", "outlook"]) {
    const result = (await connect.actions(connectorId)) as {
      connector?: unknown;
      total?: unknown;
      actions?: unknown;
    };
    if (
      result.connector !== connectorId ||
      typeof result.total !== "number" ||
      result.total < 1 ||
      !Array.isArray(result.actions) ||
      result.actions.length < 1
    ) {
      throw new Error(
        `connect.actions(${JSON.stringify(connectorId)}) returned no catalog actions.`,
      );
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      check: "packaged-connector-catalog",
      connectors: ["gmail", "outlook"],
    }),
  );
} finally {
  await rm(stellaDataDir, { recursive: true, force: true });
}

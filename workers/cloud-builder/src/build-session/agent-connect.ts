/**
 * The `connect` client a General agent's code uses, wherever it runs.
 *
 * Connectors belong to the account, so an agent reaches the same Store
 * integrations the orchestrator does: the global catalog, and the owner
 * object's live connections and action runs under the turn's own owner
 * generation. The resident isolate calls it in place; the container's code
 * reaches it through the turn broker. An agent never offers a connect card,
 * so there is no per-conversation decline memory here; that stays with the
 * orchestrator's `connector_status`.
 */

import type { RpcResponse } from "@stella/contracts/backend/protocol";
import type { CloudConnectClient } from "../cloud-code-tool.js";
import {
  CloudConnectorDirectory,
  createCloudConnectClient,
} from "../cloud-connect-client.js";
import {
  listIntegrationActions,
  listIntegrationCatalog,
} from "../integrations/catalog.js";
import { unwrapRpc } from "../owner-store/errors.js";
import type { TurnRequest } from "./shared/types.js";

export const agentConnectClient = (
  env: Pick<Cloudflare.Env, "OWNER_GATES" | "DB">,
  turn: Pick<TurnRequest, "ownerId" | "ownerGeneration">,
): CloudConnectClient => {
  const ownerInternal = async (name: string, args: unknown) =>
    unwrapRpc(
      (await env.OWNER_GATES.getByName(turn.ownerId).ownerInternal({
        name,
        args,
        ownerGeneration: turn.ownerGeneration,
      })) as RpcResponse,
    );
  return createCloudConnectClient(
    new CloudConnectorDirectory({
      source: {
        catalog: () => listIntegrationCatalog(env),
        actions: (args) => listIntegrationActions(env, args),
        connections: async () =>
          (await ownerInternal("integrations.connections", {})) as {
            connections: Array<{ id: string; connected: boolean }>;
          },
        run: (args) => ownerInternal("integrations.run", args),
      },
    }),
  );
};

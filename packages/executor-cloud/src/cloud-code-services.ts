/**
 * The container `code` cell's `connect` and `history`, reached through the
 * turn broker.
 *
 * The container has neither the desktop's CLI bridge nor backend auth, so the
 * tool host's own defaults for both refuse. The BuildSession answers these
 * with the same account connectors and conversation history the resident
 * isolate's code uses (`serveTurnCodeRequest`), under this turn's authority.
 * A refusal arrives as `{ ok: false, error }` and becomes the rejection the
 * cell sees; the broker itself stays usable.
 */

import {
  TURN_BROKER_CODE_PATHS,
  type TurnBrokerCodeConnectRequest,
  type TurnBrokerCodeHistoryRequest,
  type TurnBrokerCodeResponse,
} from "@stella/contracts/turn-credential-broker";
import type { ReplConnectClient } from "@stella/runtime/kernel/connectors/connect-service.js";

type BrokerPost = (route: string, body: unknown) => Promise<Response>;

const answerOf = async (response: Response, what: string): Promise<unknown> => {
  const body = (await response
    .json()
    .catch(() => null)) as TurnBrokerCodeResponse | null;
  if (!response.ok || !body || typeof body.ok !== "boolean") {
    throw new Error(`${what} is unavailable right now (${response.status}).`);
  }
  if (!body.ok) throw new Error(body.error);
  return body.value;
};

export const createBrokerConnectClient = (args: {
  post: BrokerPost;
  turnId: string;
}): ReplConnectClient => {
  const call = async (method: string, callArgs: unknown[]) =>
    await answerOf(
      await args.post(TURN_BROKER_CODE_PATHS.connect, {
        turnId: args.turnId,
        method,
        args: callArgs,
      } satisfies TurnBrokerCodeConnectRequest),
      "connect",
    );
  return {
    discover: (query) => call("discover", [query]),
    connectors: () => call("connectors", []),
    actions: (id, options) => call("actions", [id, options ?? {}]),
    schema: (id, action) => call("schema", [id, action]),
    call: (id, action, input) => call("call", [id, action, input ?? {}]),
    addMcp: (options) => call("addMcp", [options]),
    remove: (id) => call("remove", [id]),
  };
};

export const createBrokerHistoryQuery =
  (args: { post: BrokerPost; turnId: string }) =>
  async (request: Record<string, unknown>): Promise<unknown> =>
    await answerOf(
      await args.post(TURN_BROKER_CODE_PATHS.history, {
        turnId: args.turnId,
        request,
      } satisfies TurnBrokerCodeHistoryRequest),
      "history",
    );

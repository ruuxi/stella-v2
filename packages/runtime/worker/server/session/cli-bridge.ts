import { Context, Effect, Layer } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { sweepStaleConnectorBridgeProcesses } from "../../../kernel/connectors/process-registry.js";
import {
  setConnectorTokenStoreBroker,
  type ConnectorTokenPayload,
} from "../../../kernel/connectors/oauth.js";
import type {
  ConnectorTokenStoreRequest,
  ConnectorTokenStoreResult,
} from "../../../kernel/connectors/cli-broker-client.js";
import {
  startCliBridgeServer,
  type CliBridgeServer,
} from "../../cli-bridge-server.js";
import {
  createSecureCliBridgeEndpoint,
  resolveRuntimePaths,
} from "../../runtime-paths.js";
import { createBackendConnectorActionBroker } from "../../backend-connector-action-broker.js";
import { connectorActionBrokerAvailability } from "../../required-cli-bridge.js";
import * as HostBus from "../host-bus.js";
import * as SessionConfig from "./config.js";
import * as RunnerCell from "./runner-cell.js";

/**
 * The UDS bridge the worker exposes for sidecar CLIs (`stella-connect`) that
 * need to call back into the host without speaking the full runtime JSON-RPC
 * protocol. Connector-capable children may launch immediately after
 * initialize returns, so this layer builds (and therefore listens) BEFORE
 * the session is reported ready — a startup failure fails initialization,
 * preserving the old `afterRequiredCliBridgeReady` gate.
 */
export interface Interface {
  /** Stable socket path advertised to the runner; undefined when unsupported. */
  readonly socketPath: string | undefined;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/CliBridge",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const config = yield* SessionConfig.Service;
    const runnerCell = yield* RunnerCell.Service;
    const init = config.get();

    const bridgePaths = resolveRuntimePaths(init.stellaAppDir);
    const brokerAvailability = connectorActionBrokerAvailability(
      process.platform,
    );
    const socketPath = brokerAvailability.supported
      ? createSecureCliBridgeEndpoint(bridgePaths)
      : undefined;

    const connectorSweep = yield* Effect.promise(() =>
      sweepStaleConnectorBridgeProcesses(init.stellaDataDirPath, {
        currentWorkerPid: process.pid,
      }).catch((error) => {
        console.warn(
          "[connector-bridge] Failed to sweep stale connector helpers:",
          (error as Error).message,
        );
        return null;
      }),
    );
    if (connectorSweep?.stopped) {
      console.warn(
        `[connector-bridge] Stopped ${connectorSweep.stopped} stale connector helper(s).`,
      );
    }

    if (!brokerAvailability.supported || !socketPath) {
      console.warn(
        `[cli-bridge] ${"reason" in brokerAvailability ? brokerAvailability.reason : "Connector action broker is unavailable."}`,
      );
      return { socketPath: undefined };
    }

    const refreshSiteAuth = async () => {
      const result = (await hostBus.request(
        METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH,
        { source: "connector" },
        { retryOnDisconnect: true },
      )) as {
        authenticated: boolean;
        token: string | null;
        hasConnectedAccount: boolean;
      };
      config.patch({
        authToken: result.authenticated ? result.token : null,
        hasConnectedAccount: result.hasConnectedAccount,
      });
      const runner = runnerCell.get();
      runner?.setAuthToken(result.authenticated ? result.token : null);
      runner?.setHasConnectedAccount(result.hasConnectedAccount);
      const baseUrl = config.get().convexSiteUrl?.trim();
      const authToken = result.authenticated ? result.token?.trim() : null;
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    };

    const runBackendConnectorAction = createBackendConnectorActionBroker({
      stellaDataDir: init.stellaDataDirPath,
      getSiteAuth: () => {
        const baseUrl = config.get().convexSiteUrl?.trim();
        const authToken = config.get().authToken?.trim();
        return baseUrl && authToken ? { baseUrl, authToken } : null;
      },
      refreshSiteAuth: async () => {
        try {
          return await refreshSiteAuth();
        } catch {
          return null;
        }
      },
    });

    const requestHostConnectorTokenStore = async (
      request: ConnectorTokenStoreRequest,
    ): Promise<ConnectorTokenStoreResult> =>
      await hostBus.request<ConnectorTokenStoreResult>(
        METHOD_NAMES.HOST_CONNECTOR_TOKEN_STORE_REQUEST,
        request,
      );

    // Protected connector credentials stay on owner-only local IPC. The
    // worker and shipped CLI receive plaintext only in memory for a request.
    // Cleared by the CredentialBrokers finalizer (which runs after this
    // layer's), preserving the old stop order.
    setConnectorTokenStoreBroker({
      load: async (tokenKey) => {
        const result = await requestHostConnectorTokenStore({
          operation: "load",
          tokenKey,
        });
        if (!result.ok) throw new Error(result.reason ?? "token_load_failed");
        return result.payload ?? null;
      },
      save: async (tokenKey, payload) => {
        const result = await requestHostConnectorTokenStore({
          operation: "save",
          tokenKey,
          payload,
        });
        if (!result.ok) throw new Error(result.reason ?? "token_save_failed");
      },
      delete: async (tokenKeys) => {
        const result = await requestHostConnectorTokenStore({
          operation: "delete",
          tokenKeys,
        });
        if (!result.ok) throw new Error(result.reason ?? "token_delete_failed");
      },
    });

    const cliBridgeServer: CliBridgeServer = yield* Effect.tryPromise({
      try: () =>
        startCliBridgeServer({
          socketPath,
          log: (message, error) => {
            if (error) {
              console.warn(`[cli-bridge] ${message}:`, error);
            } else {
              console.warn(`[cli-bridge] ${message}`);
            }
          },
          handlers: {
            runBackendConnectorAction,
            requestConnectorTokenStore: requestHostConnectorTokenStore,
            requestConnectorCredential: async (params) => {
              try {
                return await hostBus.request<
                  | { ok: true }
                  | {
                      ok: false;
                      reason: "cancelled" | "timeout" | "unsupported" | string;
                    }
                >(METHOD_NAMES.HOST_CONNECTOR_CREDENTIAL_REQUEST, params, {
                  retryOnDisconnect: true,
                });
              } catch (error) {
                return {
                  ok: false,
                  reason: (error as Error).message || "host_unreachable",
                };
              }
            },
            requestConnectorConnection: async (params) => {
              try {
                return await hostBus.request<
                  | { ok: true; status: "connected" | "already_connected" }
                  | {
                      ok: false;
                      reason:
                        | "declined"
                        | "cancelled"
                        | "timeout"
                        | "unsupported"
                        | string;
                    }
                >(METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST, params, {
                  retryOnDisconnect: true,
                });
              } catch (error) {
                return {
                  ok: false,
                  reason: (error as Error).message || "host_unreachable",
                };
              }
            },
            requestDesktopPermission: async ({ kind }) => {
              try {
                const result = await hostBus.request<{
                  granted: boolean;
                  alreadyGranted: boolean;
                }>(METHOD_NAMES.HOST_SYSTEM_REQUEST_PERMISSION, kind, {
                  retryOnDisconnect: true,
                });
                return { ok: true, ...result };
              } catch (error) {
                return {
                  ok: false,
                  reason: (error as Error).message || "host_unreachable",
                };
              }
            },
          },
        }),
      catch: (error) => error as Error,
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => cliBridgeServer.stop().catch(() => undefined)),
    );

    return { socketPath };
  }),
);

import { Context, Effect, Layer } from "effect";
import {
  METHOD_NAMES,
  type HostLlmCredentialsRequest,
  type HostLlmCredentialsResult,
} from "@stella/contracts/protocol";
import { setConnectorTokenStoreBroker } from "../../../kernel/connectors/oauth.js";
import { setLocalLlmCredentialAccessBroker } from "../../../kernel/storage/local-llm-credential-access.js";
import * as HostBus from "../host-bus.js";

/**
 * The two process-global credential brokers the worker installs for kernel
 * code: local-LLM credential access (backed by desktop safeStorage over the
 * host hop) and the connector token store. The LLM broker is installed here
 * on acquire; the connector broker is installed by CliBridge (only when the
 * bridge platform is supported, as before) — but BOTH are cleared by this
 * layer's finalizer so clearing lands after the bridge has stopped, matching
 * the old stopWorkerServices order.
 */
export interface Interface {
  /** Re-read which providers have credentials and reinstall the broker. */
  readonly refreshLocalLlmCredentialAccess: () => Promise<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/CredentialBrokers",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;

    const requestHostLlmCredentials = async (
      request: HostLlmCredentialsRequest,
    ): Promise<HostLlmCredentialsResult> =>
      await hostBus.request(METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST, request, {
        retryOnDisconnect: true,
      });

    const refreshLocalLlmCredentialAccess = async (): Promise<void> => {
      const result = await requestHostLlmCredentials({ operation: "list" });
      if (
        !result.ok ||
        !("apiKeyProviders" in result) ||
        !("oauthProviders" in result)
      ) {
        throw new Error(
          `Desktop credential storage is unavailable: ${result.ok ? "invalid_response" : result.reason}`,
        );
      }
      const apiKeyProviders = new Set(
        result.apiKeyProviders.map((provider) => provider.trim().toLowerCase()),
      );
      const oauthProviders = new Set(
        result.oauthProviders.map((provider) => provider.trim().toLowerCase()),
      );
      setLocalLlmCredentialAccessBroker({
        hasApiKey: (provider) => apiKeyProviders.has(provider),
        hasOAuth: (provider) => oauthProviders.has(provider),
        getApiKey: async (provider) => {
          const value = await requestHostLlmCredentials({
            operation: "get",
            kind: "api-key",
            provider,
          });
          return value.ok && "value" in value ? value.value : null;
        },
        getOAuthApiKey: async (provider) => {
          const value = await requestHostLlmCredentials({
            operation: "get",
            kind: "oauth-api-key",
            provider,
          });
          return value.ok && "value" in value ? value.value : null;
        },
      });
    };

    yield* Effect.tryPromise({
      try: refreshLocalLlmCredentialAccess,
      catch: (error) => error as Error,
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setConnectorTokenStoreBroker(null);
        setLocalLlmCredentialAccessBroker(null);
      }),
    );

    return { refreshLocalLlmCredentialAccess };
  }),
);

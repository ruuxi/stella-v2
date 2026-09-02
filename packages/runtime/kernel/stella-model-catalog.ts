import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { formatLlmRouteFailure } from "@stella/contracts/llm-route-failure";
import type { Api, Model } from "../ai/types.js";
import {
  STELLA_DEFAULT_MODEL,
  STELLA_MODELS_PATH,
  normalizeStellaSiteUrl,
} from "@stella/contracts/stella-api";
import { writePrivateFile } from "./shared/private-fs.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import {
  findRegistryModel,
  getEngineNativeStellaModelAlternative,
  getStellaVerbatimUpstreamModel,
} from "./model-routing-matching.js";
import {
  STELLA_PROVIDER,
  createStellaRoute,
  getManagedStellaRegistryLookup,
  resolveOfflineStellaModelId,
  type StellaSiteConfig,
} from "./model-routing-stella.js";
import {
  STELLA_GATEWAY_UNCONFIGURED_MESSAGE,
  getRememberedStellaGatewayOrigin,
  normalizeGatewayOrigin,
  rememberStellaGatewayOrigin,
} from "./gateway-session.js";

type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  upstreamModel?: string;
};

type CatalogDefaultModel = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

type CatalogApiModel = {
  id: string;
  name?: string;
  provider?: string;
  type?: string;
  upstreamModel?: string;
};

type CatalogApiResponse = {
  data?: CatalogApiModel[];
  defaults?: CatalogDefaultModel[];
  /** Model-gateway origin every Stella route must relay through. */
  gateway?: { origin?: unknown };
};

type StellaModelCatalog = {
  models: CatalogModel[];
  defaults: CatalogDefaultModel[];
  gateway: { origin: string };
};

type CatalogCacheEntry = StellaModelCatalog;

type ModelIdentity = Pick<Model<Api>, "api" | "provider" | "id" | "name">;

const catalogCache = new Map<string, CatalogCacheEntry>();
const inFlightCatalogRequests = new Map<
  string,
  Promise<StellaModelCatalog | null>
>();
const lastCatalogFetchAttemptAtMs = new Map<string, number>();

/**
 * The one module-level ManagedRuntime for the Stella model catalog (M5
 * kernel pass, house convention: one requirements-free runtime per facade
 * module family). Disk-cache reads/writes and the bounded catalog fetch run
 * as Effects; the exported `withStellaModelCatalogMetadata` stays a
 * plain-Promise facade rejecting with the original failure (`Cause.squash`).
 */
const catalogRuntime = ManagedRuntime.make(Layer.empty);

const runCatalogEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await catalogRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Wrap one async catalog IO call; failures carry the original error. */
const tryCatalogOp = <A>(op: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: op, catch: (error) => error });

/** Bound on the catalog network round-trip. */
const CATALOG_FETCH_TIMEOUT_MS = 15_000;
/** Minimum spacing between background refresh attempts per identity. */
const CATALOG_REFRESH_MIN_INTERVAL_MS = 30_000;

const publishCatalogToModelRuntime = async (
  catalog: StellaModelCatalog,
  site: StellaSiteConfig,
): Promise<void> => {
  // Every served catalog (memory, disk, network) re-asserts the gateway
  // origin so routes built outside this module can find it.
  if (site.baseUrl) {
    rememberStellaGatewayOrigin(site.baseUrl, catalog.gateway.origin);
  }
  const routes = catalog.models
    .filter((model) => model.id.startsWith(`${STELLA_PROVIDER}/`))
    .map((model) =>
      createStellaRoute({
        site,
        agentType: "orchestrator",
        modelId: model.id,
        resolvedModelId:
          model.upstreamModel ??
          resolveOfflineStellaModelId(model.id) ??
          undefined,
        gatewayOrigin: catalog.gateway.origin,
      }),
    )
    .filter((route): route is NonNullable<typeof route> => Boolean(route));
  const { modelRuntime } = await import("../ai/model-runtime.js");
  modelRuntime.setManagedProviderModels(
    STELLA_PROVIDER,
    routes.map((route) => ({ ...route.model, provider: STELLA_PROVIDER })),
  );
};

/**
 * The disk cache is keyed by the IDENTITY (endpoint + user + device) only —
 * deliberately NOT by catalog version. The pushed `modelCatalogUpdatedAt`
 * decides freshness, not existence: when the version bumps, the stored copy
 * goes stale but stays servable, so a catalog change (or a flaky backend
 * mid-deploy) can never leave route resolution with nothing. One file per
 * identity also stops the per-version file accumulation the old scheme had.
 */
const diskCachePathForIdentity = (
  stellaDataDir: string,
  identityKey: string,
): string =>
  path.join(
    stellaDataDir,
    "cache",
    "model-catalog",
    `${createHash("sha256").update(identityKey).digest("hex")}.json`,
  );

const cloneCatalog = (catalog: StellaModelCatalog): StellaModelCatalog => ({
  models: catalog.models,
  defaults: catalog.defaults,
  gateway: { origin: catalog.gateway.origin },
});

const isCatalogModel = (value: unknown): value is CatalogModel => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CatalogModel>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.provider === "string" &&
    (candidate.upstreamModel === undefined ||
      typeof candidate.upstreamModel === "string")
  );
};

const isCatalogDefault = (value: unknown): value is CatalogDefaultModel => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CatalogDefaultModel>;
  return (
    typeof candidate.agentType === "string" &&
    typeof candidate.model === "string" &&
    typeof candidate.resolvedModel === "string"
  );
};

const parsePersistedCatalog = (
  value: unknown,
): { catalog: StellaModelCatalog; storedCacheKey: string } | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    cacheKey?: unknown;
    catalog?: {
      models?: unknown;
      defaults?: unknown;
      gateway?: { origin?: unknown };
    };
  };
  if (typeof candidate.cacheKey !== "string") return null;
  const models = candidate.catalog?.models;
  const defaults = candidate.catalog?.defaults;
  if (!Array.isArray(models) || !Array.isArray(defaults)) return null;
  if (!models.every(isCatalogModel) || !defaults.every(isCatalogDefault)) {
    return null;
  }
  // A pre-gateway disk copy carries no origin; it reads as "nothing stored"
  // so the next lookup fetches a catalog that does.
  const gatewayOrigin = normalizeGatewayOrigin(candidate.catalog?.gateway?.origin);
  if (!gatewayOrigin) return null;
  return {
    catalog: { models, defaults, gateway: { origin: gatewayOrigin } },
    storedCacheKey: candidate.cacheKey,
  };
};

const readCatalogFromDiskEffect = (
  stellaDataDir: string | undefined,
  identityKey: string,
  cacheKey: string,
): Effect.Effect<{ catalog: StellaModelCatalog; fresh: boolean } | null> =>
  Effect.suspend(() => {
    if (!stellaDataDir?.trim()) {
      return Effect.succeed(null);
    }
    return tryCatalogOp(async () => {
      const raw = await fs.readFile(
        diskCachePathForIdentity(stellaDataDir, identityKey),
        "utf-8",
      );
      const persisted = parsePersistedCatalog(JSON.parse(raw));
      if (!persisted) return null;
      return {
        catalog: persisted.catalog,
        fresh: persisted.storedCacheKey === cacheKey,
      };
    }).pipe(
      // Missing/torn/unparsable disk cache reads as "nothing stored" —
      // the old `catch { return null }`.
      Effect.catch(() => Effect.succeed(null)),
    );
  });

const writeCatalogToDiskEffect = (
  stellaDataDir: string | undefined,
  identityKey: string,
  cacheKey: string,
  catalog: StellaModelCatalog,
): Effect.Effect<void, unknown> =>
  Effect.suspend(() => {
    if (!stellaDataDir?.trim()) {
      return Effect.void;
    }
    return tryCatalogOp(() =>
      writePrivateFile(
        diskCachePathForIdentity(stellaDataDir, identityKey),
        JSON.stringify({ cacheKey, catalog }, null, 2),
      ),
    );
  });

export const invalidateStellaModelCatalogCache = (): void => {
  catalogCache.clear();
  inFlightCatalogRequests.clear();
  lastCatalogFetchAttemptAtMs.clear();
};

const getJwtCacheIdentity = (authorization: string | undefined): string => {
  if (!authorization?.startsWith("Bearer ")) {
    return "auth:none";
  }
  const token = authorization.slice("Bearer ".length);
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const issuer = typeof payload.iss === "string" ? payload.iss : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const tokenIdentifier =
      typeof payload.tokenIdentifier === "string"
        ? payload.tokenIdentifier
        : "";
    const audience = Array.isArray(payload.aud)
      ? payload.aud.join(",")
      : typeof payload.aud === "string"
        ? payload.aud
        : "";
    const isAnonymous =
      typeof payload.isAnonymous === "boolean"
        ? String(payload.isAnonymous)
        : "";
    return [
      "auth:jwt",
      issuer,
      subject,
      tokenIdentifier,
      audience,
      isAnonymous,
    ].join(":");
  } catch {
    return `auth:jwt-unreadable:${createHash("sha256").update(token).digest("hex")}`;
  }
};

const buildCatalogRequest = (args: {
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
}): {
  endpoint: string;
  headers: Record<string, string>;
  /** Who is asking: endpoint + stable JWT identity + device. */
  identityKey: string;
  /** identityKey + the pushed catalog version — the freshness key. */
  cacheKey: string;
} | null => {
  const baseUrl = args.site.baseUrl?.trim();
  const authToken = args.site.getAuthToken()?.trim();
  if (!baseUrl || !authToken) {
    return null;
  }

  const endpoint = `${normalizeStellaSiteUrl(baseUrl)}${STELLA_MODELS_PATH}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
  };
  if (args.deviceId?.trim()) {
    headers["X-Device-ID"] = args.deviceId.trim();
  }
  const identityKey = [
    endpoint,
    getJwtCacheIdentity(headers.Authorization),
    headers["X-Device-ID"] ?? "device:none",
  ].join("|");
  return {
    endpoint,
    headers,
    identityKey,
    cacheKey: [
      identityKey,
      args.modelCatalogUpdatedAt ?? "model-catalog-updated-at:none",
    ].join("|"),
  };
};

type CatalogRequest = NonNullable<ReturnType<typeof buildCatalogRequest>>;

/**
 * The only place the network is touched. Single-flight per identity,
 * bounded, rate-limited between attempts, and every outcome settles — a
 * pending entry can never outlive {@link CATALOG_FETCH_TIMEOUT_MS}, so one
 * stalled request can no longer poison every later lookup (a previous
 * incarnation of this map held unsettled promises forever).
 */
const fetchCatalogFromNetwork = (
  request: CatalogRequest,
  stellaDataDir: string | undefined,
): Promise<StellaModelCatalog | null> => {
  const existing = inFlightCatalogRequests.get(request.identityKey);
  if (existing) {
    return existing;
  }
  lastCatalogFetchAttemptAtMs.set(request.identityKey, Date.now());
  // `AbortSignal.timeout` stays the network bound (it actually aborts the
  // fetch — an Effect.timeout wrapper would only abandon it); the pipeline
  // around it runs as an Effect on the shared catalog runtime. The
  // single-flight map keeps holding the settled-once Promise so concurrent
  // awaiters and the background-refresh path share one attempt, exactly as
  // before.
  const inFlight = catalogRuntime.runPromise(
    Effect.gen(function* () {
      const res = yield* tryCatalogOp(() =>
        fetch(request.endpoint, {
          headers: request.headers,
          signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
        }),
      );
      if (!res.ok) {
        return yield* Effect.fail(new Error(`HTTP ${res.status}`));
      }
      const data = (yield* tryCatalogOp(() => res.json())) as CatalogApiResponse;
      // The gateway origin is part of the catalog contract: without it no
      // Stella route can be built, so its absence is a catalog failure, not
      // a partial success.
      const gatewayOrigin = normalizeGatewayOrigin(data.gateway?.origin);
      if (!gatewayOrigin) {
        return yield* Effect.fail(new Error(STELLA_GATEWAY_UNCONFIGURED_MESSAGE));
      }
      const catalog: StellaModelCatalog = {
        models: (data.data ?? [])
          .filter((model) => !model.type || model.type === "language")
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            provider: model.provider ?? STELLA_PROVIDER,
            upstreamModel: model.upstreamModel,
          })),
        defaults: data.defaults ?? [],
        gateway: { origin: gatewayOrigin },
      };
      catalogCache.set(request.cacheKey, cloneCatalog(catalog));
      yield* writeCatalogToDiskEffect(
        stellaDataDir,
        request.identityKey,
        request.cacheKey,
        catalog,
      ).pipe(Effect.catch(() => Effect.void));
      return catalog as StellaModelCatalog | null;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          // Loud on purpose: silent nulls here previously made a sick catalog
          // endpoint (or a poisoned in-flight entry) undiagnosable from logs.
          console.warn(
            `[stella-model-catalog] Catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          inFlightCatalogRequests.delete(request.identityKey);
        }),
      ),
    ),
  );
  inFlightCatalogRequests.set(request.identityKey, inFlight);
  return inFlight;
};

/**
 * Push-invalidated, stale-while-revalidate catalog lookup.
 *
 * The backend pushes `modelCatalogUpdatedAt` down through desktop config;
 * that version is the ONLY thing that decides freshness. Resolution order:
 *   1. memory/disk copy stored under the current version → serve it;
 *   2. any older stored copy → serve it IMMEDIATELY and refresh in the
 *      background (spaced by {@link CATALOG_REFRESH_MIN_INTERVAL_MS});
 *   3. nothing stored at all (first run) → one bounded network fetch.
 * After the first successful fetch on a device, callers never block on the
 * network again — a version bump degrades to "briefly stale", never to
 * "hangs" or "no catalog".
 */
const fetchStellaModelCatalogEffect = (args: {
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
}): Effect.Effect<StellaModelCatalog | null, unknown> =>
  Effect.gen(function* () {
    const request = buildCatalogRequest(args);
    if (!request) {
      return null;
    }

    const cached = catalogCache.get(request.cacheKey);
    if (cached) {
      yield* tryCatalogOp(() => publishCatalogToModelRuntime(cached, args.site));
      return cloneCatalog(cached);
    }

    const diskCached = yield* readCatalogFromDiskEffect(
      args.stellaDataDir,
      request.identityKey,
      request.cacheKey,
    );
    if (diskCached?.fresh) {
      catalogCache.set(request.cacheKey, cloneCatalog(diskCached.catalog));
      yield* tryCatalogOp(() =>
        publishCatalogToModelRuntime(diskCached.catalog, args.site),
      );
      return diskCached.catalog;
    }
    if (diskCached) {
      // Stale copy: usable now, refresh behind the caller's back. The stale
      // catalog is deliberately NOT memoized under the current cacheKey — the
      // memory entry for this version is only written by a successful fetch.
      const lastAttempt =
        lastCatalogFetchAttemptAtMs.get(request.identityKey) ?? 0;
      if (
        !inFlightCatalogRequests.has(request.identityKey) &&
        Date.now() - lastAttempt >= CATALOG_REFRESH_MIN_INTERVAL_MS
      ) {
        // Background refresh rides its own fiber (the old fire-and-forget
        // `void ....then(...)`); a failed publish dies with the fiber
        // instead of the process' unhandled-rejection path.
        catalogRuntime.runFork(
          tryCatalogOp(() =>
            fetchCatalogFromNetwork(request, args.stellaDataDir),
          ).pipe(
            Effect.flatMap((catalog) =>
              catalog
                ? tryCatalogOp(() =>
                    publishCatalogToModelRuntime(catalog, args.site),
                  )
                : Effect.void,
            ),
          ),
        );
      }
      yield* tryCatalogOp(() =>
        publishCatalogToModelRuntime(diskCached.catalog, args.site),
      );
      return diskCached.catalog;
    }

    const fetched = yield* tryCatalogOp(() =>
      fetchCatalogFromNetwork(request, args.stellaDataDir),
    );
    if (fetched) {
      yield* tryCatalogOp(() =>
        publishCatalogToModelRuntime(fetched, args.site),
      );
    }
    return fetched;
  });

const modelIdentityFromId = (modelId: string): ModelIdentity => {
  const normalized = modelId.trim();
  const [provider, ...rest] = normalized.split("/");
  const hasProvider = Boolean(provider && rest.length > 0);
  return {
    id: normalized,
    name: hasProvider ? rest.join("/") : normalized,
    provider: hasProvider ? provider : "",
    api: hasProvider ? provider : "",
  };
};

const resolveStellaModelAliasEffect = (args: {
  route: ResolvedLlmRoute;
  agentType: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
}): Effect.Effect<string | null, unknown> =>
  Effect.gen(function* () {
    if (args.route.route !== "stella") {
      return null;
    }

    const modelId = args.route.model.id.trim();
    const passthrough = getStellaVerbatimUpstreamModel(modelId);
    if (passthrough) {
      // Verbatim ids need no alias lookup, but the route still needs the
      // gateway origin the catalog advertises; fetch it once per site.
      if (!getRememberedStellaGatewayOrigin(args.site.baseUrl)) {
        yield* fetchStellaModelCatalogEffect({
          site: args.site,
          deviceId: args.deviceId,
          modelCatalogUpdatedAt: args.modelCatalogUpdatedAt,
          stellaDataDir: args.stellaDataDir,
        });
      }
      return passthrough;
    }

    const catalog = yield* fetchStellaModelCatalogEffect({
      site: args.site,
      deviceId: args.deviceId,
      modelCatalogUpdatedAt: args.modelCatalogUpdatedAt,
      stellaDataDir: args.stellaDataDir,
    });
    if (!catalog) {
      return null;
    }

    if (modelId === STELLA_DEFAULT_MODEL) {
      return (
        catalog.defaults.find((entry) => entry.agentType === args.agentType)
          ?.resolvedModel ?? null
      );
    }

    return (
      catalog.models.find((model) => model.id === modelId)?.upstreamModel ??
      null
    );
  });

export const withStellaModelCatalogMetadata = (args: {
  route: ResolvedLlmRoute;
  agentType: string;
  site: StellaSiteConfig;
  deviceId?: string;
  modelCatalogUpdatedAt?: number | null;
  stellaDataDir?: string;
  reasoningEffort?: string;
}): Promise<ResolvedLlmRoute> =>
  runCatalogEffect(
    Effect.gen(function* () {
      if (args.route.route !== "stella") {
        return args.route;
      }

      const resolvedModelId = yield* resolveStellaModelAliasEffect(args);
      if (!resolvedModelId) {
        if (resolveOfflineStellaModelId(args.route.model.id) === null) {
          const suggestedModel = getEngineNativeStellaModelAlternative(
            args.route.model.id,
            args.reasoningEffort,
          );
          return yield* Effect.fail(
            new Error(
              formatLlmRouteFailure({
                kind: "unknown-model",
                provider: STELLA_PROVIDER,
                model: args.route.model.id,
                ...(suggestedModel ? { suggestedModel } : {}),
              }),
            ),
          );
        }
        // Offline fallback: the alias resolved locally, but the route still
        // has to relay through a known gateway. Rebuild it so a provisional
        // (pre-catalog) baseUrl never reaches a provider adapter.
        const gatewayOrigin = yield* requireGatewayOrigin(args.site);
        return (
          createStellaRoute({
            site: args.site,
            agentType: args.agentType,
            modelId: args.route.model.id,
            gatewayOrigin,
          }) ?? args.route
        );
      }

      const gatewayOrigin = yield* requireGatewayOrigin(args.site);
      const lookup = getManagedStellaRegistryLookup(resolvedModelId);
      const registryModel =
        findRegistryModel(lookup.provider, lookup.candidates) ??
        (yield* tryCatalogOp(async () => {
          const { modelRuntime } = await import("../ai/model-runtime.js");
          return modelRuntime
            .ensureProviderModel(lookup.provider, lookup.candidates)
            .catch(() => undefined);
        }));

      const resolvedRoute = createStellaRoute({
        site: args.site,
        agentType: args.agentType,
        modelId: args.route.model.id,
        resolvedModelId,
        registryModel,
        gatewayOrigin,
      });

      return {
        ...(resolvedRoute ?? args.route),
        toolPolicyModel: modelIdentityFromId(resolvedModelId),
      };
    }),
  );

/**
 * The gateway origin is configuration, not data: once the catalog (memory,
 * disk, or network) has been consulted and still no origin is known, the
 * deployment is misconfigured and every Stella model call must fail closed.
 */
const requireGatewayOrigin = (
  site: StellaSiteConfig,
): Effect.Effect<string, Error> =>
  Effect.suspend(() => {
    const origin = getRememberedStellaGatewayOrigin(site.baseUrl);
    return origin
      ? Effect.succeed(origin)
      : Effect.fail(new Error(STELLA_GATEWAY_UNCONFIGURED_MESSAGE));
  });

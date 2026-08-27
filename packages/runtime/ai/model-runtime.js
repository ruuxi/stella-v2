import fs from "node:fs";
import path from "node:path";
import { MODELS } from "@stella/contracts/models.generated";
import { STELLA_RELAY_PROVIDERS } from "@stella/contracts/stella-api";
import { isRetiredAssistantProvider } from "@stella/contracts/provider-display";
import { ModelConfig, isModelConfigValueConfigured, resolveModelConfigHeaders, resolveModelConfigValue, } from "./model-config.js";
import { ensurePrivateDirSync, writePrivateFileSync, } from "../kernel/shared/private-fs.js";
const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000;

const REMOTE_CATALOG_TIMEOUT_MS = 15_000;

const REMOTE_CATALOG_CONCURRENCY = 6;

class CatalogRefreshCancelledError extends Error {
    constructor(providerId) {
        super(`Model catalog refresh for ${providerId} was cancelled`);
        this.name = "CatalogRefreshCancelledError";
    }
}
const describeCatalogFetchFailure = (providerId, error, causes) => {

    if (causes.cancelled)
        return new CatalogRefreshCancelledError(providerId);
    if (causes.timeoutMs !== undefined) {
        return new Error(`Model catalog request for ${providerId} timed out after ${causes.timeoutMs}ms`);
    }
    return error instanceof Error ? error : new Error(String(error));
};
const AUTH_HEADER_NAMES = new Set([
    "authorization",
    "proxy-authorization",
    "api-key",
    "x-api-key",
    "x-auth-token",
    "x-goog-api-key",
]);
const hasStaticAuthHeader = (headers) => Object.entries(headers ?? {}).some(([name, value]) => AUTH_HEADER_NAMES.has(name.toLowerCase()) && Boolean(value));
const cloneModel = (model) => structuredClone(model);
const modelMap = (models) => new Map(models.map((model) => [model.id, cloneModel(model)]));
export const mergeModelHeaders = (base, override) => {
    if (!base && !override)
        return undefined;
    const merged = {};
    for (const headers of [base, override]) {
        for (const [name, value] of Object.entries(headers ?? {})) {
            const outputName = name.toLowerCase() === "authorization" ? "Authorization" : name;
            const existing = Object.keys(merged).find((candidate) => candidate.toLowerCase() === outputName.toLowerCase());
            if (existing !== undefined)
                delete merged[existing];
            merged[outputName] = value;
        }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
};
const mergeModelCompat = (base, override) => {
    if (!override)
        return base;
    const merged = { ...base, ...override };
    const baseNested = base;
    const overrideNested = override;
    const mergedNested = merged;
    for (const key of [
        "openRouterRouting",
        "vercelGatewayRouting",
        "chatTemplateKwargs",
    ]) {
        const baseValue = baseNested?.[key];
        const overrideValue = overrideNested[key];
        if ((typeof baseValue === "object" && baseValue !== null) ||
            (typeof overrideValue === "object" && overrideValue !== null)) {
            mergedNested[key] = {
                ...baseValue,
                ...overrideValue,
            };
        }
    }
    return merged;
};
const applyModelOverride = (model, override) => {
    if (!override)
        return model;
    const { headers: _rawHeaders, ...safeOverride } = override;
    return {
        ...model,
        ...safeOverride,
        thinkingLevelMap: override.thinkingLevelMap
            ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
            : model.thinkingLevelMap,
        cost: override.cost ? { ...model.cost, ...override.cost } : model.cost,
        compat: mergeModelCompat(model.compat, override.compat),
    };
};
const createConfiguredModel = (providerId, provider, definition, transportDefaults, metadataDefaults) => {
    const api = definition.api ??
        provider.api ??
        metadataDefaults?.api ??
        transportDefaults?.api;
    const baseUrl = definition.baseUrl ??
        provider.baseUrl ??
        metadataDefaults?.baseUrl ??
        transportDefaults?.baseUrl;
    if (!api || !baseUrl) {
        throw new Error(`Provider "${providerId}" model "${definition.id}" requires api and baseUrl.`);
    }
    return {
        id: definition.id,
        name: definition.name ?? metadataDefaults?.name ?? definition.id,
        api,
        provider: providerId,
        baseUrl,
        reasoning: definition.reasoning ?? metadataDefaults?.reasoning ?? false,
        thinkingLevelMap: definition.thinkingLevelMap
            ? { ...metadataDefaults?.thinkingLevelMap, ...definition.thinkingLevelMap }
            : metadataDefaults?.thinkingLevelMap,
        input: definition.input ?? metadataDefaults?.input ?? ["text"],
        cost: {
            input: definition.cost?.input ?? metadataDefaults?.cost.input ?? 0,
            output: definition.cost?.output ?? metadataDefaults?.cost.output ?? 0,
            cacheRead: definition.cost?.cacheRead ?? metadataDefaults?.cost.cacheRead ?? 0,
            cacheWrite: definition.cost?.cacheWrite ?? metadataDefaults?.cost.cacheWrite ?? 0,
        },
        contextWindow: definition.contextWindow ?? metadataDefaults?.contextWindow ?? 128_000,
        maxTokens: definition.maxTokens ?? metadataDefaults?.maxTokens ?? 16_384,

        headers: metadataDefaults?.headers
            ? { ...metadataDefaults.headers }
            : undefined,
        compat: mergeModelCompat(metadataDefaults?.compat ?? provider.compat, definition.compat),
    };
};
const extensionModels = (provider) => provider.models.map((definition) => ({
    id: definition.id,
    name: definition.name,
    api: provider.api,
    provider: provider.name,
    baseUrl: provider.baseUrl,
    reasoning: definition.reasoning ?? false,
    input: (definition.input ?? ["text"]).filter((input) => input === "text" || input === "image"),
    cost: {
        input: definition.cost?.input ?? 0,
        output: definition.cost?.output ?? 0,
        cacheRead: definition.cost?.cacheRead ?? 0,
        cacheWrite: definition.cost?.cacheWrite ?? 0,
    },
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    headers: mergeModelHeaders(undefined, provider.headers),
}));
export class ModelRuntime {
    builtins = new Map();
    dynamicCatalogs = new Map();
    extensionProviders = new Map();
    managedProviderModels = new Map();
    registeredModels = new Map();
    composed = new Map();
    config = ModelConfig.empty();
    modelsPath;
    storePath;
    refreshPromise;
    refreshIsForce = false;
    providerRefreshes = new Map();
    refreshedAt = null;
    compositionErrors = [];
    compositionFailedProviders = new Set();
    catalogError;
    catalogBaseUrl = DEFAULT_CATALOG_BASE_URL;
    catalogRequestTimeoutMs = REMOTE_CATALOG_TIMEOUT_MS;

    revision = Date.now() * 1_000;
    snapshotFingerprint;
    catalogChangeListeners = new Set();
    constructor() {
        for (const [providerId, models] of Object.entries(MODELS)) {
            if (providerId === "grok" || isRetiredAssistantProvider(providerId))
                continue;
            this.builtins.set(providerId, Object.values(models).map((model) => cloneModel(model)));
        }
        this.recompose();
    }
    async initialize(options) {
        const revisionBeforeInitialization = this.revision;
        this.modelsPath = path.join(options.stellaDataDir, "models.json");
        this.storePath = path.join(options.stellaDataDir, "models-store.json");
        this.catalogBaseUrl = options.catalogBaseUrl ?? DEFAULT_CATALOG_BASE_URL;
        this.catalogRequestTimeoutMs =
            options.catalogRequestTimeoutMs ?? REMOTE_CATALOG_TIMEOUT_MS;
        this.readStoredCatalogs();
        await this.reloadConfig();
        await this.refresh({ allowNetwork: options.allowNetwork ?? true });
        if (this.revision === revisionBeforeInitialization) {
            this.publishCatalogSnapshot();
        }
    }
    readStoredCatalogs() {
        if (!this.storePath)
            return;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
            for (const [providerId, entry] of Object.entries(parsed)) {
                if (isRetiredAssistantProvider(providerId))
                    continue;
                if (!entry || !Array.isArray(entry.models))
                    continue;
                this.dynamicCatalogs.set(providerId, {
                    models: entry.models.map((model) => ({
                        ...model,
                        provider: providerId,
                    })),
                    checkedAt: entry.checkedAt,
                });
            }
        }
        catch {

        }
    }
    writeStoredCatalogs() {
        if (!this.storePath)
            return;
        const stored = Object.fromEntries(this.dynamicCatalogs);
        ensurePrivateDirSync(path.dirname(this.storePath));
        writePrivateFileSync(this.storePath, JSON.stringify(stored, null, 2));
    }
    recompose() {
        const providerIds = new Set([
            ...this.builtins.keys(),
            ...this.dynamicCatalogs.keys(),
            ...this.config.getProviderIds(),
            ...this.extensionProviders.keys(),
            ...this.managedProviderModels.keys(),
            ...this.registeredModels.keys(),
        ]);
        const next = new Map();
        const compositionErrors = [];
        const compositionFailedProviders = new Set();
        for (const providerId of providerIds) {
            if (isRetiredAssistantProvider(providerId))
                continue;
            const composeProvider = (providerConfig) => {
                const models = modelMap(this.builtins.get(providerId) ?? []);
                for (const dynamic of this.dynamicCatalogs.get(providerId)?.models ??
                    []) {
                    models.set(dynamic.id, cloneModel({ ...dynamic, provider: providerId }));
                }
                for (const managed of this.managedProviderModels.get(providerId) ??
                    []) {
                    models.set(managed.id, cloneModel({ ...managed, provider: providerId }));
                }
                if (providerConfig) {
                    for (const [modelId, model] of models) {
                        models.set(modelId, {
                            ...model,
                            api: providerConfig.api ?? model.api,
                            baseUrl: providerConfig.baseUrl ?? model.baseUrl,
                            compat: mergeModelCompat(model.compat, providerConfig.compat),
                        });
                    }
                    for (const definition of providerConfig.models ?? []) {
                        const metadataDefaults = models.get(definition.id);
                        const transportDefaults = metadataDefaults ?? models.values().next().value;
                        models.set(definition.id, createConfiguredModel(providerId, providerConfig, definition, transportDefaults, metadataDefaults));
                    }
                }
                const extension = this.extensionProviders.get(providerId);
                if (extension) {
                    for (const model of extensionModels(extension)) {
                        models.set(model.id, model);
                    }
                }
                for (const model of this.registeredModels.get(providerId)?.values() ??
                    []) {
                    models.set(model.id, cloneModel(model));
                }
                if (providerConfig?.modelOverrides) {
                    for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
                        const model = models.get(modelId);
                        if (model) {
                            models.set(modelId, applyModelOverride(model, override));
                        }
                    }
                }
                return models;
            };
            const providerConfig = this.config.getProvider(providerId);
            let models;
            try {
                models = composeProvider(providerConfig);
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                compositionErrors.push(`models.json Provider "${providerId}": ${detail}`);
                compositionFailedProviders.add(providerId);
                models = composeProvider(undefined);
            }
            if (models.size > 0)
                next.set(providerId, models);
        }
        this.composed = next;
        this.compositionErrors = compositionErrors;
        this.compositionFailedProviders = compositionFailedProviders;
        this.publishCatalogChangeIfNeeded();
    }
    publishCatalogChangeIfNeeded() {
        const snapshot = this.getSnapshot();
        const fingerprint = JSON.stringify({ ...snapshot, revision: undefined });
        if (fingerprint === this.snapshotFingerprint)
            return;
        this.snapshotFingerprint = fingerprint;
        this.publishCatalogSnapshot();
    }
    publishCatalogSnapshot() {
        this.revision += 1;
        const published = this.getSnapshot();
        for (const listener of this.catalogChangeListeners) {
            try {
                listener(published);
            }
            catch {

            }
        }
    }
    onCatalogChanged(listener) {
        this.catalogChangeListeners.add(listener);
        return () => this.catalogChangeListeners.delete(listener);
    }
    async reloadConfig() {
        this.config = await ModelConfig.load(this.modelsPath);
        this.recompose();
    }
    setExtensionProviders(providers) {
        this.extensionProviders.clear();
        for (const provider of providers) {
            if (isRetiredAssistantProvider(provider.name))
                continue;
            this.extensionProviders.set(provider.name, structuredClone(provider));
        }
        this.recompose();
    }
    setManagedProviderModels(providerId, models) {
        if (isRetiredAssistantProvider(providerId))
            return;
        this.managedProviderModels.set(providerId, models.map((model) => cloneModel({ ...model, provider: providerId })));
        this.recompose();
    }
    registerModel(providerId, model) {
        if (isRetiredAssistantProvider(providerId))
            return;
        const models = this.registeredModels.get(providerId) ?? new Map();
        models.set(model.id, cloneModel(model));
        this.registeredModels.set(providerId, models);
        this.recompose();
    }
    unregisterModel(providerId, modelId) {
        const models = this.registeredModels.get(providerId);
        if (!models)
            return;
        models.delete(modelId);
        if (models.size === 0)
            this.registeredModels.delete(providerId);
        this.recompose();
    }
    async refreshProviderOnce(providerId, options) {
        if (isRetiredAssistantProvider(providerId)) {
            this.dynamicCatalogs.delete(providerId);
            return;
        }
        const stored = this.dynamicCatalogs.get(providerId);
        if (!options.force &&
            stored?.checkedAt !== undefined &&
            Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS) {
            return;
        }
        const timeoutSignal = AbortSignal.timeout(this.catalogRequestTimeoutMs);
        const signal = options.lifecycleSignal
            ? AbortSignal.any([options.lifecycleSignal, timeoutSignal])
            : timeoutSignal;
        let response;
        let payload;
        try {
            response = await fetch(new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, this.catalogBaseUrl), { headers: { accept: "application/json" }, signal });

            payload = response.ok ? (await response.json()) : undefined;
        }
        catch (error) {
            throw describeCatalogFetchFailure(providerId, error, {
                timeoutMs: timeoutSignal.aborted
                    ? this.catalogRequestTimeoutMs
                    : undefined,
                cancelled: options.lifecycleSignal?.aborted === true,
            });
        }
        const checkedAt = Date.now();
        if (response.status === 404 || response.status === 501) {
            this.dynamicCatalogs.set(providerId, {
                models: stored?.models ?? [],
                checkedAt,
            });
            return;
        }
        if (!response.ok) {
            throw new Error(`Model catalog request failed for ${providerId}: ${response.status}`);
        }
        const entries = Array.isArray(payload)
            ? payload
            : payload && typeof payload === "object" && "models" in payload
                ? payload.models
                : payload && typeof payload === "object"
                    ? Object.values(payload)
                    : [];
        if (!Array.isArray(entries)) {
            throw new Error(`Invalid model catalog for ${providerId}`);
        }
        const models = entries
            .filter((entry) => Boolean(entry) && typeof entry === "object" && "id" in entry)
            .map((model) => ({ ...model, provider: providerId }));
        this.dynamicCatalogs.set(providerId, { models, checkedAt });
    }
    refreshProvider(providerId, options) {
        const existing = this.providerRefreshes.get(providerId);
        if (existing) {
            if (options.force && !existing.force) {
                return existing.promise.then(() => this.refreshProvider(providerId, options), () => this.refreshProvider(providerId, options));
            }
            return existing.promise;
        }
        const promise = this.refreshProviderOnce(providerId, options).finally(() => {
            if (this.providerRefreshes.get(providerId)?.promise === promise) {
                this.providerRefreshes.delete(providerId);
            }
        });
        this.providerRefreshes.set(providerId, {
            promise,
            force: options.force === true,
        });
        return promise;
    }

    async ensureProviderModel(providerId, modelIds) {
        const candidates = Array.from(new Set(modelIds.map((id) => id.trim()).filter(Boolean)));
        const findCandidate = () => {
            for (const modelId of candidates) {
                const model = this.getModel(providerId, modelId);
                if (model)
                    return model;
            }
            return undefined;
        };
        const cached = findCandidate();
        if (cached)
            return cached;
        if (!STELLA_RELAY_PROVIDERS.includes(providerId)) {
            return undefined;
        }
        const activeRefresh = this.providerRefreshes.get(providerId);
        if (activeRefresh) {
            await activeRefresh.promise;
            this.recompose();
            const refreshedByActiveRequest = findCandidate();
            if (refreshedByActiveRequest)
                return refreshedByActiveRequest;
        }
        await this.refreshProvider(providerId, { force: true });
        this.refreshedAt = Date.now();
        this.writeStoredCatalogs();
        this.recompose();
        return findCandidate();
    }

    async refreshProviders(providerIds, options) {
        const failures = [];
        let cursor = 0;
        const runWorker = async () => {
            while (cursor < providerIds.length && !options.signal?.aborted) {
                const providerId = providerIds[cursor++];
                try {
                    await this.refreshProvider(providerId, {
                        force: options.force,
                        lifecycleSignal: options.signal,
                    });
                }
                catch (error) {
                    if (error instanceof CatalogRefreshCancelledError)
                        continue;
                    failures.push(`${providerId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(REMOTE_CATALOG_CONCURRENCY, providerIds.length) }, runWorker));
        return failures;
    }
    async refresh(options = {}) {
        if (this.refreshPromise) {
            const activeRefresh = this.refreshPromise;
            if (options.force && !this.refreshIsForce) {
                return activeRefresh.then(() => this.refresh(options), () => this.refresh(options));
            }
            return activeRefresh;
        }
        this.refreshIsForce = options.force === true;
        this.refreshPromise = (async () => {
            if (options.allowNetwork !== false) {
                const providerIds = Array.from(new Set([...this.builtins.keys(), ...STELLA_RELAY_PROVIDERS])).filter((providerId) => providerId !== "local");
                const failures = await this.refreshProviders(providerIds, options);

                if (options.signal?.aborted)
                    return;
                const successCount = providerIds.length - failures.length;
                this.catalogError =
                    failures.length > 0
                        ? `Model catalog refresh failed for ${failures.join("; ")}`
                        : undefined;
                if (successCount === 0 && failures.length > 0) {
                    this.publishCatalogChangeIfNeeded();
                    throw new Error(this.catalogError);
                }
                if (successCount > 0) {
                    this.refreshedAt = Date.now();
                    this.writeStoredCatalogs();
                }
            }
            this.recompose();
        })().finally(() => {
            this.refreshPromise = undefined;
            this.refreshIsForce = false;
        });
        return this.refreshPromise;
    }
    async getSnapshotForListing(options = {}) {
        await this.reloadConfig();
        if (options.forceRefresh) {
            await this.refresh({ allowNetwork: true, force: true });
        }
        else {
            void this.refresh({ allowNetwork: true }).catch(() => undefined);
        }
        return this.getSnapshot();
    }
    getModels(providerId) {
        return [...(this.composed.get(providerId)?.values() ?? [])].map(cloneModel);
    }
    getModel(providerId, modelId) {
        const model = this.composed.get(providerId)?.get(modelId);
        return model ? cloneModel(model) : undefined;
    }
    getAllModels() {
        return [...this.composed.values()].flatMap((models) => [...models.values()].map(cloneModel));
    }
    getProviderIds() {
        return [...this.composed.keys()].sort();
    }
    isRegisteredReference(reference) {
        const normalized = reference.trim();
        if (!normalized)
            return false;
        for (const [providerId, models] of this.composed) {
            for (const model of models.values()) {
                if (normalized === model.id ||
                    normalized === `${providerId}/${model.id}` ||
                    normalized === `${model.provider}/${model.id}`) {
                    return true;
                }
            }
        }
        return false;
    }
    getConfiguredApiKey(providerId) {
        return resolveModelConfigValue(this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId)?.apiKey);
    }
    hasConfiguredApiKey(providerId) {
        return isModelConfigValueConfigured(this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId)?.apiKey);
    }
    hasRuntimeManagedAuth(providerId) {
        const extension = this.extensionProviders.get(providerId);
        const provider = this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId);
        return (provider?.apiKey !== undefined ||
            hasStaticAuthHeader(provider?.headers) ||
            provider?.models?.some((model) => hasStaticAuthHeader(model.headers)) ||
            Object.values(provider?.modelOverrides ?? {}).some((override) => hasStaticAuthHeader(override.headers)) ||
            Boolean(extension?.apiKeyEnv) ||
            hasStaticAuthHeader(extension?.headers));
    }
    hasRuntimeProviderOrigin(providerId) {
        return (!this.compositionFailedProviders.has(providerId) &&
            (this.config.getProvider(providerId) !== undefined ||
                this.extensionProviders.has(providerId)));
    }
    allowsCredentiallessRouting(providerId) {
        const provider = this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId);
        if (this.builtins.has(providerId) ||
            !this.hasRuntimeProviderOrigin(providerId) ||
            provider?.authHeader === true ||
            this.hasRuntimeManagedAuth(providerId)) {
            return false;
        }
        return true;
    }
    getRuntimeManagedApiKey(providerId) {
        const configured = this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId)?.apiKey;
        if (configured !== undefined) {
            const apiKey = resolveModelConfigValue(configured);
            if (!apiKey) {
                throw new Error(`Required models.json API key for provider "${providerId}" could not be resolved.`);
            }
            return apiKey;
        }
        const extension = this.extensionProviders.get(providerId);
        if (!extension?.apiKeyEnv)
            return undefined;
        const apiKey = process.env[extension.apiKeyEnv]?.trim();
        if (!apiKey) {
            throw new Error(`Extension provider "${providerId}" requires environment variable "${extension.apiKeyEnv}".`);
        }
        return apiKey;
    }
    usesConfiguredAuthHeader(providerId) {
        return (!this.compositionFailedProviders.has(providerId) &&
            this.config.getProvider(providerId)?.authHeader === true);
    }
    getConfiguredHeaders(providerId, modelId) {
        const provider = this.compositionFailedProviders.has(providerId)
            ? undefined
            : this.config.getProvider(providerId);
        const providerHeaders = resolveModelConfigHeaders(provider?.headers, `provider "${providerId}"`);
        const definitionHeaders = resolveModelConfigHeaders(provider?.models?.find((model) => model.id === modelId)?.headers, `model "${providerId}/${modelId}"`);
        const modelHeaders = resolveModelConfigHeaders(provider?.modelOverrides?.[modelId]?.headers, `model "${providerId}/${modelId}"`);
        const headers = mergeModelHeaders(mergeModelHeaders(providerHeaders, definitionHeaders), modelHeaders);
        return headers;
    }
    getSnapshot() {
        return {
            revision: this.revision,
            models: this.getAllModels().map((model) => {
                const { headers: _headers, ...safeModel } = model;
                return safeModel;
            }),
            runtimeManagedProviders: [
                ...new Set([
                    ...this.config
                        .getProviderIds()
                        .filter((providerId) => !this.compositionFailedProviders.has(providerId) &&
                        !isRetiredAssistantProvider(providerId)),
                    ...this.extensionProviders.keys(),
                    ...this.registeredModels.keys(),
                ]),
            ]
                .sort()
                .map((id) => ({
                id,
                authManaged: this.hasRuntimeManagedAuth(id),
                credentialless: this.allowsCredentiallessRouting(id),
            })),
            refreshedAt: this.refreshedAt,
            configError: [this.config.getError(), ...this.compositionErrors]
                .filter((error) => Boolean(error))
                .join("\n") || undefined,
            catalogError: this.catalogError,
        };
    }
}
export const modelRuntime = new ModelRuntime();

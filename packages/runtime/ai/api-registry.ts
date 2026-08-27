import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

export interface ApiProviderModule<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> {
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

export interface LazyApiProvider<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> {
	api: TApi;
	load: () => Promise<ApiProviderModule<TApi, TOptions>>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {

	resolved?: ApiProviderInternal;

	load?: () => Promise<ApiProviderInternal>;
	loadPromise?: Promise<ApiProviderInternal>;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

function toInternalProvider<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	module: ApiProviderModule<TApi, TOptions>,
): ApiProviderInternal {
	return {
		api,
		stream: wrapStream(api, module.stream),
		streamSimple: wrapStreamSimple(api, module.streamSimple),
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		resolved: toInternalProvider(provider.api, {
			stream: provider.stream,
			streamSimple: provider.streamSimple,
		}),
		sourceId,
	});
}

export function registerLazyApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: LazyApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	const { api, load } = provider;
	apiProviderRegistry.set(api, {
		load: async () => toInternalProvider(api, await load()),
		sourceId,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.resolved;
}

export async function resolveApiProviderInternal(
	api: Api,
): Promise<ApiProviderInternal | undefined> {
	const entry = apiProviderRegistry.get(api);
	if (!entry) return undefined;
	if (entry.resolved) return entry.resolved;
	if (!entry.load) return undefined;
	if (!entry.loadPromise) {
		entry.loadPromise = entry
			.load()
			.then((resolved) => {
				entry.resolved = resolved;
				return resolved;
			})
			.catch((error) => {

				entry.loadPromise = undefined;
				throw error;
			});
	}
	return entry.loadPromise;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.resolved).filter(
		(provider): provider is ApiProviderInternal => provider !== undefined,
	);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}

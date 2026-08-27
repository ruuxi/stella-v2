import "./providers/register-builtins.js";
import "./utils/http-proxy.js";

import { getApiProvider, resolveApiProviderInternal } from "./api-registry.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

function makeProviderErrorMessage(
	model: Model<Api>,
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

async function pipeStream(
	model: Model<Api>,
	out: AssistantMessageEventStream,
	produce: () => Promise<AssistantMessageEventStream>,
): Promise<void> {
	let inner: AssistantMessageEventStream;
	try {
		inner = await produce();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		out.push({
			type: "error",
			reason: "error",
			error: makeProviderErrorMessage(
				model,
				`Failed to load API provider for ${model.api}: ${message}`,
			),
		});
		out.end();
		return;
	}
	try {
		for await (const event of inner) {
			out.push(event);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		out.push({
			type: "error",
			reason: "error",
			error: makeProviderErrorMessage(model, message),
		});
	} finally {
		out.end();
	}
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const eager = getApiProvider(model.api);
	if (eager) {
		return eager.streamSimple(model as Model<Api>, context, options);
	}
	const out = new AssistantMessageEventStream();
	void pipeStream(model as Model<Api>, out, async () => {
		const provider = await resolveApiProviderInternal(model.api);
		if (!provider) {
			throw new Error(`No API provider registered for api: ${model.api}`);
		}
		return provider.streamSimple(model as Model<Api>, context, options);
	});
	return out;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const eager = getApiProvider(model.api);
	if (eager) {
		return eager.stream(model as Model<Api>, context, options as StreamOptions);
	}
	const out = new AssistantMessageEventStream();
	void pipeStream(model as Model<Api>, out, async () => {
		const provider = await resolveApiProviderInternal(model.api);
		if (!provider) {
			throw new Error(`No API provider registered for api: ${model.api}`);
		}
		return provider.stream(model as Model<Api>, context, options as StreamOptions);
	});
	return out;
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

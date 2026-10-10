/**
 * The managed gateway lane answers with one complete provider-native JSON
 * body and rejects `stream: true`. pi-ai's adapters only stream, so the
 * `stella` provider asks for JSON and replays it to the adapter as the
 * provider's own SSE stream: the same events a streaming call would have
 * produced, delivered at once.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sse = (frames: readonly { event?: string; data: unknown }[]): string =>
  frames
    .map(({ event, data }) =>
      `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** `chat.completion` JSON as the `chat.completion.chunk` stream the OpenAI SDK parses. */
export function chatCompletionToSse(completion: unknown): string {
  if (!isObject(completion) || !Array.isArray(completion.choices)) {
    throw new Error("Stella gateway returned a malformed chat completion.");
  }
  const choice = (completion.choices[0] ?? {}) as Json;
  const message = (isObject(choice.message) ? choice.message : {}) as Json;
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const chunk = (delta: Json, terminal: boolean) => ({
    ...base,
    choices: [{ index: choice.index ?? 0, delta, finish_reason: terminal ? (choice.finish_reason ?? "stop") : null }],
    ...(terminal && completion.usage !== undefined ? { usage: completion.usage } : {}),
  });

  const frames: Json[] = [];
  const reasoningField = REASONING_FIELDS.find(
    (field) => typeof message[field] === "string" && (message[field] as string).length > 0,
  );
  if (reasoningField) frames.push(chunk({ role: "assistant", [reasoningField]: message[reasoningField] }, false));
  if (typeof message.content === "string" && message.content.length > 0) {
    frames.push(chunk({ role: "assistant", content: message.content }, false));
  }
  const terminal: Json = { role: "assistant" };
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const calls = toolCalls.flatMap((call, index) =>
    isObject(call) && isObject(call.function)
      ? [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments ?? "" } }]
      : [],
  );
  if (calls.length > 0) terminal.tool_calls = calls;
  if (Array.isArray(message.reasoning_details)) terminal.reasoning_details = message.reasoning_details;
  frames.push(chunk(terminal, true));
  return sse([...frames.map((data) => ({ data })), { data: "[DONE]" }]);
}

/** Anthropic `message` JSON as the Messages SSE event stream. */
export function anthropicMessageToSse(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.content)) {
    throw new Error("Stella gateway returned a malformed Anthropic message.");
  }
  const usage = isObject(message.usage) ? message.usage : {};
  const frames: { event: string; data: Json }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } },
      },
    },
  ];
  message.content.forEach((block, index) => {
    if (!isObject(block)) return;
    const stop = { event: "content_block_stop", data: { type: "content_block_stop", index } };
    switch (block.type) {
      case "text":
        frames.push(
          { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text ?? "" } } },
          stop,
        );
        return;
      case "thinking":
        frames.push(
          { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking ?? "" } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature ?? "" } } },
          stop,
        );
        return;
      case "tool_use":
      case "server_tool_use":
        frames.push(
          { event: "content_block_start", data: { type: "content_block_start", index, content_block: { ...block, input: {} } } },
          { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } } },
          stop,
        );
        return;
      default:
        frames.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block } }, stop);
    }
  });
  frames.push(
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: message.stop_sequence ?? null },
        usage,
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return sse(frames);
}

/** OpenAI Responses `response` JSON as the Responses SSE event stream. */
export function responseToSse(response: unknown): string {
  if (!isObject(response) || !Array.isArray(response.output)) {
    throw new Error("Stella gateway returned a malformed Responses object.");
  }
  let sequence = 0;
  const frame = (type: string, data: Json) => ({ event: type, data: { type, sequence_number: sequence++, ...data } });
  const frames = [frame("response.created", { response: { ...response, status: "in_progress", output: [] } })];
  response.output.forEach((item, outputIndex) => {
    if (!isObject(item)) return;
    frames.push(frame("response.output_item.added", { output_index: outputIndex, item }));
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((part, contentIndex) => {
        if (!isObject(part) || part.type !== "output_text") return;
        frames.push(
          frame("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...part, text: "" } }),
          frame("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text ?? "" }),
          frame("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text ?? "" }),
          frame("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: contentIndex, part }),
        );
      });
    }
    if (item.type === "function_call") {
      frames.push(
        frame("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: item.arguments ?? "" }),
        frame("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments ?? "" }),
      );
    }
    frames.push(frame("response.output_item.done", { output_index: outputIndex, item }));
  });
  frames.push(frame("response.completed", { response }));
  return sse(frames);
}

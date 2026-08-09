import { describe, expect, it, vi } from "vitest";

import { Agent } from "@stella/runtime/kernel/agent-core/agent";
import {
  createStreamRuleMonitor,
  DEFAULT_STREAM_RULES,
  detectRepetitionLoop,
} from "@stella/runtime/kernel/agent-core/stream-rules";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@stella/runtime/ai/types";

const model = {
  id: "stream-rules-test",
  name: "Stream rules test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

/** Fake provider: streams `text` as one delta, then completes. */
const makeStreamFn = (responses: string[]) => {
  const streamFn = vi.fn((_model: Model<Api>, _context: Context) => {
    const text = responses[streamFn.mock.calls.length - 1] ?? "fallback";
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(text);
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  });
  return streamFn;
};

const lastUserText = (context: Context): string => {
  const last = context.messages.at(-1) as UserMessage | undefined;
  if (!last || last.role !== "user") return "";
  return typeof last.content === "string"
    ? last.content
    : last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

describe("detectRepetitionLoop", () => {
  it("fires on many consecutive identical lines", () => {
    const looped = `${"const x = compute();\n".repeat(20)}partial`;
    expect(detectRepetitionLoop(looped)).toBe(true);
  });

  it("stays quiet on normal prose and code", () => {
    const normal = Array.from({ length: 50 }, (_, i) => `line number ${i}`).join("\n");
    expect(detectRepetitionLoop(normal)).toBe(false);
  });

  it("stays quiet below the threshold", () => {
    const few = `${"same line here\n".repeat(8)}next`;
    expect(detectRepetitionLoop(few)).toBe(false);
  });

  it("fires on a single-line unit loop", () => {
    expect(detectRepetitionLoop(`answer: ${"no ".repeat(200)}`)).toBe(true);
  });

  it("allows long but non-repeating single lines", () => {
    const long = Array.from({ length: 300 }, (_, i) => String(i % 97)).join(",");
    expect(detectRepetitionLoop(long)).toBe(false);
  });
});

describe("createStreamRuleMonitor", () => {
  it("matches DeepSeek tool-call special tokens in text scope", () => {
    const monitor = createStreamRuleMonitor(DEFAULT_STREAM_RULES);
    expect(monitor.observe("text", 0, "Sure, I'll run that: <｜tool▁calls▁begin｜>")).toMatchObject(
      { id: "tool-call-as-text" },
    );
  });

  it("matches across delta boundaries", () => {
    const monitor = createStreamRuleMonitor(DEFAULT_STREAM_RULES);
    expect(monitor.observe("text", 0, "let me call <tool_")).toBeNull();
    expect(monitor.observe("text", 0, "call>")).toMatchObject({ id: "tool-call-as-text" });
  });

  it("ignores text-scoped rules in toolcall deltas", () => {
    const monitor = createStreamRuleMonitor(DEFAULT_STREAM_RULES);
    expect(monitor.observe("toolcall", 0, '{"note": "<tool_call>"}')).toBeNull();
  });

  it("catches think-tag leaks at the start of visible text", () => {
    const monitor = createStreamRuleMonitor(DEFAULT_STREAM_RULES);
    expect(monitor.observe("text", 0, "<think>hmm, the user wants")).toMatchObject({
      id: "think-tag-leak",
    });
  });

  it("fires at most once", () => {
    const monitor = createStreamRuleMonitor(DEFAULT_STREAM_RULES);
    expect(monitor.observe("text", 0, "<tool_call>")).not.toBeNull();
    expect(monitor.observe("text", 0, "<tool_call>")).toBeNull();
  });
});

describe("agent loop stream-rule retry", () => {
  it("aborts a bad attempt, injects an ephemeral correction, and recovers", async () => {
    const streamFn = makeStreamFn([
      'I will edit the file now.\n<tool_call>{"name":"Edit"}</tool_call>',
      "Done — I updated the file with the Edit tool.",
    ]);
    const agent = new Agent({ initialState: { model }, streamFn });

    await agent.prompt("Please update the config.");

    expect(streamFn).toHaveBeenCalledTimes(2);

    // The retry request carries the system-reminder correction…
    const retryContext = streamFn.mock.calls[1]?.[1] as Context;
    expect(lastUserText(retryContext)).toContain("<system-reminder>");
    expect(lastUserText(retryContext)).toContain("tool-calling interface");

    // …but the correction never lands in durable history.
    const userMessages = agent.state.messages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages).toHaveLength(1);

    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Done — I updated the file with the Edit tool." }],
    });
  });

  it("stops monitoring after the retry budget and lets output through", async () => {
    const bad = "prefix <tool_call> stubborn";
    const streamFn = makeStreamFn([bad, bad, bad, bad]);
    const agent = new Agent({ initialState: { model }, streamFn });

    await agent.prompt("Do the thing.");

    // 1 initial + 2 monitored retries + final unmonitored pass-through.
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: bad }],
    });
  });

  it("streamRules: [] disables monitoring entirely", async () => {
    const bad = "text with <tool_call> marker";
    const streamFn = makeStreamFn([bad]);
    const agent = new Agent({ initialState: { model }, streamFn, streamRules: [] });

    await agent.prompt("Go.");

    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: bad }],
    });
  });

  it("clean responses stream through untouched", async () => {
    const streamFn = makeStreamFn(["All done, nothing suspicious here."]);
    const agent = new Agent({ initialState: { model }, streamFn });

    await agent.prompt("Quick check.");

    expect(streamFn).toHaveBeenCalledTimes(1);
  });
});

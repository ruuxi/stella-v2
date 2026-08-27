import { streamOpenAICompletions } from "../convex/runtime_ai/openai_completions";

const model = {
  id: "meta/muse-spark-1.2-contributor",
  name: "Muse Spark 1.2 Contributor",
  api: "openai-completions" as const,
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 8192,
};

const context = {
  systemPrompt: "You are a smoke test. Reply tersely.",
  messages: [
    { role: "user" as const, content: "Reply with exactly: PONG", timestamp: Date.now() },
  ],
  tools: [],
};

const stream = streamOpenAICompletions(model, context as any, {
  apiKey: process.env.OPENROUTER_API_KEY!,
  maxTokens: 2048,
  reasoningEffort: "xhigh" as any,
  sessionId: `smoke-muse-${Date.now()}`,
} as any);

let last: any = null;
const eventTypes = new Set<string>();
for await (const event of stream as AsyncIterable<any>) {
  eventTypes.add(event.type);
  if (event.type === "done") last = event.message;
  if (event.type === "error") throw new Error(`stream error: ${JSON.stringify(event.error)}`);
}

if (!last) throw new Error("no done event");
const text = (last.content ?? [])
  .filter((c: any) => c.type === "text")
  .map((c: any) => c.text)
  .join("");
const reasoning = (last.content ?? []).filter((c: any) => c.type === "thinking").length;

console.log("events:", [...eventTypes].join(","));
console.log("stopReason:", last.stopReason);
console.log("text:", JSON.stringify(text));
console.log("reasoning blocks:", reasoning);
console.log("usage:", JSON.stringify(last.usage));
const u = last.usage;
if (!text.includes("PONG")) throw new Error("model did not reply PONG");
if (!u || u.output <= 0) throw new Error("no output usage parsed");
console.log("✅ SMOKE TEST PASSED");

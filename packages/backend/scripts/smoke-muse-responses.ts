/** Live smoke test: Muse Spark 1.2 Contributor via OpenRouter Responses API. */
import { streamOpenAIResponses } from "../convex/runtime_ai/openai_responses";

const model = {
  id: "meta/muse-spark-1.2-contributor",
  name: "Muse Spark 1.2 Contributor",
  api: "openai-responses" as const,
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
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

const stream = streamOpenAIResponses(model, context as any, {
  apiKey: process.env.OPENROUTER_API_KEY!,
  maxTokens: 2048,
  reasoningEffort: "xhigh" as any,
  sessionId: `smoke-muse-resp-${Date.now()}`,
} as any);

let last: any = null;
for await (const event of stream as AsyncIterable<any>) {
  if (event.type === "done") last = event.message;
  if (event.type === "error") throw new Error(`stream error: ${JSON.stringify(event.error).slice(0, 400)}`);
}
if (!last) throw new Error("no done event");
const text = (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
console.log("stopReason:", last.stopReason);
console.log("text:", JSON.stringify(text));
console.log("usage:", JSON.stringify(last.usage));
if (!text.includes("PONG")) throw new Error("no PONG");
if (!last.usage?.output) throw new Error("no usage");
console.log("✅ RESPONSES API SMOKE TEST PASSED");

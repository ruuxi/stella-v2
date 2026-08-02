import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerApiProvider } from "@stella/runtime/ai/api-registry";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@stella/runtime/ai/types";
import { runDreamDeltaShadow } from "@stella/runtime/kernel/agent-runtime/dream-scheduler";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

const assistant = (): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "## Proposed MEMORY.md blocks\n- None." }],
  api: "fake" as Api,
  provider: "openai",
  model: "fake-shadow",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const route = (args: {
  onRequest?: () => void;
  delayMs?: number;
}): ResolvedLlmRoute => {
  const api = `fake-shadow-${Math.random().toString(36).slice(2)}` as Api;
  const stream = () =>
    ({
      result: async () => {
        args.onRequest?.();
        if (args.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, args.delayMs));
        }
        return assistant();
      },
    }) as AssistantMessageEventStream;
  registerApiProvider({
    api,
    stream: stream as (
      model: Model<Api>,
      context: Context,
      options?: StreamOptions,
    ) => AssistantMessageEventStream,
    streamSimple: stream as (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream,
  });
  return {
    route: "direct-provider",
    model: {
      id: "fake-shadow",
      name: "Fake shadow",
      api,
      provider: "openai",
      baseUrl: "http://localhost:3210/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } as unknown as Model<Api>,
    getApiKey: () => "",
  };
};

const store = (state: { watermark: number }): RuntimeStore =>
  ({
    dreamInboxStore: {
      readDeltaWatermark: () => state.watermark,
      advanceDeltaWatermark: (_conversationId: string, value: number) => {
        state.watermark = Math.max(state.watermark, value);
      },
    },
    loadRawThreadMessagesWithEntryTypes: () => [
      { timestamp: 101, role: "user", content: "Durable preference" },
    ],
  }) as unknown as RuntimeStore;

describe("Dream delta shadow", () => {
  it("advances only after an atomic log write and recovers a landed window idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-shadow-"));
    roots.add(root);
    const memories = path.join(root, "memories");
    await writeFile(memories, "blocks directory creation", "utf-8");
    const state = { watermark: 100 };
    let requests = 0;
    const resolvedLlm = route({ onRequest: () => (requests += 1) });
    const common = {
      stellaDataDir: root,
      store: store(state),
      resolvedLlm,
      conversationId: "conv-shadow",
      liveMemoryChanged: true,
      liveMapChanged: false,
    };

    expect(await runDreamDeltaShadow(common)).toBe("failed");
    expect(state.watermark).toBe(100);
    await unlink(memories);
    await mkdir(memories);
    expect(await runDreamDeltaShadow(common)).toBe("completed");
    expect(state.watermark).toBe(101);
    expect(requests).toBe(1);
    const landed = await readFile(
      path.join(memories, "memory_shadow.md"),
      "utf-8",
    );
    expect(landed).toContain("DREAM:SHADOW_WINDOW conv-shadow 100 101");

    // Simulate a crash after rename/fsync but before the watermark commit.
    state.watermark = 100;
    expect(await runDreamDeltaShadow(common)).toBe("completed");
    expect(state.watermark).toBe(101);
    expect(requests).toBe(1);
    expect(
      (await readFile(path.join(memories, "memory_shadow.md"), "utf-8")).split(
        "DREAM:SHADOW_WINDOW conv-shadow 100 101",
      ),
    ).toHaveLength(2);
  });

  it("single-flights concurrent shadow derivations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-shadow-"));
    roots.add(root);
    await mkdir(path.join(root, "memories"));
    const state = { watermark: 100 };
    const common = {
      stellaDataDir: root,
      store: store(state),
      resolvedLlm: route({ delayMs: 50 }),
      conversationId: "conv-shadow",
      liveMemoryChanged: false,
      liveMapChanged: false,
    };
    const first = runDreamDeltaShadow(common);
    const second = await runDreamDeltaShadow(common);
    expect(second).toBe("skipped_busy");
    expect(await first).toBe("completed");
  });
});

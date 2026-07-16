import { describe, expect, it } from "vitest";
import { HookEmitter } from "@stella/runtime/kernel/extensions/hook-emitter";

describe("HookEmitter", () => {
  describe("has", () => {
    it("returns false when no hook is registered for the event", () => {
      const emitter = new HookEmitter();
      expect(emitter.has("message_update")).toBe(false);
    });

    it("returns true when at least one hook is registered for the event", () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "message_update",
        handler: async () => undefined,
      });
      expect(emitter.has("message_update")).toBe(true);
      expect(emitter.has("agent_end")).toBe(false);
    });
  });

  describe("clearBySource preserves bundled hooks", () => {
    it("leaves bundled hooks intact when only extension hooks are swept (F1 invariant)", async () => {
      const emitter = new HookEmitter();
      let bundledCalls = 0;
      let extensionCalls = 0;
      emitter.register({
        event: "before_agent_start",
        source: "bundled",
        handler: async () => {
          bundledCalls += 1;
          return { systemPromptReplace: "from-bundled" };
        },
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => {
          extensionCalls += 1;
          return { systemPromptAppend: "from-extension" };
        },
      });

      emitter.clearBySource("extension");

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(bundledCalls).toBe(1);
      expect(extensionCalls).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ systemPromptReplace: "from-bundled" });
    });

    it("treats source-less hooks as extension (legacy registrations)", () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "agent_end",
        handler: async () => undefined,
      });
      expect(emitter.has("agent_end")).toBe(true);
      emitter.clearBySource("extension");
      expect(emitter.has("agent_end")).toBe(false);
    });
  });

  describe("emitAll ordering composition", () => {
    it("returns every non-empty result in registration order", async () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "before_agent_start",
        source: "bundled",
        handler: async () => ({ systemPromptReplace: "personality" }),
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => ({ systemPromptAppend: "ext-1" }),
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => null,
      });
      emitter.register({
        event: "before_agent_start",
        source: "extension",
        handler: async () => ({ systemPromptAppend: "ext-2" }),
      });

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(results).toEqual([
        { systemPromptReplace: "personality" },
        { systemPromptAppend: "ext-1" },
        { systemPromptAppend: "ext-2" },
      ]);
    });

    it("returns an empty array when no hooks are registered", async () => {
      const emitter = new HookEmitter();
      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );
      expect(results).toEqual([]);
    });

    it("swallows individual hook errors and continues with the rest", async () => {
      const emitter = new HookEmitter();
      emitter.register({
        event: "before_agent_start",
        handler: async () => ({ systemPromptReplace: "first" }),
      });
      emitter.register({
        event: "before_agent_start",
        handler: async () => {
          throw new Error("buggy extension");
        },
      });
      emitter.register({
        event: "before_agent_start",
        handler: async () => ({ systemPromptAppend: "third" }),
      });

      const results = await emitter.emitAll(
        "before_agent_start",
        {
          agentType: "orchestrator",
          systemPrompt: "base",
          conversationId: "conv-1",
          isUserTurn: true,
        },
        { agentType: "orchestrator" },
      );

      expect(results).toEqual([
        { systemPromptReplace: "first" },
        { systemPromptAppend: "third" },
      ]);
    });
  });
});

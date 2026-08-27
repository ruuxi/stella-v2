import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  buildSubagentPromptMessages,
  buildSystemPrompt,
  buildHistorySource,
  buildStartupPromptMessages,
} from "@stella/runtime/kernel/agent-runtime/thread-memory.js";
import {
  buildResidentFold,
  parseResidentFold,
} from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import { readMemoryMapDoc } from "@stella/runtime/kernel/runner/shared";

const readStartupDocBody = (text: string): string => {
  const match = text.match(/<startup_doc[^>]*>\n([\s\S]*)\n<\/startup_doc>/);
  if (!match?.[1]) throw new Error("startup doc body not found");
  return match[1];
};

describe("buildSystemPrompt", () => {
  it("adds structured file-editing guidance when apply_patch is available", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command", "apply_patch"],
    });

    expect(prompt).toContain("Prefer `apply_patch`");
    expect(prompt).toContain("Do not use shell heredocs");
    expect(prompt).toContain("You are running on macOS.");
  });

  it("omits file-editing guidance when apply_patch is unavailable", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [],
      toolsAllowlist: ["exec_command"],
    });

    expect(prompt).not.toContain("Prefer `apply_patch`");
    expect(prompt).toContain("You are running on macOS.");
  });
});

describe("buildStartupPromptMessages", () => {
  it("does not resurrect the legacy registry startup doc when explicitly requested", async () => {
    const stellaDataDir = await mkdtemp(
      path.join(tmpdir(), "stella-registry-"),
    );
    try {
      await writeFile(
        path.join(stellaDataDir, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
        },
        stellaDataDir,
        includeRegistry: true,
      });

      expect(messages).toEqual([]);
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("redacts secrets from core memory startup docs", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        coreMemory: "OPENAI_API_KEY=sk-testsecret12345678901234567890",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).not.toContain("sk-testsecret12345678901234567890");
    expect(promptText).toContain("OPENAI_API_KEY=");
    expect(promptText).toContain("***");
  });

  it("push-injects the resident user profile and memory map as startup docs", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        userProfile: "# User Profile\n\n- The user goes by Bob",
        memoryMap: "# Memory map\n\n- Stella v2; source: memory",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/memories/profile.md"');
    expect(promptText).toContain("The user goes by Bob");
    expect(promptText).toContain('path="~/.stella/memories/memory_map.md"');
    expect(promptText).toContain("Stella v2; source: memory");
    expect(
      messages.every((m) => m.customType === "bootstrap.startup_doc"),
    ).toBe(true);
  });

  it.each([
    { chars: 12_000, truncated: false },
    { chars: 12_001, truncated: true },
  ])(
    "caps a $chars-character resident memory map at 12,000 characters",
    async ({ chars, truncated }) => {
      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
          memoryMap: "x".repeat(chars),
        },
      });

      const body = readStartupDocBody(messages[0]?.text ?? "");
      expect(body).toHaveLength(12_000);
      expect(body.includes("resident memory map truncated")).toBe(truncated);
    },
  );

  it("reads only the bounded current memory map when a legacy summary still exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-resident-memory-"));
    try {
      const memoriesDir = path.join(root, "memories");
      await mkdir(memoriesDir, { recursive: true });
      await writeFile(
        path.join(memoriesDir, "memory_summary.md"),
        "LEGACY_RETIRED_SUMMARY",
      );
      await writeFile(
        path.join(memoriesDir, "memory_map.md"),
        `${"m".repeat(6_000 - "MAP_SENTINEL".length)}MAP_SENTINEL`,
      );
      const memoryMap = readMemoryMapDoc(root);
      expect(memoryMap).toHaveLength(6_000);
      expect(memoryMap).toContain("MAP_SENTINEL");
      expect(memoryMap).not.toContain("LEGACY_RETIRED_SUMMARY");

      const messages = await buildStartupPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
          memoryMap,
        },
      });
      const body = readStartupDocBody(messages[0]?.text ?? "");
      expect(messages[0]?.text).toContain(
        'path="~/.stella/memories/memory_map.md"',
      );
      expect(body).toHaveLength(6_000);
      expect(body).toContain("MAP_SENTINEL");
      expect(body).not.toContain("LEGACY_RETIRED_SUMMARY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-inject resident docs already persisted in thread history", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "",
            customMessage: {
              customType: "bootstrap.startup_doc",
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/memories/profile.md">\n# User Profile\n\n- The user goes by Bob\n</startup_doc>',
                },
              ],
            },
          },
        ],
        userProfile: "# User Profile\n\n- The user goes by Bob",
      },
    });

    expect(messages).toEqual([]);
  });

  it("re-injects a resident doc whose content changed since it was persisted", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "",
            customMessage: {
              customType: "bootstrap.startup_doc",
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/memories/profile.md">\n# User Profile\n\n- The user goes by Bob\n</startup_doc>',
                },
              ],
            },
          },
        ],

        userProfile: "# User Profile\n\n- The user goes by Robert",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/memories/profile.md"');
    expect(promptText).toContain("The user goes by Robert");
    expect(promptText).not.toContain("The user goes by Bob");
  });

  it("injects personality as a startup doc ahead of core memory on the first turn", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
        personality: "# Voice\nWarm and concise.",
        coreMemory: "remembered user context",
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.customType).toBe("bootstrap.startup_doc");
    expect(messages[0]?.text).toContain('path="~/.stella/PERSONALITY.md"');
    expect(messages[0]?.text).toContain("Warm and concise.");
    expect(messages[1]?.text).toContain('path="~/.stella/core-memory.md"');
  });

  it("injects startup docs into existing threads that do not have them yet", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [{ role: "assistant", content: "Earlier reply" }],
        personality: "# Voice\nWarm and concise.",
        coreMemory: "remembered user context",
      },
    });

    const promptText = messages.map((message) => message.text).join("\n");
    expect(promptText).toContain('path="~/.stella/PERSONALITY.md"');
    expect(promptText).toContain('path="~/.stella/core-memory.md"');
  });

  it("omits startup docs that are already persisted in thread history", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "runtimeInternal",
            content: "startup docs",
            customMessage: {
              customType: "bootstrap.startup_doc",
              display: false,
              content: [
                {
                  type: "text",
                  text: '<startup_doc path="~/.stella/PERSONALITY.md">\n# Voice\nWarm and concise.\n</startup_doc>',
                },
              ],
            },
          },
        ],
        personality: "# Voice\nWarm and concise.",
      },
    });

    expect(messages).toEqual([]);
  });

  it("does not assemble dynamic memory", async () => {
    const messages = await buildStartupPromptMessages({
      context: {
        systemPrompt: "system",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [
          {
            role: "assistant",
            content: "Earlier reply",
          },
        ],
      },
    });

    expect(messages).toEqual([]);
  });
});

describe("resident memory compaction", () => {
  const startupDoc = (displayPath: string, text: string) => ({
    role: "runtimeInternal",
    customMessage: {
      customType: "bootstrap.startup_doc",
      content: `<startup_doc path="${displayPath}">\n${text}\n</startup_doc>`,
    },
  });

  it("excludes a legacy summary while retaining current memory in fold plans", () => {
    const fold = buildResidentFold({
      messages: [
        startupDoc(
          "~/.stella/memories/memory_summary.md",
          "LEGACY_RETIRED_SUMMARY",
        ),
        startupDoc("~/.stella/memories/profile.md", "current profile"),
        startupDoc("~/.stella/memories/memory_map.md", "current map"),
      ],
    });

    expect(JSON.stringify(fold)).not.toContain("LEGACY_RETIRED_SUMMARY");
    expect(JSON.stringify(fold)).toContain("current profile");
    expect(JSON.stringify(fold)).toContain("current map");
  });

  it("discards a legacy summary embedded in a persisted fold", () => {
    const parsed = parseResidentFold({
      residentFold: {
        docs: [
          {
            customType: "bootstrap.startup_doc",
            text: '<startup_doc path="~/.stella/memories/memory_summary.md">\nLEGACY_RETIRED_SUMMARY\n</startup_doc>',
          },
          {
            customType: "bootstrap.startup_doc",
            text: '<startup_doc path="~/.stella/memories/memory_map.md">\ncurrent map\n</startup_doc>',
          },
        ],
      },
    });

    expect(JSON.stringify(parsed)).not.toContain("LEGACY_RETIRED_SUMMARY");
    expect(JSON.stringify(parsed)).toContain("current map");
  });
});

describe("buildSubagentPromptMessages", () => {
  it("omits the registry startup doc for General subagent prompts", async () => {
    const stellaDataDir = await mkdtemp(path.join(tmpdir(), "stella-general-"));
    try {
      await writeFile(
        path.join(stellaDataDir, "registry.md"),
        "# Life Registry\n\nregistry orientation",
      );

      const messages = await buildSubagentPromptMessages({
        context: {
          systemPrompt: "system",
          dynamicContext: "",
          maxAgentDepth: 1,
          threadHistory: [],
          coreMemory: "remembered user context",
        },
        stellaDataDir,
        agentType: AGENT_IDS.GENERAL,
        userPrompt: "Do the work.",
      });

      const promptText = messages.map((message) => message.text).join("\n");
      expect(promptText).not.toContain("Life Registry");
      expect(promptText).not.toContain('path="~/.stella/registry.md"');
      expect(promptText).toContain("remembered user context");
      expect(promptText).toContain("Do the work.");
    } finally {
      await rm(stellaDataDir, { recursive: true, force: true });
    }
  });
});

describe("buildHistorySource", () => {
  it("keeps quarantine control records out of provider-visible history", () => {
    const history = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [
        {
          role: "runtimeInternal",
          content: "quarantine control record",
          timestamp: 1,
          customMessage: {
            customType: "containment.quarantine",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  key: "20:call-a",
                  toolName: "read_email",
                  timestamp: 20,
                }),
              },
            ],
            display: false,
          },
        },
        { role: "user", content: "keep this turn", timestamp: 2 },
      ],
    });

    expect(history).toEqual([
      { role: "user", content: "keep this turn", timestamp: expect.any(Number) },
    ]);
  });

  it("filters persisted memory docs when memory is disabled", () => {
    const startupDoc = (displayPath: string, text: string) => ({
      role: "runtimeInternal" as const,
      content: "",
      customMessage: {
        customType: "bootstrap.startup_doc",
        content: [
          {
            type: "text" as const,
            text: `<startup_doc path="${displayPath}">\n${text}\n</startup_doc>`,
          },
        ],
      },
    });
    const history = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      memoryEnabled: false,
      threadHistory: [
        startupDoc("~/.stella/PERSONALITY.md", "Warm and concise."),
        startupDoc("~/.stella/core-memory.md", "private core memory"),
        startupDoc("~/.stella/memories/profile.md", "private profile"),
        startupDoc(
          "~/.stella/memories/memory_summary.md",
          "private memory summary",
        ),
        { role: "user", content: "keep this turn" },
      ],
    });

    const text = JSON.stringify(history);
    expect(text).toContain("Warm and concise.");
    expect(text).toContain("keep this turn");
    expect(text).not.toContain("private core memory");
    expect(text).not.toContain("private profile");
    expect(text).not.toContain("private memory summary");
  });

  it("preserves persisted assistant text byte-for-byte", () => {
    const assistantText = "  exact assistant text\n";
    const [message] = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [
        {
          role: "assistant",
          content: assistantText,
          timestamp: 1,
          payload: {
            role: "assistant",
            content: [{ type: "text", text: assistantText }],
            api: "openai-responses",
            provider: "test",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        },
      ],
    });

    expect(message?.role).toBe("assistant");
    expect(
      message?.role === "assistant" && message.content[0]?.type === "text"
        ? message.content[0].text
        : null,
    ).toBe(assistantText);
  });

  it("excludes persisted failed assistant attempts from reconstructed history", () => {
    const failedAssistant = (stopReason: "error" | "aborted") => ({
      role: "assistant" as const,
      content: "failed provider text",
      timestamp: 1,
      payload: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "failed provider text" }],
        api: "openai-responses" as const,
        provider: "test",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason,
        timestamp: 1,
      },
    });

    const history = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [
        { role: "user", content: "keep user", timestamp: 0 },
        failedAssistant("error"),
        failedAssistant("aborted"),
        {
          ...failedAssistant("error"),
          content: "",
          payload: {
            ...failedAssistant("error").payload,
            content: [{ type: "thinking", thinking: "discarded retry" }],
            stopReason: "stop",
          },
        },
      ],
    });

    expect(history).toEqual([
      { role: "user", content: "keep user", timestamp: expect.any(Number) },
    ]);
  });

  it("drops legacy summaries while retaining current memory entries in chronological order", () => {
    const history = buildHistorySource({
      systemPrompt: "system",
      dynamicContext: "",
      maxAgentDepth: 1,
      threadHistory: [
        {
          role: "runtimeInternal",
          content: "old summary",
          timestamp: 1,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_summary.md">\nold summary\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "old map",
          timestamp: 1.5,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_map.md">\nold map\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "old user",
          timestamp: 2,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [
              {
                type: "text",
                text: '<memory_snapshot target="user">\nold user\n</memory_snapshot>',
              },
            ],
            display: false,
          },
        },
        {
          role: "user",
          content: "hello",
          timestamp: 3,
        },
        {
          role: "runtimeInternal",
          content: "new summary",
          timestamp: 4,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_summary.md">\nnew summary\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "new map",
          timestamp: 4.5,
          customMessage: {
            customType: "bootstrap.memory_file",
            content: [
              {
                type: "text",
                text: '<memory_file path="~/.stella/memories/memory_map.md">\nnew map\n</memory_file>',
              },
            ],
            display: false,
          },
        },
        {
          role: "runtimeInternal",
          content: "new memory",
          timestamp: 5,
          customMessage: {
            customType: "bootstrap.memory_snapshot",
            content: [
              {
                type: "text",
                text: '<memory_snapshot target="user">\nnew memory\n</memory_snapshot>',
              },
            ],
            display: false,
          },
        },
      ],
    });

    const replayedText = history
      .map((message) => {
        if (typeof message.content === "string") {
          return message.content;
        }
        return message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
      })
      .join("\n");

    expect(replayedText).not.toContain("old summary");
    expect(replayedText).toContain("old map");
    expect(replayedText).toContain("old user");
    expect(replayedText).not.toContain("new summary");
    expect(replayedText).toContain("new map");
    expect(replayedText).toContain("new memory");

    expect(replayedText.indexOf("old map")).toBeLessThan(
      replayedText.indexOf("new map"),
    );
    expect(replayedText.indexOf("old user")).toBeLessThan(
      replayedText.indexOf("new memory"),
    );
  });
});

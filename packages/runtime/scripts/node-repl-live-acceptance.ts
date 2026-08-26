import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { NodeReplKernelRegistry } from "../kernel/computer-use/kernel.js";
import type { ToolContext } from "../kernel/tools/types.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(`Node REPL acceptance failed: ${message}`);
};

const context: ToolContext = {
  conversationId: "node-repl-live-acceptance",
  deviceId: "local-device",
  requestId: "node-repl-live-acceptance",
  runId: "node-repl-live-acceptance",
  agentId: "node-repl-live-acceptance",
  agentType: "general",
  stellaAppDir: process.cwd(),
  toolWorkspaceRoot: process.cwd(),
  allowedToolNames: ["node_repl"],
};

const main = async () => {
  assert(
    typeof process.versions.bun === "string",
    "run with Bun so the production external Node child transport is exercised",
  );
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "stella-node-repl-live-"),
  );
  const imagePath = path.join(tempDir, "typed-output.png");
  await writeFile(imagePath, ONE_BY_ONE_PNG);

  const registry = new NodeReplKernelRegistry({
    sessionFactory: () => ({
      request: async () => {
        throw new Error(
          "Live Node REPL acceptance unexpectedly invoked computer use.",
        );
      },
    }),
    cellRetentionMs: 60_000,
    maxRetainedCells: 8,
  });

  try {
    const seed = await registry.evaluate(
      "var livePersistentBinding = 40; 'seeded'",
      context,
    );
    assert(seed === "'seeded'", `unexpected seed output: ${seed}`);
    const persisted = await registry.evaluate(
      "livePersistentBinding + 2",
      context,
    );
    assert(persisted === "42", `binding did not persist: ${persisted}`);

    const started = await registry.startCell(
      [
        "nodeRepl.write('chunk-one')",
        "await new Promise((resolve) => setTimeout(resolve, 250))",
        "nodeRepl.write('chunk-two')",
        "await new Promise((resolve) => setTimeout(resolve, 250))",
        "'terminal-value'",
      ].join("; "),
      context,
      { yieldTimeMs: 50 },
    );
    assert(started.status === "running", "streaming cell did not yield");
    assert(started.fromCursor === 0, "initial cursor did not start at zero");
    assert(started.cursor === 1, `unexpected initial cursor ${started.cursor}`);
    assert(
      started.output === "chunk-one",
      `unexpected initial streamed output: ${started.output}`,
    );

    const second = await registry.waitCell(started.cellId, context, {
      waitMs: 1_000,
    });
    assert(
      second.status === "running",
      "second chunk did not remain resumable",
    );
    assert(
      second.fromCursor === 1,
      `unexpected second fromCursor ${second.fromCursor}`,
    );
    assert(second.cursor === 2, `unexpected second cursor ${second.cursor}`);
    assert(
      second.output === "chunk-two",
      `wait replayed or lost output: ${second.output}`,
    );

    const terminalChunk = await registry.waitCell(started.cellId, context, {
      waitMs: 1_000,
    });
    assert(terminalChunk.fromCursor === 2, "terminal output was not new-only");
    assert(
      terminalChunk.cursor === 3,
      `unexpected terminal cursor ${terminalChunk.cursor}`,
    );
    assert(
      terminalChunk.output === "'terminal-value'",
      `unexpected terminal output: ${terminalChunk.output}`,
    );

    // The terminal value and terminal status are separate child messages.
    // Depending on IPC scheduling, one observation can receive the value just
    // before the status. A subsequent observation must then complete without
    // replaying already-delivered content.
    const completion =
      terminalChunk.status === "completed"
        ? terminalChunk
        : await registry.waitCell(started.cellId, context, { waitMs: 1_000 });
    assert(completion.status === "completed", "cell did not reach completion");
    if (completion !== terminalChunk) {
      assert(
        completion.fromCursor === 3,
        "completion replayed terminal output",
      );
      assert(completion.cursor === 3, "completion changed the terminal cursor");
      assert(completion.output === "", "completion returned duplicate output");
    }

    const replay = await registry.waitCell(started.cellId, context, {
      afterCursor: 0,
      waitMs: 0,
    });
    assert(
      replay.output === "chunk-one\nchunk-two\n'terminal-value'",
      `explicit cursor replay was incomplete: ${replay.output}`,
    );

    const image = await registry.evaluateDetailed(
      `nodeRepl.emitImage(${JSON.stringify(imagePath)}, { mimeType: 'image/png', detail: 'original' }); 'image-complete'`,
      context,
    );
    assert(image.content.length === 2, "typed image content count was not two");
    assert(
      image.content[0]?.type === "image",
      "first typed item was not an image",
    );
    assert(
      image.content[0]?.type === "image" &&
        image.content[0].path === imagePath &&
        image.content[0].mimeType === "image/png" &&
        image.content[0].detail === "original",
      "typed image metadata did not survive the child protocol",
    );
    assert(
      image.content[1]?.type === "text" &&
        image.content[1].text === "'image-complete'",
      "terminal text did not follow typed image output",
    );

    const reset = await registry.evaluateDetailed(
      "var bindingDiscardedByReset = 123; nodeRepl.reset()",
      context,
    );
    assert(
      reset.reset?.reason === "explicit",
      "explicit reset reason was absent",
    );
    assert(
      reset.reset?.previousGeneration === 1 &&
        reset.reset.nextGeneration === 2 &&
        reset.reset.bindingsDiscarded === true,
      `unexpected reset receipt: ${JSON.stringify(reset.reset)}`,
    );
    const status = await registry.evaluateDetailed(
      "nodeRepl.status()",
      context,
    );
    assert(
      status.generation === 2,
      `generation did not advance: ${status.generation}`,
    );
    const discarded = await registry.evaluate(
      "typeof bindingDiscardedByReset",
      context,
    );
    assert(
      discarded === "'undefined'",
      `reset binding remained visible: ${discarded}`,
    );

    const resetError = await registry.startCell(
      "var bindingDiscardedAfterResetError = 456; nodeRepl.reset(); throw new Error('live failure after reset')",
      context,
      { yieldTimeMs: 1_000 },
    );
    assert(resetError.status === "failed", "reset-then-error did not fail");
    assert(
      resetError.error?.includes("live failure after reset") === true,
      `reset-then-error lost the original failure: ${resetError.error}`,
    );
    assert(
      resetError.reset?.reason === "explicit" &&
        resetError.reset.previousGeneration === 2 &&
        resetError.reset.nextGeneration === 3 &&
        resetError.reset.bindingsDiscarded === true,
      `reset-then-error lost reset provenance: ${JSON.stringify(resetError.reset)}`,
    );
    const resetErrorStatus = await registry.evaluateDetailed(
      "nodeRepl.status()",
      context,
    );
    assert(
      resetErrorStatus.generation === 3,
      `reset-then-error did not advance generation: ${resetErrorStatus.generation}`,
    );
    const resetErrorDiscarded = await registry.evaluate(
      "typeof bindingDiscardedAfterResetError",
      context,
    );
    assert(
      resetErrorDiscarded === "'undefined'",
      `reset-then-error preserved an old binding: ${resetErrorDiscarded}`,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          transport: "external-node-child",
          persistence: persisted,
          streaming: {
            cellId: started.cellId,
            cursors: [started.cursor, second.cursor, terminalChunk.cursor],
            statuses: [
              started.status,
              second.status,
              terminalChunk.status,
              ...(completion === terminalChunk ? [] : [completion.status]),
            ],
            replay: replay.output,
          },
          typedImage: image.content[0],
          reset: reset.reset,
          nextGeneration: status.generation,
          discardedBindingType: discarded,
          resetThenError: {
            status: resetError.status,
            error: resetError.error,
            reset: resetError.reset,
            nextGeneration: resetErrorStatus.generation,
            discardedBindingType: resetErrorDiscarded,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await registry.dispose();
    await rm(tempDir, { recursive: true, force: true });
  }
};

await main();

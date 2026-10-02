---
name: bun-mock-module-leaks
description: "bun:test mock.module is process-global (leaks into sibling files, ignores ?query re-imports); scope mocks with a flag toggled in beforeAll/afterAll"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2a9d3b5c-ca0d-46ab-887f-b2e7f061b86a
  modified: 2026-09-05T21:18:45.791Z
---

In this repo's `bun test` packages (executor-cloud, cloud-builder, model-gateway, mobile) a top-level `mock.module(...)` stays active for every later test file in the same process, and file order depends on directory scan order, so adding/removing files can expose the leak. Re-importing the module with a `?query` suffix does not bypass the mock (bun mocks by resolved path).

**Why:** 2026-09-05 cleanup: `relay-model-registry-load.test.ts`'s strict registry mock broke 7 tests in `relay-model.test.ts` once sibling files changed.

**How to apply:** capture the real exports with a static `import * as m` before calling `mock.module`, have the mock delegate to those captured functions, and gate the fake behaviour behind a flag set in `beforeAll` and cleared in `afterAll` (pattern now in `packages/executor-cloud/src/relay-model-registry-load.test.ts`). Prefer that over subprocess fixtures. See [[use-codex-agents-and-review-diffs]] for the general "verify agent test claims" rule.

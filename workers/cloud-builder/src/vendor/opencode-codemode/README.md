# opencode-codemode (vendored)

OpenCode's confined JavaScript interpreter, the runtime behind the cloud `code`
tool (`../../cloud-code-executor.ts`). Copied from `packages/codemode/src` of
https://github.com/sst/opencode at `055d95bb7e278c94baf06235a52cac79dd13ba67`
(MIT, see `LICENSE`). The package is private upstream, so it is not on npm.

Left out: `openapi/` and the tests.

Stella's changes, each marked `Stella:` in the source:

- `interpreter/runtime.ts`: programs are parsed by Acorn directly, without the
  TypeScript `transpileModule` step, so the Worker does not bundle the
  TypeScript compiler. `interpreter/model.ts` shifts source locations to match.
- `tool-runtime.ts`, `interpreter/runtime.ts`, `codemode.ts`: an execution can
  declare extra globals (`connect`, `history`, `browser`, `memory`), each a tool
  namespace under a root key that program code cannot name or enumerate.
- `tool-runtime.ts`: no `$codemode` namespace when there are no described
  tools, and unknown-tool hints point at `tools.$list()` / `tools.$search()`.
- `tool-error.ts`: `Schema.TaggedError`, the effect 4.0.0 name.

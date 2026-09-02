# @stella/model-catalog

Runtime-agnostic model routing for Stella's managed model lane. No Node
builtins, no Convex imports, no env access: every module runs unchanged in
Convex, Cloudflare Workers, Bun, and the desktop runtime.

- `model` / `aliases` / `agent-constants`: audience tables, mode configs, `stella/...` alias resolution.
- `managed-gateway` / `request-shaping` / `request-estimate`: provider base URLs, upstream URL + body + header shaping, token estimates.
- `usage` / `pricing`: per-provider usage normalization and micro-cent cost math.
- `cloud-binding` / `native-relay`: turn-binding validators and the connected-credential (Claude Code / Codex) helpers.

Import subpaths directly (`@stella/model-catalog/model`); `index.ts` re-exports everything. Tests: `bun test tests`.

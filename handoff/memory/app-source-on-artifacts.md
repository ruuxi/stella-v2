---
name: app-source-on-artifacts
description: "v3 app source lives on Cloudflare Artifacts — namespaces, publish script, per-owner forks, token lifetimes"
metadata:
  node_type: memory
  type: project
  originSessionId: 53cfdb37-b553-4192-9505-c698600ee951
  modified: 2026-10-02T04:16:05.438Z
---

Shipped 2026-10-01 (commit 3fd2ca214), part of [[stella-v3-and-all-cloudflare]].

- Namespaces: `stella-app-dev` (dev worker), `stella-app-acceptance` (bn118), `stella-app-prod`. Each has an `upstream` repo; per-owner forks are `u-<24 hex sha256("stella-app-fork-v1\0"+ownerId)>`.
- Publish: `bun run app-source:publish -- --namespace <ns>` (scripts/publish-app-source.mjs, needs wrangler login). Excludes .agents, .github, infra, workers, packages/{backend,executor-cloud,mobile,mobile-screenshots,runtime-rust,website}; regenerates bun.lock with `bun install --lockfile-only` because every packages/* and workers/* dir is a workspace and a frozen install fails otherwise.
- `appSource.access` (cloud-builder owner domain app-source): forks on first use (~7–10 s), revokes the 24 h creation token, returns 1 h write token for the fork + 1 h read token for upstream. Account-only.
- Git auth: `git -c http.extraHeader="Authorization: Bearer <token>"`; push is protocol v1 only.

**How to apply:** client side lands with v3 step 4 (design agreed 2026-10-01, plan doc step 4): agent edits in a git worktree draft and verifies in a headless preview renderer window inside the running app (own partition, serves the worktree; no second Electron); user clicks Update to apply/undo (never auto-apply); the app only fast-forwards — any divergence (moved base, other device, upstream) is merged by an agent, never git auto three-way; applying pushes main to the fork, devices fetch on launch/idle and offer Update. No file tracking, no auto commit trailers, no dev server.

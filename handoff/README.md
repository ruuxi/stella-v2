# Handoff: Stella v3 + all-Cloudflare program (2026-10-02)

Read this whole file before doing anything. It replaces the conversation the previous Claude had with the user. The full program plan is [`stella-v3-and-cloudflare-plan.md`](stella-v3-and-cloudflare-plan.md) in this folder. Its canonical copy lived in `~/Documents` on the old machine, so copy it there and keep both in sync. The previous Claude's memory files are in [`memory/`](memory/); read `memory/MEMORY.md` first, then the ones relevant to your task.

Delete this `handoff/` folder in the commit that finishes the work it describes. The user asked for that last time.

## How the user wants you to work (standing directives)

- **Decide, don't ask.** Don't hand the user decision menus or "blockers"; make the call and work around environment problems. **Keep going until done**, without stopping between steps to report.
- **Testing:** no new tests. Prove changes live in the real product with evidence (logs, screenshots, DB rows, worker tails). Delete tests that encode removed behavior.
- **Keep it minimal.** The bitter lesson: the agent decides, a skill teaches it, and git is the only bookkeeping. No compat code or migrations: there are no users.
- **Git:**
  - Fetch origin before work and before any deploy; push after. Other sessions push master and deploy dev too.
  - Commit messages are plain sentences ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No model identifiers anywhere else.
- **Secrets:** never commit them, never print them; pipe them where they need to go.
- **Production and dev:** don't touch production; deploy dev only.
- **Test accounts:**
  - Test emails end in `@test.stella.local`.
  - Never create per-user Durable Objects from Convex pushes or server-originated requests.
- **Durable Objects:** don't invent DO migrations; pull instead.
- **Docs:** design docs go to `~/Documents`, not the repo.
- **Parallel work:** use Claude subagents, each in its own git worktree (`isolation: worktree`), with self-contained briefs and the cross-lane interfaces agreed before launch. Don't use Codex unless asked. You stay the integrator: review each diff, merge, then deploy and verify live yourself, one at a time.

## Setup on a new machine

1. `git clone` and `bun install --frozen-lockfile`. Read the root `CLAUDE.md`, which covers env vars, the dev Convex deployment and test accounts.
2. Logins needed (the user does these interactively):
   - **Wrangler (Cloudflare):** `bunx wrangler login`, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
   - **Convex:** a `CONVEX_DEPLOY_KEY` for dev, or a logged-in Convex CLI. `packages/backend/.env.local` holds the dev values listed in CLAUDE.md.
   - **Stripe CLI:** only needed for billing work. The old machine had it at `~/.local/bin/stripe`. It is live-mode only on the shared "FromYou, LLC" account; see `memory/stripe-shared-live-account.md`.
3. Electron verification on Linux needs an X display. Launch with:
   `node .agents/skills/verify-stella/control-stella.mjs session launch --account pro`
   - Add `STELLA_VERIFY_INSPECT_MAIN=9339` to open main's inspector.
   - Then run `bun handoff/scripts/main-eval.ts 9339 '<expr using ctx>'` to evaluate inside Electron main. `ctx` is the bootstrap context, e.g. `ctx.state.rendererSource.applyChanges([...])` or `ctx.state.stellaHostRunner.requestRuntimeRestart()`.
   - Run logs land in `.agents/skills/verify-stella/.run/<runId>/data/logs/…/runtime.log`, and the run's SQLite is in `.run/<runId>/data/stella.sqlite`.
4. Deploys (dev only):
   - **Cloud-builder:** `cd workers/cloud-builder && bun run deploy:dev`.
   - **Convex functions:** `cd packages/backend && bunx convex dev --once`. **Not** `bun run deploy`, which targets production.
   - **Prompts:** edit `packages/runtime/extensions/stella-runtime/agent-metadata/*.md`, then run `bun run prompts:sync-defaults`. Deploying Convex alone does **not** republish prompts once a complete publication exists. Publish them explicitly:
     ```
     cd packages/backend
     bunx convex run stella_prompts:publish "$(bun ../../handoff/scripts/prompt-publish-args.ts)"
     ```
     Check with `curl -s https://outgoing-bulldog-865.convex.site/api/stella/prompts`; the revision must match `prompts:check-defaults`.
   - **App source:** `bun run app-source:publish -- --namespace stella-app-dev` publishes the app to Artifacts.

## Where the program stands

Order: Cloudflare 1–2 → v3 1–2 → Cloudflare 3–4 → v3 3–4 → then the tracks alternate. Status by item:

- **Done:** Cloudflare 1–4 and v3 1–3. See the Status section of the plan.
- **Stripe:** a live webhook to the dev worker now exists (`we_1ULz5EGxJob0lqtdxqfXfKaw`, 11 events) and its secret is dev's `STRIPE_WEBHOOK_SECRET`. A resent event got a 200.
- **v3 step 4 (drafts, preview, apply, sync):** built, merged and pushed. Commits:
  - `d5769ec8e`, `b55781194`: renderer hot updates inside our `stella-app://` protocol handler (React Fast Refresh, CSS, route tree), a repo-relative compile cache, file watchers removed, and the `requestRuntimeRestart` host call.
  - `736b2d7bf`: the harness main-eval hook.
  - `d41b11a20`: drafts as git worktrees at `<stellaDataDir>/drafts/<name>` on `draft/<name>`. Also the Update/Undo top-bar popover, `stella-preview://<name>` preview tabs, fork sync through `appSource.access`, the `modify-stella` skill, and `STELLA_APP_DIR`/`STELLA_DRAFTS_DIR` in agent shells.
  - Verified live: a component edit applied hot with composer state kept; a never-used Tailwind class applied hot; a runtime path → `none`; `main.tsx` → reload; `requestRuntimeRestart` replaced the runtime process.
  - **Not yet verified live:**
    - the full flow: ask Stella to change the UI → agent drafts → previews → finishes → the user clicks Update → hot swap → Undo;
    - a runtime-only change and a main/preload change, which should relaunch;
    - fork sync. It needs a checkout cloned from a fork, because the dev repo's history is unrelated and is skipped. Steps: publish upstream, create a fresh test account, clone its fork twice as "two computers", and run the app from a clone with `.agents/skills/verify-stella` copied in.
  - **Not built:** rebuilding the per-user browser renderer when the fork is pushed.
- **Side task, Recall → code access to history (`e183d8cd7`, `da8fc08c8`):** merged, pushed, deployed to dev (cloud-builder version `74f00615`), and prompts published (revision `24be43e1…`).
  - The Recall tool and its machinery are deleted, about −8,300 lines.
  - **Cloud orchestrator:** `history.sql(query, params)` and `history.read(fromSeq, toSeq)` inside `code`. They query the session DO's `journal` / `journal_fts` read-only (`workers/cloud-builder/src/history-sql.ts`), and the cloud prompt overlay names them. **Not yet verified live in a cloud chat.**
  - **Desktop orchestrator:** a `## History Database` section in its context plus a prompt line pointing at `<stellaDataDir>/stella.sqlite` (`entry`, `entry_fts`, `conversation`, `thread`, opened with `node:sqlite` read-only). Live check: the orchestrator did open the DB read-only from `code` and query it.

## Open problem you should pick up first: desktop history lives in the cloud

**The finding.** For signed-in desktop accounts the local `entry` table is **empty**. The conversation is owned by the cloud session DO (local turns are written there through `local-turns/begin|finish`). Locally there is only `cloud_conversation_cache_records`, which is a bounded cache: 3,000 records and 8 conversations (`packages/contracts/cloud-conversation-cache.ts`). So the desktop prompt line points the model at the wrong place, and its query returned `[]`.

**The fix in progress** (decided; nothing written yet):

- **One API for both orchestrators.**
  - Give the desktop `code` runtime the same `history.sql()` / `history.read()` the cloud has.
  - Put a single history line in the shared `orchestrator.md`, naming `journal` (seq, turn_id, kind, role, created_at ms, hidden, payload_json, spill_key) and FTS5 `journal_fts` (text, turn_id, role, created_at, rowid = seq).
  - Delete the cloud overlay's copy of that line, the desktop `## History Database` context section (`packages/runtime/kernel/runner/context.ts`), and the `entry`-table wording.
- **Cloud-builder.** Add `POST /conversations/:id/history/query` with body `{op:"sql", query, params}` or `{op:"read", fromSeq, toSeq}`.
  - **Route:** in `src/build-session/worker-router.ts`, next to the `GET /conversations/:id/history` route. Use the same pattern: `authenticateConversationCaller` → `boundedIngressRequest(request, publicJsonBodyLimit(...))` → `forwardToConversation(..., "/history/query", auth.caller)`.
  - **Body limit:** add the path to `publicJsonBodyLimit` in `src/request-ingress.ts` as `tinyControl`.
  - **Session object:** in `src/orchestrator-session-object.ts`, handle `/history/query` before the POST edit-lock section, since it is read-only:
    - `op:"sql"`: run `runHistoryQuery(this.ctx.storage, query, params)`, with params filtered to string/number/null;
    - `op:"read"`: run `this.archive.readRange(max(0, fromSeq), toSeq, BACKFILL_BATCH_RECORDS)`;
    - errors return 400 with the message.
- **Desktop runtime (`packages/runtime/kernel/computer-use/`).**
  - Ride the existing tool-call path rather than adding a protocol message:
    - in `kernel-worker.ts`, define a frozen `history` global whose `sql` and `read` call `callTool("$history", {op, …})`;
    - in `kernel.ts`, intercept `$history` next to the `$search` / `$describe` intrinsics (around line 1650) and call a new `queryHistory?(args, context)` option.
  - `kernel/tools/host.ts` (where `searchTools` is wired) implements it:
    - POST to `<backend>/conversations/<context.conversationId>/history/query` with the runtime's auth token. Look at how `kernel/runner/cloud-transcript-write.ts` builds its URL and token.
    - Throw "history is unavailable" when signed out.
  - Mention `history` in the `code` tool description (`kernel/tools/defs/code-def.ts`), which lists the globals.
- **After building:**
  1. Typecheck.
  2. Deploy cloud-builder dev and republish the prompts (see above).
  3. Verify live on desktop and in a cloud chat by asking for something only the journal knows, e.g. "query your history for my message containing X and give its seq and created_at", and confirm from the turn records that `history.sql` was called.

**Known environment issue:** the dev default model (`stella/default` → `meta/muse-spark-1.3-contributor` via OpenRouter) often takes 25–30+ s per call, and the desktop aborts at 30 s ("Request was aborted.", turn canceled). This predates the changes above. When verifying, retry, or check the gateway with `bunx wrangler tail stella-v2-model-gateway-dev --format json`; `gateway_relay_timing` shows `upstreamBodyComplete`. It may be worth raising with the user as its own fix.

## After that, the queue

1. Finish the v3 step 4 live verification (above), then mark it done in the plan's Status section.
2. **Cloudflare phase 5.** It was queued until the Recall work landed, which it has. It includes removing the `cloud_dispatches` projection from Convex; purge and the account-link migration still read it. See the plan's Track A phases.
3. Then alternate tracks: v3 step 5 (updates through the same draft pipeline) and the remaining Cloudflare phases 6–10.

Small leftovers noticed:
- `SelfModApplied` types still exist in desktop-ui (`features/chat/self-mod-types`, `conversation-row-types.ts`).
- `stella:morph-reload` is still in `packages/desktop-ui/public/stella-boot.js`.
- "recall" tool labels remain in desktop-ui `status-utils.ts` and mobile `tool-activity.ts` / `working-indicator-status.ts`.
- The paused Rust port's prompt copy still mentions Recall.

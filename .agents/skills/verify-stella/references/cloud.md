# Cloud verification reference

The Electron verifier is only needed for what the desktop itself does: the
execution-target picker, device presence, and the dispatch hand-off. Every
cloud-side cell (cloud orchestrator tools, cloud background agents, follow-ups,
teardown) is faster to drive headless:

- `node .agents/skills/verify-stella/cloud-turn.mjs --prompt "<orchestrator prompt>"`
  mints a Pro test owner through the admin API, posts one turn to the dev
  worker's `POST /conversations/:id/turns` with the owner's JWT, and polls
  `GET /conversations/:id/history` until the turn's final assistant message
  lands. Pass `--conversation <id>` (and the `--email` the first run printed)
  to keep sending into one conversation (follow-ups, `agent_status`,
  `pause_agent` all need that). `STELLA_ADMIN_API_SECRET` comes from the
  environment or the gitignored `workers/cloud-builder/.dev.vars`; the script
  never prints it.
- Objective placement evidence is the owner's agent threads (the
  `agentThreads.recent`, `agentThreads.forConversation`, and
  `agentThreads.running` backend calls the desktop renders, see
  `packages/desktop-ui/src/features/cloud/use-cloud-activity.ts`) and the
  worker tail: `bunx wrangler tail --format json` in
  `workers/cloud-builder` (`sandbox_ready` means a container attached; its
  absence on a completed turn means the work stayed in the Durable Object).
  The tail samples under load and dies with the shell that started it, so
  scope it to the tested owner, conversation and turn.
- Reproduce executor bugs before deploying. The worker tests already run the
  real BuildSession and real Sandbox containers in workerd
  (`workers/cloud-builder/tests/*-workerd.test.ts`, for example
  `general-agent-resident-workerd.test.ts`,
  `sandbox-lifecycle-workerd.test.ts`, and
  `guarded-model-fetch-workerd.test.ts`), and the built sandbox image can run
  the attached tool host locally (`docker run --rm --entrypoint sh
  stella-v2-cloud-builder-dev-sandboxsmall:<version>`), where stderr is on the
  terminal instead of in a diagnostic event three minutes later.
- A worker-only `bun run deploy:dev` takes about two minutes; one that
  rebuilds the image takes six. Never deploy while a cloud thread is
  `running`: the deploy replaces the resident loop's isolate and the turn is
  failed by the heartbeat about a minute later. Dev container rollouts keep
  serving the previous image for a few minutes after a deploy, so give an
  image deploy time before judging a container-side change.
- A thread stuck `running` past its watchdog is expired, not cancelled:
  `POST $CLOUD_BUILDER_URL/sessions/<threadId>/expire` with the service bearer
  and an optional `{"turnId","attemptGeneration"}` body. The BuildSession
  moves its watchdog to now, interrupts a hung fiber, releases the owner's
  world slot and re-arms its alarm; the ordinary timeout path then fails the
  thread while the container's teardown stays alarm-owned debt. The cancel
  route still answers 502 `sandbox_termination_failed` for such a thread.
- Leaked containers (the inventory report's `orphan` rows) are retired
  through the Worker, never Wrangler: from `workers/cloud-builder`, `node
  scripts/retire-sandbox-instances.mjs --environment dev --instance-id <id>
  --apply --confirm <printed> --adapter scripts/retire-sandbox-adapter.mjs`
  with `CLOUD_BUILDER_URL` and
  `BUILDER_SERVICE_SECRET` in the environment. The adapter posts each exact
  tuple to `POST /internal/sandboxes/retire`, which releases keep-alive on
  the sandbox object and destroys it.


These operational notes describe a development environment, not authorization to deploy or retire resources. Check current source and deployment state before relying on recovery details. Scope event evidence to the tested owner, conversation, turn, and attempt; global latest-row queries alone do not establish what this run did.

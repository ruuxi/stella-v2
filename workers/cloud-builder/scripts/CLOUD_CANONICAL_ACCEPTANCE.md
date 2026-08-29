# Cloud-canonical verification harness

These scripts replace the historical `flexible-panther-999` proof. They refuse
that deployment, the shared development deployment, and production, and they
accept only the dedicated preview Convex target:

- `preview:basic-nightingale-118`
- `https://basic-nightingale-118.convex.cloud`
- `https://basic-nightingale-118.convex.site`
- `https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev`
- Wrangler environment `bn118`
- R2 buckets `stella-v2-app-builds-basic-nightingale-118`,
  `stella-v2-agent-home-basic-nightingale-118`, and
  `stella-v2-conversation-archive-basic-nightingale-118`

None of these scripts deploy infrastructure. They are opt-in and require a
fresh disposable identity and isolated local paths. Never point them at
`~/.stella` or a shared Electron profile.

> **Before running:** the dedicated acceptance Worker bindings must be pinned
> to `basic-nightingale-118`, but
> the deployed worker and the matching Convex `CLOUD_BUILDER_URL`/service
> secret still must be paired explicitly. The harness rejects obsolete and
> production targets, but it does not change or deploy infrastructure.

## 1. Fast protocol smoke

`cloud-canonical-protocol-smoke.mjs` exercises the real authenticated Convex,
worker, Durable Object, and projection protocols. It verifies:

- owner registration;
- exact gapless journal sequences and turn shapes;
- begin and finish receipt replay without duplicate rows;
- canonical history through a separately constructed stateless API client;
- DO-to-Convex projection catch-up;
- rejection of a stale `(epoch, lastSeq)` projection;
- a canceled terminal receipt and replay;
- optional hot SQLite plus cold R2 reads after forced rollover;
- conversation, DO, and archive cleanup in `finally`.

It writes synthetic assistant records, so it is not product acceptance and must
never be cited as proof of Electron streaming, runtime placement, a clean
profile, or a real model response.

Required environment:

```text
CONVEX_DEPLOYMENT=preview:basic-nightingale-118
CONVEX_URL=https://basic-nightingale-118.convex.cloud
CONVEX_SITE_URL=https://basic-nightingale-118.convex.site
CLOUD_BUILDER_URL=https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev
STELLA_CLOUD_PROOF_CONFIRM=mutate-preview:basic-nightingale-118
STELLA_CLOUD_PROOF_IDENTITY_KIND=disposable
STELLA_CLOUD_PROOF_JWT=<short-lived disposable JWT>
BUILDER_SERVICE_SECRET=<matching dedicated preview secret>
STELLA_CLOUD_PROOF_EVIDENCE_PATH=/absolute/isolated/path/protocol.json
```

Create the evidence parent directory first. It is resolved through symlinks,
must remain outside live `~/.stella`, and the final file must not already exist.

Run the short proof:

```bash
node workers/cloud-builder/scripts/cloud-canonical-protocol-smoke.mjs
```

Add `--with-r2` for a deliberately heavier run. It appends large synthetic
turns until the DO moves its resident floor, reads records below that floor
through the archive path, and records the owner-hashed R2 prefix. The service
secret and JWT are never written to evidence.

## 2. Real product acceptance

`cloud-canonical-acceptance.mjs` runs a manifest of external commands. It does
not know how to fabricate a success: every command must drive the real product
surface and write a versioned JSON evidence file. Exit code alone is
insufficient. The complete run now includes deployment/source identity, the
real local-runtime lifecycle, two consecutive DO turns, duplicate delivery,
memory/Dream/skills, a signed-in mobile authority/outbox/clean-hydration path,
real external MCP-backed code mode, a real general-agent sandbox, memory-only
wipe plus explicit reimport, full owner-generation reset with local-memory
preservation, and the production Apps Host bundle running inside local Workerd
with real local KV/R2 bindings. Reconnect is a separate scenario and cannot
stand in for the required second turn.

Use the reviewed real-product driver with a generated disposable layout. It
uses its own state, raw-receipt, and Electron user-data directories. The
Electron bootstrap derives a unique application name from the canonical
isolated `user-data` path before `safeStorage` initializes, and the acceptance
evidence binds that exact derived-name hash back to the profile. Do not reuse
the primary app or primary `~/.stella`.

Create a fresh empty directory, then generate the complete reviewed manifest:

```bash
node workers/cloud-builder/scripts/cloud-canonical-real-product-manifest.mjs \
  --root /absolute/path/to/fresh-disposable-harness
```

The generator creates only `evidence/`, `raw/`, `state/`, `profile/`, and the
manifest. It binds every step to the reviewed in-tree
`cloud-canonical-real-product-driver.mjs`; it does not launch Stella or contact
the cloud.

Inspect the required scenario list:

```bash
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs --list
```

Validate a manifest without running commands:

```bash
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs \
  --check /absolute/isolated/path/manifest.json
```

Prepare the three isolated primary-A profiles and one isolated connected-B
profile before the first run. This drives the visible product onboarding flow,
leaves both fresh owners with no conversation, opens the real settings
AuthDialog, and requests one magic link per profile. It creates no step
evidence or raw-log artifact. The two normalized addresses must be distinct,
must belong to fresh disposable nonanonymous accounts, and must identify
accounts that this run is authorized to delete:

```bash
STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL=stella-acceptance+unique@example.test \
STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL=stella-acceptance-secondary+unique@example.test \
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs \
  --prepare-auth /absolute/isolated/path/manifest.json
```

Open all four delivered links through the two authorized inbox actors—three
for A and one for B—then run. The product consumes and clears its own
pending-link state; the driver never reads or serializes a cookie or JWT. Run
only after the manifest is valid and the initial inbox handoff is complete:

```bash
STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-preview:basic-nightingale-118 \
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs \
  --run /absolute/isolated/path/manifest.json
```

The browser-storage scenario deliberately pauses a second time after deleting
cookies, local/session storage, IndexedDB, Cache Storage, and the rendered
outbox. The runner exits 75 without cleanup or aggregate evidence and prints
that `browser_cloud_routing` is awaiting human action. Open that new magic link,
then rerun the identical `--run` command. The runner validates the already
completed evidence prefix, resumes the same run id and live isolated browser
target, and requires the exact original account and canonical projection.
Losing that target makes this proof fail closed; it does not inject a cookie or
substitute another profile.

The executable fails closed unless all live prerequisites are present. Set the
following only for the disposable acceptance account and reviewed preview
deployment; never put their values in the manifest or retained logs:

```text
STELLA_CLOUD_PROOF_IDENTITY_KIND=disposable
BUILDER_SERVICE_SECRET=<secret paired with the dedicated preview Worker>
STELLA_CLOUD_ACCEPTANCE_DISPOSABLE_EMAIL=<normalized fresh disposable inbox address>
STELLA_CLOUD_ACCEPTANCE_SECONDARY_DISPOSABLE_EMAIL=<different normalized fresh disposable inbox address>
STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY=<optional exact reviewed Chrome-for-Testing binary>
CLOUDFLARE_ACCOUNT_ID=<account containing the dedicated preview Worker and R2 buckets>
CLOUDFLARE_API_TOKEN=<narrow preview-Worker inspection token>
CONVEX_DEPLOY_KEY=<basic-nightingale-118 preview deployment key>
STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_NAME=<exact reviewed read-only listed tool>
STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_ARGUMENTS_JSON=<bounded JSON object with reviewed non-mutating arguments>
STELLA_CLOUD_ACCEPTANCE_MCP_INTEGRATION_ID=<exact reviewed integration id>
STELLA_CLOUD_ACCEPTANCE_MCP_TOOL_REVISION=<exact v2 content revision>
STELLA_CLOUD_ACCEPTANCE_MCP_POLICY_VERSION=<exact admin-reviewed read policy>
STELLA_CLOUD_ACCEPTANCE_MCP_TOOLKIT_VERSION=<exact published toolkit version>
STELLA_CLOUD_ACCEPTANCE_MCP_CONNECTED_ACCOUNT_ID_SHA256=<SHA-256 of the disposable external account id>
STELLA_CLOUD_ACCEPTANCE_MCP_ACCOUNT_PURPOSE=disposable-audited-read-only
STELLA_CLOUD_ACCEPTANCE_BUN_1_4_BINARY=<absolute official Bun 1.4.x binary>
STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-preview:basic-nightingale-118
```

`STELLA_CLOUD_PROOF_JWT`, `STELLA_CLOUD_PROOF_SESSION_COOKIE`, and all
secondary JWT/cookie variables must be absent. Both connected authorities are
refreshed in memory from their isolated nonanonymous product profiles before
every post-auth step and again immediately before the long mounted-mobile
phases. Every freshly minted token must retain more than 20 minutes of
issuer-and-subject-validated runway. Connected B is created through the same
real magic-link product flow as A and remains encrypted in its own
profile-specific safeStorage namespace. A separate short-lived anonymous
product profile exists only for the mobile HTTP 403 policy checks; it is never
used as the cross-owner identity and is revoked with zero owner residue. Every
private-state write rejects raw JWT-, cookie-, credential-, and session-shaped
values as well as the known secret and inbox values. No authority credential is
written to state, logs, step evidence, or the aggregate report.

Before the run, deploy the clean reviewed tree to the paired dedicated preview
Worker using the checked-in Wrangler `bn118` environment and to the Convex
preview deployment through the normal deployment workflow. The
Worker must have `ENABLE_DEV_ACCEPTANCE_PROBES=1`,
`STELLA_DEPLOYMENT_IDENTITY=preview:basic-nightingale-118`, the matching service
secret, model/provider configuration, and the preview DO/R2/Convex
bindings. Production must omit or deny these probes. The disposable account
must have one real reviewed Composio read-only tool matching the exact name and
arguments above, and the reachable-mobile scenario needs the isolated desktop
process to remain paired and reachable. The driver verifies the active Worker
version, remote Convex function manifest, and the deployed
`/api/stella/prompts` publication against every digest in the reviewed
canonical 10-prompt source roster under
`packages/runtime/extensions/stella-runtime/`. For agent metadata it removes
exactly the leading frontmatter fence plus its single required blank separator
line and compares every remaining body byte without trimming or normalization.
It also verifies R2 objects, owner
generation, and conversation/turn identities before accepting evidence.

The Convex preview deployment must also have four explicit raw-media
authority variables: `R2_PETS_BUCKET`, `R2_PETS_PUBLIC_BASE_URL`,
`R2_EMOJI_BUCKET`, and `R2_EMOJI_PUBLIC_BASE_URL`. The two buckets must be
distinct, explicitly non-production buckets; the two public bases must be
distinct HTTPS non-production origins that are verified against those exact
buckets before they are installed. The legacy shared `R2_PUBLIC_BASE_URL` is
not an accepted fallback for pet or emoji writes. Never reuse `stella-files`,
`stella-emotes`, or either bucket's public origin for this preview proof.

Generating or checking the manifest, running unit/Workerd tests, or compiling
the driver does not produce acceptance evidence. No infrastructure deployment
is performed by this harness.

### Manifest shape

Commands are argv arrays and run with `shell: false`. Secrets remain in the
process environment; never put them in the manifest or command arguments.
Every evidence path and the aggregate output must be fresh, distinct, and
absolute, and must remain under a declared disposable root; reviewed driver and
working-directory paths do not make the integration worktree an artifact root.
At least one narrow disposable harness root is required; filesystem root, the
user's home, the integration worktree, and any path containing or contained by
live `~/.stella` are rejected. Create the disposable roots plus `evidence/` and
`raw/` parent directories before `--check`; the runner resolves them through
symlinks before accepting the manifest.

```json
{
  "version": 3,
  "stepCount": 26,
  "target": {
    "convexDeployment": "preview:basic-nightingale-118",
    "convexUrl": "https://basic-nightingale-118.convex.cloud",
    "convexSiteUrl": "https://basic-nightingale-118.convex.site",
    "cloudBuilderUrl": "https://stella-v2-cloud-builder-basic-nightingale-118.lolruuxi.workers.dev"
  },
  "isolatedRoots": ["/absolute/path/to/disposable-harness-runtime"],
  "output": "/absolute/path/to/disposable-harness-runtime/evidence/report.json",
  "steps": [
    {
      "id": "browser_cloud_routing",
      "humanAction": "external-inbox-storage-recovery-login",
      "driverContract": "stella-cloud-real-product-driver-v3",
      "driverFile": "/absolute/integration/worktree/workers/cloud-builder/scripts/cloud-canonical-real-product-driver.mjs",
      "command": [
        "node",
        "/absolute/integration/worktree/workers/cloud-builder/scripts/cloud-canonical-real-product-driver.mjs",
        "browser_cloud_routing"
      ],
      "cwd": "/absolute/path/to/disposable-harness-runtime",
      "evidenceFile": "/absolute/path/to/disposable-harness-runtime/evidence/browser_cloud_routing.json",
      "timeoutMs": 1800000
    }
  ]
}
```

The manifest must contain every ID printed by `--list`; the abbreviated example
above is intentionally not runnable. `humanAction` is exactly
`external-inbox-primary-login` for the first step,
`external-inbox-storage-recovery-login` for browser storage recovery, and
`none` for automatic steps; the runner rejects any other declaration. Each
`driverFile` must be an existing,
reviewed file inside the integration worktree, must declare
`stella-cloud-real-product-driver-v3`, and `command[1]` must name it. A driver in
the disposable runtime is not accepted merely because that directory is safe
to delete. The runner records the reviewed file's SHA-256 digest and rechecks it
immediately before execution; arbitrary shell commands, changed driver bytes,
and shell-string manifests are rejected. Before every non-cleanup product step,
the driver also re-runs the clean Git source-tree attestation and requires the
exact commit, tree, and source identities recorded by `deployment_identity`, so
an imported helper or product module cannot change between steps without
failing closed. Cleanup deliberately remains available after a partial failure.

Each command receives:

- `STELLA_CLOUD_ACCEPTANCE_RUN_ID`
- `STELLA_CLOUD_ACCEPTANCE_STEP`
- `STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE`
- `STELLA_CLOUD_ACCEPTANCE_RAW_LOG_FILE`
- `STELLA_CLOUD_ACCEPTANCE_DRIVER_CONTRACT`
- the exact Convex and cloud-builder environment selected by the manifest

It must write:

```json
{
  "version": 2,
  "driverContract": "stella-cloud-real-product-driver-v3",
  "step": "electron_real_stream",
  "runId": "<injected run id>",
  "passed": true,
  "productPath": true,
  "syntheticAssistantRecords": false,
  "mocked": false,
  "realNetwork": true,
  "startedAt": "<ISO timestamp>",
  "finishedAt": "<ISO timestamp>",
  "identity": {
    "deploymentFingerprintSha256": "<64 lowercase hex>",
    "sourceTreeSha256": "<64 lowercase hex>",
    "ownerIdSha256": "<64 lowercase hex; never the raw owner id>",
    "ownerGeneration": "<exact generation observed by the product>"
  },
  "observations": {},
  "artifacts": {
    "rawLog": {
      "path": "/absolute/path/to/disposable-harness-runtime/raw/electron_real_stream.jsonl",
      "sha256": "<64 lowercase hex>",
      "bytes": 123,
      "entries": 2
    }
  }
}
```

Every step, including cleanup, must repeat the same identity envelope. The
runner rejects evidence from another reviewed source tree, deployed
Worker/Convex fingerprint, disposable owner, or owner generation. The raw
owner id is not retained.

### Reviewed driver seam

Real drivers should import
`cloud-canonical-acceptance-driver-contract.mjs`, call
`loadAcceptanceDriverContext("<step-id>")`, drive the real product, and finally
call `writeAcceptanceDriverEvidence(...)`. The helper validates the exact
runner-injected target/run/step/evidence path and writes exclusively. It has no
product driver, observations, or passing defaults of its own: the reviewed
driver must explicitly attest to `productPath: true`, `realNetwork: true`,
`mocked: false`, and `syntheticAssistantRecords: false`. Importing or invoking
the helper alone cannot create a passing acceptance report.

Each driver supplies `rawLog` receipt entries to the helper. The helper injects
the exact run and step identity, writes the runner-selected
`<disposable-root>/raw/<step>.jsonl` file exclusively, and accepts only:

- canonical `at`, allowlisted `surface`, slug-like `operation`, and literal
  `mocked: false` / `synthetic: false`;
- optional integer `status`, `durationMs`, `count`, `bytes`, or `seq`;
- optional bounded `outcome`;
- optional SHA-256-only `requestIdSha256`, `resourceIdSha256`,
  `responseSha256`, `stateSha256`, `processOutputSha256`, or
  `objectKeySha256`.

Prompts, response bodies, headers, credentials, cookies, raw upstream ids, and
all unrecognized fields are rejected. Every receipt timestamp must fall inside
that step's evidence interval, and the runner independently revalidates the
schema, step/run binding, and required product surfaces.

### Required observations

| Step                                | Required `observations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primary_auth_handoff`              | four separately persisted isolated profiles complete visible onboarding and real magic-link login: three distinct sessions converge on fresh connected owner A, while the fourth establishes distinct fresh connected owner B. Both owners have zero conversations/reset/account residue and exactly one separately attested product-created disabled revision-one memory preference; all four sessions are distinct, and all profiles prove zero cookie-setup calls, cleared callback state, and no returned credentials. Nested deployment identity is pre-chat pending only until the next step creates A's first conversation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `deployment_identity`               | clean `repoCommitSha/repoTreeSha`, `sourceTreeSha256`, exact dev URLs/name, real `workerVersionId`, `workerScriptSha256`, `workerDeployedAt`, `workerProbeRequestId`, `convexFunctionManifestSha256`, `convexObservedAt`, `convexProbeRequestId`; hashed JWT issuer/raw Better Auth subject/issuer-qualified token identifier, with the issuer pinned to the Convex site and the token-identifier hash equal to the owner envelope; exact schema-2 canonical prompt revision/publication time/manifest hash/id-set hash/count 10 and observation time with every deployed prompt body/digest matching the exact reviewed runtime source bytes after agent-only frontmatter removal; `workerSourceMatches`, `convexFunctionsMatch`, `canonicalPromptMatchesReviewedSource`                                                                                                                                                                                                                                                                                                                                                               |
| `local_runtime_lifecycle`           | isolated `profileDir`, `localConversationId`, distinct initial/continuation/child turn ids, distinct SHA-256-only completed/interrupted provider request ids, physical attempt/stream ordinals, exact `request-admitted` → `request-dispatched` → `stream-open` → `transport-closed` → `transport-joined` phases, completed/canceled outcomes, no raw request ids, interruption stopped only after join, real stream/tool/child completion, continuation, persistence, distinct process ids, equal history hashes across restart, `cloudSandboxStarted: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `electron_real_stream`              | `conversationId`, `durableObjectIdSha256`, `journalEpoch`, `turnId`, `liveEventCount >= 2`, `journalHeadSeq`, `finalTextSha256`, isolated `profileDir`, `doObserved: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `consecutive_durable_turns`         | same `conversationId`/DO hash/epoch, distinct `firstTurnId/secondTurnId`, record counts, advancing `journalHeadSeqBeforeSecond` → prompt → terminal → `journalHeadSeqAfterSecond`, `secondTurnObservedFirst`, response/history hashes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `duplicate_delivery_idempotency`    | exact conversation/DO hash/epoch/second turn, hashed client message and delivery fingerprint, equal first/replay receipt hashes, unchanged journal head and row count, one prompt, one completed terminal, `receiptReplayed`, `duplicateAppendPrevented`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `electron_restart_reconnect`        | same conversation/DO hash/epoch and equal history/head across restart, plus exact rendered receipts for cold-process hydration and hash-only cross-process connected-A→connected-B→connected-A isolation; B retains its encrypted nonanonymous session and exact projection across its own stop/relaunch while A remains the same mounted process/target, and neither view contains the other account canary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `clean_client_hydration`            | distinct isolated `profileA/profileB`; prepared profile B initially has auth but no conversation state, discovers the conversation through Convex, hydrates from cloud, and matches the canonical history hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cache_loss_recovery`               | isolated `cachePath`, `cacheDeleted`, `hydratedFromCloud`, equal `historySha256Before/After`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `projection_and_r2`                 | conversation/epoch, `doSqliteCanonical`, `journalGapless`, equal `journalHeadSeq/indexSyncedSeq`, `staleProjectionRejected`, positive hot/cold rows and bytes, real object key/etag, equal hot/cold history hashes, `coldHistoryRead`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cancellation`                      | primary conversation and distinct turn, `cancelRequested`, `providerStopped`, `terminalKind: "canceled"`, `terminalRecordCount: 1`, `reconnectIdle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cloud_failure_no_local_fallback`   | primary conversation and two distinct failure turns; cold prompt miss emits explicit terminal `failed` with `CLOUD_CONTEXT_UNAVAILABLE` / `canonical_prompt`, no fallback, and unchanged provider dispatch count; malformed active-window SQLite `payload_json` emits explicit terminal `failed` with `CLOUD_CONTEXT_UNAVAILABLE` / `canonical_history`, no fallback or provider dispatch, preserves the exact corrupt-row hash and `model_skip: false` row/seq across reconnect and Worker restart, then proves byte-identical automatic repair and a subsequent completed provider-backed turn; both scenarios leave local-authoritative row count/hash unchanged and never start local execution                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `desktop_local_routing`             | exact local lifecycle conversation/turn, `subject/workspace: "computer"`, `chosenLocation: "computer"`, `executedBy: "local-runtime"`, no sandbox, fenced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mobile_reachable_computer_routing` | exact conversation/turn and device claim, `subject/workspace: "computer"`, computer placement, paired-computer execution, no sandbox, fenced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mobile_unreachable_cloud_routing`  | exact conversation/turn, unchanged `subject/workspace: "computer"`, cloud placement, real sandbox, no local runtime, fenced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mobile_signed_in_canonical_sync`   | real signed-in production chat hook mounted through React Native Web and driven through a mounted UI; exact issuer-qualified A/B sessions, conversation/turn/dispatch, Bun 1.4, and six reviewed mobile product-module hashes; actual AsyncStorage wrapper completion before real HTTP admission; committed-response loss followed by fresh-process idempotent replay and terminal-before-outbox-removal; same-mounted-client cursor/epoch reconnect with recovered records, actual AppState callbacks, A→B→A local authority isolation, explicit no-local-fallback outage, and clean WebSocket hydration; independent server probes require anonymous mobile policy rejection HTTP 403, privacy-preserving initial cross-owner socket 4404, and same-live-socket auth-refresh identity switch 4403. The evidence explicitly records that a full product screen, Expo native binary, native AsyncStorage backend, native AppState delivery, OS process death, and native layout/touch are not proved.                                                                                                                                   |
| `browser_cloud_routing`             | actual browser DOM list/open/send/stream/terminal/fail-closed/mounted-resume/same-target reload receipts; exact cold-process identity-before-auth hydration; server-derived cloud placement and real sandbox with no local runtime; full storage deletion followed by the explicit second product-login human action in the same target/profile, same-account authority restoration, exact canonical projection recovery, empty pre-reauth outbox, no serialized credentials, and no local fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `child_completion`                  | exact parent conversation/turn and child turn, `completionJournalSeq`, `completionObserved`, `completionDeliveryCount: 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `memory_restart_recall`             | primary conversation and distinct write/recall/later turns; exact second-turn `Remember` receipt plus generation-fenced `memories/profile.md` version/key/etag; separately authenticated `MEMORY.md` write receipt and idempotency hash bound to that turn, exact document/version/revision/content/marker hashes and generation-fenced key/etag; same deployed Worker version before/after restart; recall and later-context hashes with the marker observed after restart and later                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dream_rotation_memory_map`         | primary conversation, run/lease identities, exact input/output memory and memory-map versions, advancing revisions, input/output hashes, monthly archive name plus exact archive document/version/content hash and generation-fenced key/etag, positive rotated-block count, memory-map archive reference, completed run, both documents updated, rotation and conflict retry observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cloud_skill_discovery_use`         | primary conversation, distinct discovery/use turns, skill/version/revision, manifest and asset hashes, exact generation-fenced manifest and normalized asset keys with real etags, catalog revision and use receipt, discovered/loaded/asset-read/used flags, `macFilesystemReadCount: 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `code_mode_real_mcp`                | primary conversation/turn and deployed Worker version, code execution and hashed server/account ids, exact MCP protocol/integration/tool/revision/policy/toolkit, catalog revision and reviewed input-schema hashes, distinct SHA-256-only initialize/every-list-page/describe/call request identities, one identical hash-only tool identity across list/describe/call, hash-only initialization/notification/describe/provider/result receipts, real list page count, completed initialize + initialized notification + standard `tools/list` + describe + call over Composio to the exact disposable audited connected account, catalog and server read-only policy rechecked before call, non-destructive annotations, child outbound blocked, and `inProcessFixture: false`; no raw RPC/account/endpoint/token persisted                                                                                                                                                                                                                                                                                                           |
| `general_agent_real_sandbox`        | exact browser-routed conversation/parent turn and child turn, agent/thread/sandbox/image identities, Cloudflare provider, output hash, completion sequence, real sandbox and command, placement/owner fences, exactly one observed completion, no local runtime, completed terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `owner_reset_memory_reimport`       | signed-in ownership and actual local scanner import; memory-only wipe reaches a new epoch, removes the prior version/R2 object, and blocks implicit reimport; explicit authorization recreates the exact bytes in a distinct version; immediately before the full reset, a live mounted RN hook holds a committed old-generation response and socket behind a private barrier; the completed reset rotates owner generation, removes reset-owned core data and old-generation R2 while preserving the reviewed connected integration exactly, then releases that same process to prove stale socket/callback/outbox rejection, old-generation purge, and new-generation hydration. The integration performs a second audited read-only external call under the new generation, and the actual Electron hard reset preserves the local file/ownership marker for exact explicit reimport.                                                                                                                                                                                                                                                |
| `apps_host_workerd_runtime`         | exact Apps Host worker/deployment/Wrangler identities; non-empty production bundle digest/bytes; hashed KV/R2 route and object receipts; Workerd health, GET/HEAD app asset, same-origin interior manifest/assets, and browser auth-handoff responses; strict CSP/no-store assertions; private proxy target rejected before fetch; invalid authority binding returns 503; runtime disposed and isolated persistence removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cleanup`                           | conversation/R2/memory/skills/sandbox purge across every recorded old/new owner generation, zero reset-owned core or old-generation residue, and Apps Host Workerd state removed. The short-lived anonymous mobile-policy account is revoked and proved to have zero owner residue. Connected-secondary deletion is lifecycle-first and restart-tolerant: exact-generation tombstone and completed purge job, rejected stale session, and zero conversation/reset/account/cloud stores are proved before the primary session is restored. Primary deletion starts only afterward and independently requires its exact-generation tombstone/job, rejected stale session, zero conversation/reset/account/cloud stores, external Composio revocation, and local integration-row removal. Every detached Electron, browser, and Vite process group is ownership-fingerprinted before shutdown, the exact trusted target/profile/port attestation remains bound, the `127.0.0.1:57314` listener is absent afterward, isolated profiles are removed, the live profile retains an equal before/after hash, and `remainingResources` is empty. |

The runner stores only allowlisted observations plus hashes and byte counts of
command output. It does not retain stdout, stderr, credentials, cookies,
transcript text, or raw model output. Cleanup runs after success or a real
failure. It intentionally does not run at either declared external-inbox pause,
because deleting the isolated profile would destroy the only product authority
that can complete or clean the run. Step and aggregate evidence files are
created exclusively and never replace an existing file.

The runner also enforces cross-step coherence. Every step must name the same
reviewed source tree, deployment fingerprint, hashed disposable owner, and
owner generation. The first and second turn must use one conversation, DO hash,
and journal epoch; the second turn must advance the first turn's head; duplicate
delivery must replay that exact DO/epoch/second turn without changing its head; only then
may restart/reconnect prove an unchanged post-second-turn state. Reconnect,
clean-client, and cache-loss histories must equal the two-turn history.
Projection must use the same epoch and cover the second turn, and hot/cold
history digests must match.

The five placement/canonical-mobile scenarios must identify distinct
conversation turns, and the local routing observation must name the exact
local-lifecycle conversation and first turn. The signed-in mobile proof must
remain on the deployment owner generation, reload its durable outbox in a new
Bun 1.4 process, and hydrate one monotonic canonical journal before deleting
the acknowledged outbox. Memory starts from the second cloud turn and must use the exact
deployed Worker version; Dream must advance the recalled memory version. The
general sandbox must be the exact browser-routed turn, and its child identity
and completion sequence must equal the DO child-completion observation. All
profile/cache paths remain below declared disposable roots, and every removed
cache must belong to the exact profile recorded for that scenario.

The owner-reset scenario runs late, after every old-generation scenario has
reached its terminal receipt. It first proves the memory-only wipe and explicit
reimport lifecycle, then performs the full product reset, waits for the purge,
rotates generation, verifies zero old-owner Convex/R2 residue, and proves that
the real Electron hard reset preserved only the contract-retained local memory
for explicit reimport into the new generation. Final cleanup purges and checks
every recorded generation.

For R2 acceptance, `r2ObjectKey`, `r2Etag`, and `r2Bytes` must come from a real
remote bucket inspection. An inferred key is insufficient. For cache-loss
acceptance, record the cache path before removal and prove it belongs to the
disposable profile before deleting it.

Passing the structural and adversarial unit tests proves only that the manifest,
driver boundary, schemas, and coherence checks fail closed. It is not deployment
or real-product evidence. A passing aggregate report exists only after reviewed
drivers execute every scenario against the paired preview Worker and Convex
deployment and cleanup succeeds.

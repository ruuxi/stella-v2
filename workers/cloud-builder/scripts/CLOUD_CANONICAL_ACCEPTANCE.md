# Cloud-canonical verification harness

These scripts replace the historical `flexible-panther-999` proof. They refuse
that deployment and production, and they accept only the current development
Convex target:

- `dev:impartial-crab-34`
- `https://impartial-crab-34.convex.cloud`
- `https://impartial-crab-34.convex.site`
- `https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev`

Neither script deploys infrastructure. Both are opt-in, and both require a
fresh disposable identity and isolated local paths. Never point them at
`~/.stella` or a shared Electron profile.

> **Before running:** the worker bindings in
> `workers/cloud-builder/wrangler.jsonc` are pinned to `impartial-crab-34`, but
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
CONVEX_DEPLOYMENT=dev:impartial-crab-34
CONVEX_URL=https://impartial-crab-34.convex.cloud
CONVEX_SITE_URL=https://impartial-crab-34.convex.site
CLOUD_BUILDER_URL=https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev
STELLA_CLOUD_PROOF_CONFIRM=mutate-dev:impartial-crab-34
STELLA_CLOUD_PROOF_IDENTITY_KIND=disposable
STELLA_CLOUD_PROOF_JWT=<short-lived disposable JWT>
BUILDER_SERVICE_SECRET=<matching development secret>
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
insufficient.

The historical `stella-dev-harness` instructions currently mark the old harness
as stale. Rebuild an isolated Stella v2 harness first, with its own data and
Electron user-data directories, port, binary identity, and control channel.
Do not reuse the primary app or primary `~/.stella`.

Inspect the required scenario list:

```bash
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs --list
```

Validate a manifest without running commands:

```bash
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs \
  --check /absolute/isolated/path/manifest.json
```

Run only after the manifest is valid:

```bash
STELLA_CLOUD_ACCEPTANCE_CONFIRM=run-real-dev:impartial-crab-34 \
node workers/cloud-builder/scripts/cloud-canonical-acceptance.mjs \
  --run /absolute/isolated/path/manifest.json
```

### Manifest shape

Commands are argv arrays and run with `shell: false`. Secrets remain in the
process environment; never put them in the manifest or command arguments.
Every evidence path and the aggregate output must be fresh, distinct, and
absolute. At least one narrow disposable harness root is required; filesystem
root, the user's home, and any path containing or contained by live `~/.stella`
are rejected. Create the disposable roots and evidence/output parent
directories before `--check`; the runner resolves them through symlinks before
accepting the manifest.

```json
{
  "version": 1,
  "target": {
    "convexDeployment": "dev:impartial-crab-34",
    "convexUrl": "https://impartial-crab-34.convex.cloud",
    "convexSiteUrl": "https://impartial-crab-34.convex.site",
    "cloudBuilderUrl": "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev"
  },
  "isolatedRoots": ["/absolute/path/to/disposable-harness-runtime"],
  "output": "/absolute/path/to/disposable-harness-runtime/evidence/report.json",
  "steps": [
    {
      "id": "electron_real_stream",
      "driverFile": "/absolute/path/to/real-driver.mjs",
      "command": ["bun", "/absolute/path/to/real-driver.mjs", "stream"],
      "cwd": "/absolute/path/to/disposable-harness-runtime",
      "evidenceFile": "/absolute/path/to/disposable-harness-runtime/evidence/stream.json",
      "timeoutMs": 300000
    }
  ]
}
```

The manifest must contain every ID printed by `--list`; the abbreviated example
above is intentionally not runnable. Each `driverFile` must be an existing,
reviewable file inside the integration worktree or a declared isolated root,
and `command[1]` must name it. The runner records its SHA-256 digest so the
evidence identifies the driver that actually ran; arbitrary shell commands and
shell-string manifests are rejected.

Each command receives:

- `STELLA_CLOUD_ACCEPTANCE_RUN_ID`
- `STELLA_CLOUD_ACCEPTANCE_STEP`
- `STELLA_CLOUD_ACCEPTANCE_EVIDENCE_FILE`
- the exact Convex and cloud-builder environment selected by the manifest

It must write:

```json
{
  "version": 1,
  "step": "electron_real_stream",
  "runId": "<injected run id>",
  "passed": true,
  "productPath": true,
  "syntheticAssistantRecords": false,
  "mocked": false,
  "realNetwork": true,
  "startedAt": "<ISO timestamp>",
  "finishedAt": "<ISO timestamp>",
  "observations": {}
}
```

### Required observations

| Step                                | Required `observations`                                                                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron_real_stream`              | `conversationId`, `turnId`, `streamEventCount >= 2`, `journalHeadSeq`, `finalTextSha256`, isolated `profileDir`, `doObserved: true`                                                                                                                       |
| `electron_restart_reconnect`        | `conversationId`, `processRestarted`, `socketReconnected`, equal `historySha256Before/After`, `journalHeadSeqBefore/After`                                                                                                                                |
| `clean_client_hydration`            | distinct isolated `profileA/profileB`, `profileBInitiallyHadCache: false`, `discoveredFromConvex`, `hydratedFromCloud`, `historySha256`                                                                                                                   |
| `cache_loss_recovery`               | isolated `cachePath`, `cacheDeleted`, `hydratedFromCloud`, equal `historySha256Before/After`                                                                                                                                                              |
| `projection_and_r2`                 | `conversationId`, `doSqliteCanonical`, `journalGapless`, equal `journalHeadSeq/indexSyncedSeq`, `staleProjectionRejected`, positive `r2HotRows/r2ColdRows/r2Bytes`, real `r2ObjectKey/r2Etag`, `coldHistorySha256`, `hotHistorySha256`, `coldHistoryRead` |
| `cancellation`                      | `conversationId`, `turnId`, `cancelRequested`, `providerStopped`, `terminalKind: "canceled"`, `terminalRecordCount: 1`, `reconnectIdle`                                                                                                                   |
| `cloud_failure_no_local_fallback`   | `conversationId`, `turnId`, `cloudFailureInjected`, `userVisibleFailure`, equal row counts and `localAuthoritySha256Before/After`, `localExecutionStarted: false`                                                                                         |
| `desktop_local_routing`             | `turnId`, `chosenLocation: "computer"`, `executedBy: "local-runtime"`, `cloudSandboxStarted: false`, `fenceVerified`                                                                                                                                      |
| `mobile_reachable_computer_routing` | `turnId`, `deviceClaimId`, `chosenLocation: "computer"`, `executedBy: "paired-computer"`, `cloudSandboxStarted: false`, `fenceVerified`                                                                                                                   |
| `mobile_unreachable_cloud_routing`  | `turnId`, `chosenLocation: "cloud"`, `realSandboxStarted`, `localRuntimeStarted: false`, `fenceVerified`                                                                                                                                                  |
| `browser_cloud_routing`             | `turnId`, `chosenLocation: "cloud"`, `realSandboxStarted`, `localRuntimeStarted: false`, `fenceVerified`                                                                                                                                                  |
| `child_completion`                  | `parentConversationId`, `childTurnId`, `completionJournalSeq`, `completionObserved`, `completionDeliveryCount: 1`                                                                                                                                         |
| `cleanup`                           | `conversationPurged`, `r2ObjectsPurged`, `isolatedProfilesRemoved`, `liveProfileUntouched`, equal `liveProfileSha256Before/After`, empty `remainingResources`                                                                                             |

The runner stores only allowlisted observations plus hashes and byte counts of
command output. It does not retain stdout, stderr, credentials, cookies,
transcript text, or raw model output. The cleanup command always runs, even if
an earlier step fails. Step and aggregate evidence files are created
exclusively and never replace an existing file.

The runner also enforces cross-step coherence: Electron stream, restart,
clean-client hydration, cache-loss recovery, and projection/R2 must name the
same conversation; reconnect, clean-client, and cache-loss history digests must
match; profile A must be the original Electron profile; all profile/cache paths
must sit below a declared disposable root; and the cache removed must belong to
one of the two disposable profiles.

For R2 acceptance, `r2ObjectKey`, `r2Etag`, and `r2Bytes` must come from a real
remote bucket inspection. An inferred key is insufficient. For cache-loss
acceptance, record the cache path before removal and prove it belongs to the
disposable profile before deleting it.

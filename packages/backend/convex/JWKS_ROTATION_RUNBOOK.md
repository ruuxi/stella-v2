# Better Auth JWKS rotation runbook

This runbook moves Stella from the legacy static `JWKS` snapshot to Better
Auth's database-backed JWKS endpoint, then rotates one signing key with an
overlap. It is intentionally value-safe: none of the commands read, copy,
pipe, or print `JWKS`, a public JWK, an encrypted private JWK, or the Better
Auth secret.

## Safety model

- `STELLA_JWKS_MODE` is `static` or `dynamic`. When it is unset, the code keeps
  the legacy behavior: a present `JWKS` value means static mode.
- `STELLA_JWKS_ROTATION_ENABLED=true` is a separate operator arm. A new
  rotation fails closed unless both dynamic mode and this arm are active.
- A rotation inserts the candidate below the current signer, records recovery
  metadata, and then atomically makes the candidate newest. Better Auth 1.6.11
  signs with the greatest `createdAt`, and its dynamic JWKS endpoint publishes
  all retained public keys.
- The previous key is retained for
  `STELLA_JWT_EXPIRATION + STELLA_JWKS_RETIREMENT_SAFETY`. The defaults are 30
  minutes plus 15 minutes. The safety interval covers in-flight issuance,
  clock skew, and verifier refresh latency; increase it if those can exceed 15
  minutes.
- Retirement is a separate command. The component refuses it before the
  recorded `retireAfter`, refuses to delete the current signer, and deletes
  only the key named by the rotation record.
- Reusing one `operationId` makes prepare, activation, rollback, and retirement
  safe to retry after a timeout or lost response. Never substitute a new ID
  for a retry.
- The former destructive Better Auth `rotateKeys` endpoint is no longer called,
  and automatic delete-all recovery is disabled.

## Phase 0: preconditions

1. Use a non-production deployment to rehearse the complete sequence.
2. Confirm the deployed `STELLA_JWT_EXPIRATION` is the actual maximum lifetime
   of every JWT signed by this keyset. If another path issues longer-lived
   tokens, stop and increase the configured lifetime/overlap first.
3. Confirm the Better Auth secret will not change during the operation. The new
   private JWK is encrypted with the same secret Better Auth uses today.
4. Pause auth configuration changes and allow only one operator to control the
   rotation.
5. Do not use shell tracing (`set -x`), the Convex dashboard table viewer, data
   export, or ad hoc queries against the Better Auth `jwks` table during this
   procedure.

## Phase 1: deploy without changing signing behavior

Convex evaluates `auth.config.ts` while deploying. Because the new auth config
references `STELLA_JWKS_MODE`, that variable must exist before this code can be
deployed. Set it on the target deployment before running deployment-backed
codegen, function analysis, or deploy; a local shell value is not sufficient.
The existing `JWKS` value must also be a valid Better Auth static snapshot.
Malformed static configuration fails closed during auth-config evaluation and
prevents Phase 1 from deploying. Restore it only through the approved secret
management path; do not print it or pass it through command-line arguments.

1. Set `STELLA_JWKS_MODE` to `static` with the normal environment-management
   procedure. Do not inspect or modify `JWKS`.
2. Leave `STELLA_JWKS_ROTATION_ENABLED` unset or set it to `false`.
3. Deploy the reviewed commit normally. This phase still signs and verifies
   from the existing static snapshot, so no key changes.
4. From `packages/backend`, run the metadata-only preflight:

   ```sh
   bun run auth:jwks:preflight
   ```

5. Continue only when `ready` is `true`, both key-match fields are `true`, the
   static and database key counts are equal, and `hasOutstandingRotation` is
   `false`. A mismatch means the static and database keysets do not have one
   unambiguous shared signer; stop rather than regenerating, exporting, or
   editing keys.

The preflight function exists only after the Phase 1 code is deployed. It
returns counts, booleans, mode, and reason metadata; it never returns the
static value or either JWK. If deployment stops on the generic invalid-JWKS
error, there is no safe preflight bypass: repair the deployment configuration
through secret management, then repeat Phase 1.

## Phase 2: switch verification and signing to dynamic JWKS

1. Set `STELLA_JWKS_MODE` to `dynamic`. Leave the existing `JWKS` value in place
   as a dormant, short-term rollback value. Do not arm rotation yet.
2. Redeploy the same reviewed commit so Convex changes the auth provider from
   the static data URL to the Better Auth JWKS endpoint.
3. Check sanitized state:

   ```sh
   bun run auth:jwks:status
   bun run auth:jwks:preflight
   ```

   Require `mode: "dynamic"`, `signingKeyUsable: true`, `ready: true`, and no
   outstanding rotation.
4. Exercise sign-in, token issuance, and an authenticated Convex request. Keep
   any test token inside the test client; do not paste it into a terminal or
   ticket. Confirm a token issued before the switch and one issued after the
   switch are both accepted.
5. Only after those checks, set `STELLA_JWKS_ROTATION_ENABLED` to `true`.

If phase 2 fails before a rotation starts, set the mode back to `static`,
redeploy, and investigate. Because the keysets matched and `JWKS` was untouched,
that rollback does not change the signing key.

## Phase 3: rotate with overlap

Choose a non-sensitive, unique operation ID and record it in the change ticket,
for example `2025-05-stella-jwks-01`. An operation ID is metadata, not a secret.

```sh
bun x convex run auth:rotateKeys '{"operationId":"2025-05-stella-jwks-01"}'
bun x convex run auth:getKeyRotationStatus '{"operationId":"2025-05-stella-jwks-01"}'
```

Require all of the following:

- The rotation state is `active`.
- The status signing key ID equals `newKeyId`.
- The key count increased by one.
- `retireAfter` is at least `requiredOverlapSeconds` after activation.

If either command times out or loses its response, rerun it with the exact same
operation ID. The action will resume a prepared operation or validate and
return the already-active operation; it will not create another key.

During the overlap, exercise token issuance and authenticated requests again.
Existing clients holding old tokens must continue working. Do not retire based
only on apparent success or on local wall-clock math; use the recorded status.

## Roll back an active rotation

Rollback makes the previous key newest again. It does not immediately delete
the candidate, because tokens may already have been signed by it.

```sh
bun x convex run auth:rollbackKeyRotation '{"operationId":"2025-05-stella-jwks-01"}'
bun x convex run auth:getKeyRotationStatus '{"operationId":"2025-05-stella-jwks-01"}'
```

Require state `rolled_back`, the status signing key ID equal to
`previousKeyId`, and a new future `retireAfter`. Retry with the same ID if the
response is uncertain. Keep dynamic mode active while candidate-signed tokens
age out.

A prepared operation can also be canceled with the rollback command. Since it
never became the signer, its candidate is removed in the same transaction.

## Phase 4: explicit retirement

Wait until the reported `retireAfter` has passed and the complete overlap has
been healthy. Then run:

```sh
bun x convex run auth:retireKeyRotation '{"operationId":"2025-05-stella-jwks-01"}'
bun x convex run auth:getKeyRotationStatus '{"operationId":"2025-05-stella-jwks-01"}'
```

Require state `retired`, `retiredAt` at or after `retireAfter`, and a key count
decrease of exactly one. An early call fails closed and changes nothing. A
retry after a lost response returns the same terminal record.

After successful retirement, set `STELLA_JWKS_ROTATION_ENABLED` to `false`
unless another reviewed rotation is immediately planned.

## Recovery boundaries

- Before the first rotation, static-mode rollback is safe after a successful
  keyset-match preflight.
- While the original static key is the previous key in an active rotation,
  static-mode rollback first requires rolling the rotation back, waiting its
  fresh overlap, retiring the candidate, and rerunning preflight.
- Once the original static key has been retired, the dormant `JWKS` snapshot is
  stale and must not be re-enabled. Recovery is fix-forward in dynamic mode.
- Never reconstruct a static snapshot from logs or command output. These APIs
  intentionally cannot return private JWK fields.
- Any missing key, tied signing order, unexpected signer, inconsistent expiry,
  duplicate unfinished operation, invalid mode, or keyset mismatch requires
  manual code/data review. Do not use Better Auth's delete-all rotation as a
  repair.

## Audit evidence

Save only:

- reviewed commit and deployment identifiers;
- operation ID;
- sanitized status/preflight results;
- activation, rollback (if any), and retirement timestamps;
- pass/fail results for old-token and new-token behavior.

The rotation audit log is an allowlisted record containing only operation
state, key document IDs, and retirement timestamps. Do not attach environment
values, raw function traces containing ad hoc arguments, token strings, table
exports, or dashboard screenshots of JWKS records.

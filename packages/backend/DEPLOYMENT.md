# Backend deployment prerequisites

Convex validates every document against the deployed schema and every
function result against its `returns` validator. Removing a table or a field
from `convex/schema/` therefore does **not** clean up data that is already in
the deployment — it makes that data illegal.

This codebase intentionally carries no migrations, no compatibility readers,
and no field-stripping shims for retired surfaces. The obsolete data must be
destroyed out-of-band **before** the schema below is pushed.

## Destructive purge required before `convex deploy`

### Tables removed from the schema

Delete every document in these tables (they are no longer declared, so a push
against a non-empty table fails schema validation):

| Retired product           | Tables                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stella Store              | `store_packages`, `store_package_releases`                                                                                                          |
| Stella Social / Together  | `social_profiles`, `social_relationships`, `social_rooms`, `social_room_members`, `social_messages`                                                 |
| Shared sessions           | `stella_sessions`, `stella_session_members`, `stella_session_turns`, `stella_session_files`, `stella_session_file_ops`, `stella_session_file_blobs` |
| Pet catalog / custom pets | `pet_catalog`, `pet_tag_membership`, `pet_tag_facets`, `user_pets`                                                                                  |

### Field removed from a table that still exists

`emoji_packs.authorUsername` is gone. Its only writer was the retired social
profile, so the field is now unreachable — but rows written before this change
still carry it. `emoji_pack_validator` is a strict `v.object`, so a stale
`authorUsername` fails both schema validation on push and the `returns`
validator on read.

**Unset `authorUsername` on every `emoji_packs` document before deploying.**
No code strips it, by design.

### Convex file storage

`stella_session_file_blobs` referenced Convex storage ids. Deleting the rows
does not delete the blobs — enumerate and `ctx.storage.delete()` them (or drop
them from the dashboard) as part of the same purge.

### R2 objects

Nothing in the codebase reads these prefixes any more; delete the objects and
the buckets that only served them:

- Pet sprite sheets / previews written by the retired `user_pet_uploads` and
  `user_pet_generation` actions (the bucket named by the retired
  `R2_PETS_BUCKET` variable).
- Store release artifacts referenced by the retired
  `store_package_releases.diffRef` / `commitsDiffRef` (`kind: "r2"`, `r2Key`)
  and the git-object artifacts written by `store_git_artifacts`.

## Environment variables

### Retired — unset them

| Variable                                            | Was used by                                       |
| --------------------------------------------------- | ------------------------------------------------- |
| `R2_PETS_BUCKET`                                    | pet uploads, and as an emoji-pack bucket fallback |
| `STELLA_STORE_WEB_URL`, `VITE_STELLA_STORE_WEB_URL` | Store web embed origin                            |
| `VITE_STELLA_STORE_BROWSE_ENABLED`                  | Store route gate                                  |

### Emoji pack storage — set both or neither

`R2_EMOJI_BUCKET` and `R2_PUBLIC_BASE_URL` are a pair: objects are written to
the bucket over `R2_ENDPOINT`, and persisted rows reference them through the
public base. `resolveEmojiPackR2Destination()` (`convex/lib/emoji_pack_r2.ts`)
throws `SERVER_MISCONFIGURED` if only one is set, rather than silently mixing
an overridden bucket with the built-in public origin.

Deployments that previously pointed emoji packs at `R2_PETS_BUCKET` **must**
now set `R2_EMOJI_BUCKET` (and the matching `R2_PUBLIC_BASE_URL`) explicitly.
Leaving both unset selects the built-in `stella-emotes` pair.

`R2_EMOJI_PREFIX` remains optional and defaults to `emoji-packs`.

## Desktop website origin

The desktop billing return URL now reads `STELLA_WEB_URL` /
`VITE_STELLA_WEB_URL` (default `https://stella.sh`) through the
`website:getBaseUrl` IPC. The Store-specific overrides listed above are no
longer consulted.

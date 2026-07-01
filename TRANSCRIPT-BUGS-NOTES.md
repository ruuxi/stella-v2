# Mobile transcript bugs: duplicate user messages + assistant ordering

Symptoms (Rahul's phone, desktop-bridge "Computer" thread):

1. USER messages appear duplicated.
2. ASSISTANT replies appear out of order vs the actual conversation.

## Root cause 1 — duplicated user messages

The optimistic local user bubble is only linked to its canonical desktop row by
`reconcileSentDesktopTurn`, which runs **after the turn completes**. Anything
that pulls canonical rows from the desktop **mid-turn** hits
`mergeMessagesById`, which matches strictly by `id`/`canonicalId` — the
optimistic bubble has a local id and no `canonicalId` yet, so the canonical
user row (id = desktop `message._id`) is appended as a **new row → duplicate**.

Two changes from `d183660` ("Reconcile mobile activity tasks", 07-01) opened
exactly that window:

- A new 5-second `runDesktopSync()` interval fires whenever any conversation
  task is `running` — including **during an in-flight send** (nothing gates it
  on `sending`). The desktop persists the `user_message` as soon as the turn
  starts, so the mid-turn pull returns the canonical user row before the
  reconcile can link it.
- Desktop-side task anchors (`withTaskAnchorMessages` in
  `desktop/electron/services/local-chat-artifacts.ts`) re-emit the
  task-spawning **user row in every cursor delta** while its task is updating,
  even though that row is behind the cursor. So a user message that spawned an
  agent task is re-delivered by every 5s poll; if its bubble isn't linked yet,
  it duplicates. (`b29311b`'s streaming agent cards make agent runs the common
  case, which is why this shows up on agent-heavy usage.)

Compounding damage: the mid-turn sync **advances the persisted cursor past the
just-sent user row**, so the post-turn reconcile delta may no longer contain
the canonical user/assistant rows (`hasCanonicalAssistant` guard then skips the
whole reconcile) — the bubble stays unlinked forever and keeps duplicating.
And `reconcileSentDesktopTurn` never evicts a canonical twin that was already
merged: it relabels the local row (`canonicalId: X`) but leaves the earlier
merged row with `id: X` in place → **permanent duplicate**.

## Root cause 2 — assistant ordering looks wrong

- `306cb9e` anchors already-on-screen rows to their **phone-clock**
  `createdAt`, while rows arriving as *new* through `mergeMessagesById` slot by
  the **desktop-clock** `timestamp`. Canonical rows of a phone-sent turn are
  only supposed to arrive via the reconcile (which keeps the phone anchor);
  when they instead arrive as new rows (root cause 1), the transcript sorts
  phone-stamped and desktop-stamped rows of the *same* turn against each other
  and clock skew shuffles them — replies land above their question or between
  older turns.
- `reconcileSentDesktopTurn` picks the canonical assistant as "last assistant
  row in the delta" and the canonical user by text match. The delta can contain
  stand-in artifact rows (`<id>:artifacts`, `<id>:agent` — role `assistant`,
  empty text) and rows from other turns. Picking a stand-in (or another turn's
  reply) **replaces the streamed reply's content** and lets the real reply
  merge elsewhere as a new desktop-stamped row — visible as wrong
  ordering/moved replies.

Precise linking is available and unused: the desktop stamps each assistant row
with `requestId === <canonical user message id>` (see
`readAssistantMessageForTurn`), and `sendDesktopBridgeChat` already tracks
`submittedUserMessageId` internally — it just doesn't return it.

## Fixes (mobile-side only; no desktop change needed)

1. `use-chat-thread.ts`: don't run the 5s task-poll sync while a send is in
   flight (`sending` gate). Mid-turn activity already streams over the bridge.
2. `chat-merge.ts` (`reconcileSentDesktopTurn`): exclude stand-in rows from
   canonical user/assistant selection; evict already-merged canonical twins of
   the linked rows; accept the exact `canonicalUserMessageId` and select the
   assistant by `requestId` match.
3. `desktop-bridge-chat.ts`: return `userMessageId` (canonical desktop id) and
   the turn `requestId` from `sendDesktopBridgeChat`; `use-chat-thread.ts`
   stamps `canonicalId` on the optimistic bubble immediately at turn end (no
   longer depends on the reconcile delta containing the user row) and stamps
   `requestId` on the reply row.
4. `chat-merge.ts` (`mergeMessagesById`): link incoming non-stand-in assistant
   rows to an existing row with the same `requestId` (late-arriving canonical
   reply no longer duplicates the streamed bubble); collapse an unlinked
   `id: X` twin when a `canonicalId: X` row exists (self-heals existing dups
   when anchors re-deliver rows).

## Commits

- `27c6e21` diagnosis notes (this file)
- `05e5bf6` fix 1: gate the 5s task-poll sync while a send is in flight
- `553355f` fixes 2–4: reconcile hardening (stand-in exclusion, twin
  eviction), precise canonical linking via the bridge-reported user-message
  id, requestId-aware merge + twin collapse
- `2296bc5` chat-merge dedupe/ordering unit tests (`cd mobile && bun test`,
  12 pass)

## Ship path

Both bugs are mobile-side (`mobile/src/lib`). Reaching Rahul's phone requires a
**mobile build/OTA update**; no desktop release needed.

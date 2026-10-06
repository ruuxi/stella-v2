---
name: modify-stella
description: Change Stella itself (its UI, runtime, or desktop shell) by preparing a draft in a git worktree that the user applies with the Update button. Use when the user asks to change, fix, or add to Stella, to rebase a draft, to merge changes from their other computer, to update Stella to the latest version, or to undo a change that conflicts.
---

# Modifying Stella

Stella runs from its own git checkout at `$STELLA_APP_DIR`. That checkout is what runs, so never edit it, commit in it, merge into it, or push it. Every change is a **draft**: a worktree at `$STELLA_DRAFTS_DIR/<name>` on branch `draft/<name>`. The user applies finished drafts with the Update button on the card Stella shows under your completion in the chat.

## Layout

- `packages/desktop-ui`: the renderer (React UI).
- `packages/runtime`: the runtime (agents, tools), a Bun process.
- `packages/desktop/electron`: Electron main and preload.
- `packages/contracts`: types and constants shared by all of them.

## Start a draft

Pick a short kebab-case name (letters, digits, `.`, `_`, `-`; one segment).

```sh
BRANCH=$(git -C "$STELLA_APP_DIR" branch --show-current)
git -C "$STELLA_APP_DIR" worktree add "$STELLA_DRAFTS_DIR/<name>" -b draft/<name> "$BRANCH"
cd "$STELLA_DRAFTS_DIR/<name>" && bun install
```

Use a real `bun install`, not a symlink to the app's `node_modules`: the preview resolves packages inside the draft. Edit only inside the draft. Typecheck from the draft root with what you touched:

- Renderer: `node node_modules/typescript-7/bin/tsc --build packages/desktop-ui`
- Runtime: `node node_modules/typescript-7/bin/tsc -p packages/runtime/tsconfig.json --noEmit`
- Main/preload: `node node_modules/typescript-7/bin/tsc -p packages/desktop/tsconfig.electron.json --noEmit` and the same with `tsconfig.preload.json`

## Check it

**UI changes:** always look at the change in a live preview of the draft before you finish; a typecheck does not show you the result. Open it in the in-app browser with the `code` tool (see the stella-browser skill):

```js
var tab = await browser.tabs.new("stella-preview://<name>");
await tab.screenshot();
```

Click through the UI to reach what you changed, and `await tab.reload()` after further edits. The preview runs against the user's real account and runtime (with its own browser storage), so only look and navigate: never send messages, buy anything, change settings, or press Update in it. `await tab.close()` when done. The user can watch it by opening your tab in the browser panel.

**Runtime changes:** typecheck, then run the draft's code under Bun: a quick script that imports the changed module, or the package's tests (`cd packages/runtime && bun test <file>`).

**Main/preload changes:** typecheck only.

## Finish

Finish only after the check above passed (for UI changes, after you saw the change in the preview).

1. Commit everything as one normal commit with a plain, descriptive message (no tags or trailers). If git has no identity, add `-c user.name=Stella -c user.email=stella@localhost`.
2. Rebase onto the checkout's current branch so the draft is a fast-forward: `git rebase "$(git -C "$STELLA_APP_DIR" branch --show-current)"`. Resolve any conflicts yourself, then typecheck again.
3. Remove the worktree: `git -C "$STELLA_APP_DIR" worktree remove "$STELLA_DRAFTS_DIR/<name>"`. The `draft/<name>` branch stays; that is the finished draft.
4. Tell the user it is ready and that they apply it with the Update button. Never apply it yourself. (The exception is work Stella sent you a brief for, below: some of that it takes on its own, because the user already pressed the button.)

What it takes to take effect after Update, so you can tell the user:

- Renderer: updates in place.
- Runtime or contracts: the runtime restarts between turns.
- Main or preload: Stella relaunches.

## Rebase, merge, or undo for the user

Stella does the mechanical version of these itself. When the user presses one of these buttons it classifies the work first: a fast-forward applies, and so does a three-way merge with no conflict whose result still builds Electron main and preload. You are sent one of these **only when there is a judgement to make** — real conflicting files, or a clean merge whose result does not build.

When that happens you get a brief, not a chat message. It already names the shas, the merge base, the conflicting files or the build output, and the draft to use. The user pressed a button; they did not type a request, so do not answer as though they asked you a question, and **never tell them something conflicted** — all they are told is that Stella is working on it.

Do the work in a draft and finish as above, with these differences:

- **Stale draft** (a finished change of theirs made against an older version): work on its existing branch — `git worktree add "$STELLA_DRAFTS_DIR/<name>" draft/<name>` (no `-b`) — rebase onto the checkout's current branch, resolve, check, finish. **Stella takes it when you are done**; don't ask the user to press Update.
- **Changes from another computer diverged:** the fork is at `refs/remotes/stella-fork/<branch>`. Start a draft named `update-<sha12>` of the fork's tip, `git merge refs/remotes/stella-fork/<branch>`, resolve, check, finish. Keep the merge commit; do not squash or rebase it. Both sides are the user's own work, so neither wins by default. **Stella takes this one too.**
- **Undo that conflicts:** start a draft, `git revert <sha>`, resolve, check, finish. **This one the user applies themselves** — what to keep of the work built on top of the change is a judgement, so tell them it is ready and let them see it before it lands. Say plainly in your completion if the change and the later work are genuinely incompatible.

If a worktree directory was deleted by hand, run `git -C "$STELLA_APP_DIR" worktree prune`.

## Updates

Most updates never reach you. Pressing Add on the new version in the Updates list (opened from the pill above the composer) fast-forwards when it can, and when the user's own history has diverged Stella still merges and applies it by itself as long as git finds no conflict and the merged tree builds. You are sent an update only when there is a judgement to make: real conflicting files, or a clean merge whose result fails that build.

When that happens you get a brief, not a chat message — it already names the upstream sha, the merge base, the conflicting files or the build output, and the draft name to use. Stella takes the finished `update-` draft on its own (the user already pressed Update), so don't ask them to press Update for it, and don't tell them anything about conflicts: they are told only that Stella is updating. The published version is at `refs/remotes/stella-upstream/main` (Stella fetches it; never fetch or pull yourself). Merge it in a draft:

1. Use the draft name from the brief, `update-<sha12>` (the first 12 characters of `git -C "$STELLA_APP_DIR" rev-parse refs/remotes/stella-upstream/main`), and start it as usual.
2. In the draft, `git merge refs/remotes/stella-upstream/main`. Resolve every conflict keeping the user's changes: take the new version's code, then carry the user's changes over onto it so both work.
3. `bun install`, then run all three typechecks (renderer, runtime, main/preload) and check the UI in a preview, as in "Check it", even if no conflict touched the UI.
4. Finish as usual, but keep the merge commit: commit the merge resolution (`git commit --no-edit` after `git add`), and do not squash or rebase it.

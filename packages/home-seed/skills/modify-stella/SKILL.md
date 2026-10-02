---
name: modify-stella
description: Change Stella itself (its UI, runtime, or desktop shell) by preparing a draft in a git worktree that the user applies with the Update button. Use when the user asks to change, fix, or add to Stella, to rebase a draft, to merge changes from their other computer, or to undo a change that conflicts.
---

# Modifying Stella

Stella runs from its own git checkout at `$STELLA_APP_DIR`. That checkout is what runs, so never edit it, commit in it, merge into it, or push it. Every change is a **draft**: a worktree at `$STELLA_DRAFTS_DIR/<name>` on branch `draft/<name>`. The user applies finished drafts with the Update button in Stella's top bar.

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

Edit only inside the draft. Typecheck from the draft root with what you touched:

- Renderer: `node node_modules/typescript-7/bin/tsc --build packages/desktop-ui`
- Runtime: `node node_modules/typescript-7/bin/tsc -p packages/runtime/tsconfig.json --noEmit`
- Main/preload: `node node_modules/typescript-7/bin/tsc -p packages/desktop/tsconfig.electron.json --noEmit` and the same with `tsconfig.preload.json`

## Check it

**UI changes:** open a live preview of the draft in the in-app browser with the `code` tool (see the stella-browser skill):

```js
var tab = await browser.tabs.new("stella-preview://<name>");
await tab.screenshot();
```

Click through the UI to reach what you changed, and `await tab.reload()` after further edits. The preview runs against the user's real account and runtime (with its own browser storage), so only look and navigate: never send messages, buy anything, change settings, or press Update in it. `await tab.close()` when done. The user can watch it by opening your tab in the browser panel.

**Runtime changes:** typecheck, then run the draft's code under Bun: a quick script that imports the changed module, or the package's tests (`cd packages/runtime && bun test <file>`).

**Main/preload changes:** typecheck only.

## Finish

1. Commit everything as one normal commit with a plain, descriptive message (no tags or trailers). If git has no identity, add `-c user.name=Stella -c user.email=stella@localhost`.
2. Rebase onto the checkout's current branch so the draft is a fast-forward: `git rebase "$(git -C "$STELLA_APP_DIR" branch --show-current)"`. Resolve any conflicts yourself, then typecheck again.
3. Remove the worktree: `git -C "$STELLA_APP_DIR" worktree remove "$STELLA_DRAFTS_DIR/<name>"`. The `draft/<name>` branch stays; that is the finished draft.
4. Tell the user it is ready and that they apply it with the Update button. Never apply it yourself.

What it takes to take effect after Update, so you can tell the user:

- Renderer: updates in place.
- Runtime or contracts: the runtime restarts between turns.
- Main or preload: Stella relaunches.

## Rebase, merge, or undo for the user

The Update menu sends you these when git cannot do them alone. Do them in a draft and finish the same way.

- **Stale draft** ("Rebase my draft X"): `git worktree add "$STELLA_DRAFTS_DIR/X" draft/X` (no `-b`), then rebase onto the current branch, resolve, check, finish.
- **Changes from another computer diverged:** the fork is at `refs/remotes/stella-fork/<branch>`. Start a draft, `git merge refs/remotes/stella-fork/<branch>`, resolve, check, then finish (skip squashing: keep the merge commit, and do not rebase it).
- **Undo that conflicts:** start a draft, `git revert <sha>`, resolve, check, finish.

If a worktree directory was deleted by hand, run `git -C "$STELLA_APP_DIR" worktree prune`.

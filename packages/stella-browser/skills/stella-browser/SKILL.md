---
name: stella-browser
description: Control Stella-owned browser tabs through the persistent code runtime and its frozen browser API. Use for navigation, page interaction, semantic locators, state inspection, new-tab flows, and browser screenshots.
---

# Stella Browser

Use `code` for production browser automation. Its persistent JavaScript runtime exposes a deeply frozen `browser` object with top-level `await`. Bindings and `Tab` and `Locator` identities persist across calls, so create handles once and reuse them.

Use `var` for reusable REPL bindings. Browser actions are not exposed through `exec_command`; use the frozen `browser` API only.

## Production Workflow

Acquire one task-owned tab, navigate that handle, keep its page and locator handles, and batch deterministic dependent actions in one cell. Reuse that one tab with `tab.goto()` for every navigation in the task — never open a new tab per page, and `close()` any extra tab as soon as it has served its purpose (stray tabs accumulate in the user's browser, especially in external mode):

```js
var tab = await browser.tabs.new();
await tab.goto("https://example.com/sign-in");
var page = tab.playwright;
var email = page.getByLabel("Email", { exact: true });
var password = page.getByLabel("Password", { exact: true });
var submit = page.getByRole("button", { name: "Sign in", exact: true });

await email.fill("user@example.com");
await password.fill("correct-horse-battery-staple");
await submit.click();
await page.waitForURL("**/dashboard");
({ url: await tab.url(), title: await tab.title() });
```

Do not spend one `code` call per action. Keep sequential awaits together when no intermediate result changes the plan. Split at a real decision point, return the cheapest useful value, then continue with the same handles in the next cell:

```js
var search = page.getByPlaceholder("Search");
var rows = page.locator("[data-testid='result-row']");
await search.fill("quarterly report");
await search.press("Enter");
await rows.first().waitFor({ state: "visible" });
await rows.count();
```

After deciding which result to use, reuse `tab`, `page`, and `rows`:

```js
var chosenRow = rows.nth(0);
await chosenRow.click();
await page.waitForURL("**/reports/**");
await tab.title();
```

Locators resolve against current page state when called; do not replace a locator merely because the DOM changed. Rebuild it only when the selector or intended element changes.

Selectors (semantic and CSS) search the top document plus same-origin iframes and open shadow roots. Snapshots also expose cross-origin frame content through frame-qualified refs (see Observe Cheaply below); to act inside a cross-origin frame, use a ref from the latest observation rather than guessing a top-document selector or matching a same-named control elsewhere.

## Keyboard

There is no `page.keyboard`. Page-level keys go through the tab handle:

- `tab.press(key)` sends a key to whatever holds focus: `"Enter"`, `"Escape"`, `"Tab"`, combos like `"Control+a"` or `"Meta+Shift+P"`.
- `tab.keyboard.type(text)` inserts raw text at the current focus without per-character key events (works for emoji/CJK, and for canvas-style editors after clicking into them).
- `locator.press(key)` focuses its element first, then presses.

```js
await tab.playwright.getByRole("textbox", { name: "Document content" }).click();
await tab.keyboard.type("Hello world");
await tab.press("Control+a");
```

## Observe Cheaply

Use the least expensive observation that answers the question:

- Page identity: `await tab.url()` or `await tab.title()`.
- Element existence or state: `count()`, `isVisible()`, `isEnabled()`, or `isChecked()`.
- Focused values: `innerText()`, `textContent()`, `inputValue()`, or `getAttribute()`.
- Unknown structure at a branch or recovery point: `tab.axSnapshot()` (incremental; see below). It is not available in cloud browser sessions; there, and whenever the full DOM snapshot format is wanted, use `tab.snapshot()` or `page.domSnapshot()`.
- Visual appearance, coordinates, or rendering: `tab.screenshot()`. The image is attached to the tool result automatically; the JavaScript return value is only a compact `{ attached, path, format, mimeType }` receipt. Do not pass that receipt to `codeRuntime.emitImage()`.

Do not take a snapshot after every action. Snapshot only when page structure is needed to choose the next step. Use a screenshot only when pixels matter.

Semantic snapshots are bounded to 200 emitted entries and 20,000 characters. When a page exceeds that budget, metadata reports truncation and unavailable frames; narrow with `selector`, `interactive`, `compact`, or `maxDepth` instead of requesting repeated full-page snapshots. Selector-scoped captures omit descendant frames.

Frame-qualified refs are bound to the document they were observed in: a cross-origin ref rejects a detached node or a replaced document instead of falling back to a same-named control, and pointer geometry through a transformed or CSS-zoomed iframe is rejected when it cannot be mapped safely. If a snapshot fails closed because an operator-configured domain filter (`STELLA_BROWSER_ALLOWED_DOMAINS`) applies to the external browser, use the in-app browser instead; never disable the filter.

### Incremental AX observations

`tab.axSnapshot()` reads the browser accessibility tree, including accessible child frames. Its default `mode: "auto"` returns one of:

- `{ kind: "full", snapshotId, snapshot, reason }` on first use, a document/options change, when a diff would be larger than the full tree, or when the bounded diff computation would exceed its budget.
- `{ kind: "diff", snapshotId, baseSnapshotId, diff }` with unified line-diff hunks relative to the indicated previous observation. Deleted lines are prefixed `-`, added lines `+`, and nearby unchanged lines with a space. Refs on deleted lines are no longer evidence for an action.
- `{ kind: "unchanged", snapshotId }` when the bounded tree has not changed. This does not mean the page has finished loading or that pixels are unchanged.

The baseline is private to this persistent runtime, backend, tab generation and snapshot options. Document replacement and reload reset identity even when the URL is unchanged. Same-document history changes can appear as ordinary diffs. A failed capture clears the baseline. Only the observed bounded tree is compared; omitted content is not claimed unchanged.

```js
var observation = await tab.axSnapshot();
// Select a ref from the returned full tree or its subsequent changes.
await tab.playwright.locator("@e123").click(); // replace with an observed ref
await tab.axSnapshot();
```

Use `await tab.axSnapshot({ mode: "full" })` after context compaction, output pruning, or whenever the referenced baseline is no longer in context. `mode: "diff"` requests differences even if larger; a missing or incompatible baseline or exhausted computation budget still returns full output. AX options are `mode`, `interactive`, `compact`, `maxDepth`, and `selector`. Keep using the same options to retain the baseline. The DOM snapshot APIs remain full-output and do not share the AX baseline.

## Synchronize on Browser State

Wait for the state caused by the action:

```js
await submit.click();
await page.waitForURL("**/complete", { timeout: 30000 });

var confirmation = page.getByText("Saved", { exact: true });
await confirmation.waitFor({ state: "visible", timeout: 30000 });
```

`Locator.waitFor()` supports `attached`, `detached`, `visible`, and `hidden`. Prefer it, `waitForURL()`, or `expectNewTab()` over fixed delays. Although `page.waitForTimeout(ms)` exists, do not use it for routine synchronization or insert sleeps between deterministic actions.

## New Tabs

Wrap the action that opens a tab with `expectNewTab()`. Calling it after the click misses the before-state used to identify the new owned tab.

```js
var openReport = page.getByRole("link", { name: "Open report", exact: true });
var reportTab = await tab.expectNewTab(async () => await openReport.click(), {
  timeoutMs: 10000,
});
var reportPage = reportTab.playwright;
await reportPage.getByRole("heading", { name: "Report" }).waitFor();
```

`expectNewTab()` succeeds only when exactly one newly adopted owned tab appears. Its default timeout is 10 seconds and its maximum is 60 seconds. The same method is available as `page.expectNewTab()`.

## Finalize Owned Tabs

Mark a retained tab as soon as its final disposition is known. Automatic close-tabs turn cleanup preserves marked tabs and closes unmarked task-owned tabs:

```js
await tab.markHandoff();
await reportTab.markDeliverable();
```

Marks are scoped to the current owner turn. `markHandoff()` is for a tab the user should continue in; `markDeliverable()` is for a completed result worth retaining.

`browser.tabs.finalize()` remains the explicit authoritative cleanup operation. List only tabs intentionally retained; unlisted task-owned tabs are closed even if previously marked.

```js
await browser.tabs.finalize([
  { tab, status: "handoff" },
  { tab: reportTab, status: "deliverable" },
]);
```

Entries may be a `Tab`, tab ID, or `{ tab, status }`/`{ tabId, status }`. Status must be `"handoff"` or `"deliverable"`; a bare tab defaults to `"deliverable"`. Use `await browser.tabs.finalize([])` when no task-owned tab should remain.

## Frozen Browser API

The public object graph is frozen. Do not mutate it or attach properties. This installed skill is the runtime reference. For lightweight discovery, inspect `browser.capabilities`, `Object.keys(browser)`, `Object.keys(tab)`, or `Object.keys(locator)`; there is no runtime documentation command.

### Browser and Tabs

| Object         | Supported API                                                        |
| -------------- | -------------------------------------------------------------------- |
| `browser`      | `capabilities`, `use(backend)`, `chain(steps, options)`, `tabs`      |
| `browser.tabs` | `list()`, `new(url?)`, `selected()`, `get(id)`, `finalize(entries?)` |

For a new task, call `tabs.new()` once and then navigate that handle with `tab.goto(url)`. If navigation fails, reuse the same handle or inspect `tabs.list()`; do not loop on `tabs.new()` because a delayed response can otherwise create a pileup of blank tabs. Use `tabs.selected()` only when the user's currently selected owned tab is the target, and `tabs.list()` when tab choice is itself a decision.

`browser.chain()` is a low-level JSON action batch, limited to 100 steps. Prefer normal method calls with multiple awaits in one REPL cell because they preserve typed handles and are easier to branch and debug. Chains reject unknown actions, options, arbitrary values, and nested chains. Supported chain options are `timeout` (milliseconds, at most 240000), `delay`, `waitForSelector`, `waitTimeout`, `abortOnError`, `returnSnapshot`, and `returnScreenshot`; do not add `delay` or automatic snapshots without a concrete need.

### Tab

| API                                                                   | Notes                                        |
| --------------------------------------------------------------------- | -------------------------------------------- |
| `id`                                                                  | Positive numeric owned-tab ID.               |
| `playwright`                                                          | Frozen page facade, cached for this tab.     |
| `goto(url, { waitUntil?, timeout? })`                                 | Navigate the tab.                            |
| `back({ timeout? })`, `forward({ timeout? })`, `reload({ timeout? })` | History navigation.                          |
| `close()`                                                             | Close this tab.                              |
| `markHandoff()`, `markDeliverable()`                                  | Retain during automatic turn cleanup.        |
| `url()`, `title()`                                                    | Cheapest page identity reads.                |
| `snapshot(options?)`                                                  | Structural observation.                      |
| `axSnapshot({ mode?, interactive?, compact?, maxDepth?, selector? })` | AX tree, incremental; not in cloud sessions. |
| `screenshot(options?)`                                                | Pixel observation.                           |
| `press(key)`                                                          | Page-level key press to current focus.       |
| `keyboard.type(text)`, `keyboard.press(key)`                          | Raw text insertion / key press.              |
| `scroll(options?)`                                                    | Scroll page or element.                      |
| `expectNewTab(action, { timeoutMs? })`                                | Capture exactly one new owned tab.           |

Snapshot options are `interactive`, `cursor`, `maxDepth` (or `depth`), `compact`, and `selector`. Screenshot options are `fullPage`, `selector`, `format` (`"png"` or `"jpeg"`), `quality` (0-100), and `annotate`. Scroll options are pixel deltas `x`/`y` (negative scrolls up/left) or `selector` + `direction` + `amount`; prefer `locator.scrollIntoViewIfNeeded()` before acting on an element.

### Page Facade

`tab.playwright` supports only this Playwright-like subset:

```text
domSnapshot(options?)
evaluate(pageFunction, arg?)
locator(css)
getByRole(role, { name?, exact? })
getByText(text, { exact? })
getByLabel(text, { exact? })
getByPlaceholder(text, { exact? })
getByTestId(testId, { exact? })
waitForURL(url, { timeout? })
waitForTimeout(ms)
expectNewTab(action, { timeoutMs? })
```

This is not the full Playwright API. Locator values and URL patterns are strings; regular expressions are rejected. `evaluate()` accepts a function or source string. Pass external data through its JSON-serializable argument because page functions do not retain REPL closures.

### Locator

Locators support:

```text
locator(css)
filter({ hasText?, hasNotText?, has?, hasNot? })
nth(index), first(), last(), count()
click(), dblclick(), fill(value), type(text), press(key)
hover(), focus(), check(), uncheck(), setChecked(boolean)
selectOption(valueOrValues), setInputFiles(absolutePaths)
scrollIntoViewIfNeeded()
innerText(), textContent(), inputValue(), getAttribute(name)
isVisible(), isEnabled(), isChecked(), boundingBox()
evaluate(pageFunction, arg?), waitFor(options?), allTextContents()
```

`setInputFiles` requires absolute file paths and targets `<input type=file>`.

`locator()` chaining is supported only from an unfiltered CSS locator. `filter({ has, hasNot })` requires same-tab CSS locators. `nth()` is zero-based. Semantic locators use the frozen API's small role mapping and string matching; they do not provide every Playwright accessibility behavior.

Timeouts are non-negative milliseconds and are capped at 120 seconds unless a smaller `expectNewTab()` limit applies. Locator actions retry transient not-found/not-actionable state for one shared three-second deadline, then add a bounded five-match diagnostic; unknown-outcome transport failures are never replayed. A low-level `browser.chain()` has its own overall `timeout` option capped at 240 seconds. Unknown option keys fail fast. A timeout error states whether its deadline was the caller's override or the runtime default and whether the request had already been dispatched; if dispatch occurred, treat the remote outcome as unknown and inspect state before retrying a mutating action.

## Not Logged In: Try the External Browser

The default in-app browser has its own session and mirrors the user's signed-in cookies from their real browser, but that copy can be incomplete — sites that keep auth in localStorage/token storage, device-bound sessions, or partitioned cookies may still read as logged out even when the real browser is signed in.

When a site loads but appears NOT logged in — redirected to a sign-in page, "session expired", an auth wall, or an action that fails only for lack of auth — attempt the user's real, signed-in browser before concluding the site is inaccessible:

```js
await browser.use("external"); // select the user's real browser for newly acquired handles
var externalTab = await browser.tabs.new("https://example.com");
// retry the auth-gated workflow on externalTab
await browser.use("in-app"); // old in-app handles remain bound and safe to reuse
```

Every `Tab` and `Locator` exposes its fixed `.backend`. Switching the default affects newly acquired handles only; an existing handle continues routing to the backend that created it, even after `browser.use()` changes the default. Do not expect an in-app tab to become an external tab.

This is a fallback to try, not a default. Keep using the in-app browser for normal work; reach for `external` only when missing auth actually blocks the task, then switch back with `browser.use("in-app")`. External mode needs the Stella Browser extension installed and connected — if it is unavailable, report that rather than assuming the site is down. This is distinct from a transport/bridge failure (below): use `external` only for a logged-out or auth-failed site on an otherwise-working browser.

## Transport Failures

Do not fall back to shell commands or a visible Chrome/Brave browser when the frozen browser API reports a bridge or transport failure. Report the exact error and park the browser-dependent step; continue only work that does not require browser access. Do not promise automatic backend recovery, retries, or stale-tab cleanup; none is part of the frozen worker API contract.

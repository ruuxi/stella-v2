---
name: stella-browser
description: Control Stella-owned browser tabs through the persistent node_repl runtime and its frozen browser API. Use for navigation, page interaction, semantic locators, state inspection, new-tab flows, and browser screenshots.
---

# Stella Browser

Use `node_repl` for production browser automation. Its persistent JavaScript runtime exposes a deeply frozen `browser` object with top-level `await`. Bindings and `Tab` and `Locator` identities persist across calls, so create handles once and reuse them.

Use `var` for reusable REPL bindings. Browser actions are not exposed through `exec_command`; use the frozen `browser` API only.

## Production Workflow

Acquire one task-owned tab, navigate that handle, keep its page and locator handles, and batch deterministic dependent actions in one cell:

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

Do not spend one `node_repl` call per action. Keep sequential awaits together when no intermediate result changes the plan. Split at a real decision point, return the cheapest useful value, then continue with the same handles in the next cell:

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

Selectors (semantic and CSS) search the top document plus same-origin iframes and open shadow roots, so embedded editors (e.g. a Google Docs canvas iframe) resolve without frame plumbing. Cross-origin frames cannot be searched; not-found errors state how many frames were skipped.

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
- Unknown structure at a branch or recovery point: `tab.snapshot()` or `page.domSnapshot()`.
- Visual appearance, coordinates, or rendering: `tab.screenshot()`.

Do not take a snapshot after every action. Snapshot only when page structure is needed to choose the next step. Use a screenshot only when pixels matter.

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

Finalize tabs when browser work ends, including recovery after a failed flow. List only tabs intentionally retained; unlisted task-owned tabs are eligible for cleanup.

```js
await browser.tabs.finalize([
  { tab, status: "handoff" },
  { tab: reportTab, status: "deliverable" },
]);
```

Entries may be a `Tab`, tab ID, or `{ tab, status }`/`{ tabId, status }`. Status must be `"handoff"` or `"deliverable"`; a bare tab defaults to `"deliverable"`. Use `await browser.tabs.finalize([])` when no task-owned tab should remain.

## Frozen Browser API

The public object graph is frozen. Do not mutate it or attach properties. It is introspectable: `Object.keys(tab)` or `Object.keys(locator)` lists the available methods. Call `browser.documentation()` for the full runtime reference.

### Browser and Tabs

| Object         | Supported API                                                        |
| -------------- | -------------------------------------------------------------------- |
| `browser`      | `documentation()`, `chain(steps, options)`, `tabs`                   |
| `browser.tabs` | `list()`, `new(url?)`, `selected()`, `get(id)`, `finalize(entries?)` |

For a new task, call `tabs.new()` once and then navigate that handle with `tab.goto(url)`. If navigation fails, reuse the same handle or inspect `tabs.list()`; do not loop on `tabs.new()` because a delayed response can otherwise create a pileup of blank tabs. Use `tabs.selected()` only when the user's currently selected owned tab is the target, and `tabs.list()` when tab choice is itself a decision.

`browser.chain()` is a low-level JSON action batch, limited to 100 steps. Prefer normal method calls with multiple awaits in one REPL cell because they preserve typed handles and are easier to branch and debug. Chains reject unknown actions, options, arbitrary values, and nested chains. Supported chain options are `timeout` (milliseconds, at most 240000), `delay`, `waitForSelector`, `waitTimeout`, `abortOnError`, `returnSnapshot`, and `returnScreenshot`; do not add `delay` or automatic snapshots without a concrete need.

### Tab

| API                                                                   | Notes                                    |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `id`                                                                  | Positive numeric owned-tab ID.           |
| `playwright`                                                          | Frozen page facade, cached for this tab. |
| `goto(url, { waitUntil?, timeout? })`                                 | Navigate the tab.                        |
| `back({ timeout? })`, `forward({ timeout? })`, `reload({ timeout? })` | History navigation.                      |
| `close()`                                                             | Close this tab.                          |
| `url()`, `title()`                                                    | Cheapest page identity reads.            |
| `snapshot(options?)`                                                  | Structural observation.                  |
| `screenshot(options?)`                                                | Pixel observation.                       |
| `press(key)`                                                          | Page-level key press to current focus.   |
| `keyboard.type(text)`, `keyboard.press(key)`                          | Raw text insertion / key press.          |
| `scroll(options?)`                                                    | Scroll page or element.                  |
| `expectNewTab(action, { timeoutMs? })`                                | Capture exactly one new owned tab.       |

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

Timeouts are non-negative milliseconds and are capped at 120 seconds unless a smaller `expectNewTab()` limit applies. Unknown option keys fail fast.

## Not Logged In: Try the External Browser

The default in-app browser has its own session and mirrors the user's signed-in cookies from their real browser, but that copy can be incomplete — sites that keep auth in localStorage/token storage, device-bound sessions, or partitioned cookies may still read as logged out even when the real browser is signed in.

When a site loads but appears NOT logged in — redirected to a sign-in page, "session expired", an auth wall, or an action that fails only for lack of auth — attempt the user's real, signed-in browser before concluding the site is inaccessible:

```js
await browser.use("external"); // drive the user's real browser via the Stella Browser extension
// retry the same navigation / action on that site
await browser.use("in-app"); // switch back when the auth-gated step is done
```

This is a fallback to try, not a default. Keep using the in-app browser for normal work; reach for `external` only when missing auth actually blocks the task, then switch back with `browser.use("in-app")`. External mode needs the Stella Browser extension installed and connected — if it is unavailable, report that rather than assuming the site is down. This is distinct from a transport/bridge failure (below): use `external` only for a logged-out or auth-failed site on an otherwise-working browser.

## Transport Failures

Do not fall back to shell commands or a visible Chrome/Brave browser when the frozen browser API reports a bridge or transport failure. Report the exact error and park the browser-dependent step; continue only work that does not require browser access. Do not promise automatic backend recovery, retries, or stale-tab cleanup; none is part of the frozen worker API contract.

# Browser and takeover

Browser surfaces let Stella show web content, while cloud-browser intervention asks the user to complete sensitive login or device-code steps.

## Sub-features

- `browser-open` launches a browser display tab.
- `browser-navigate` changes the visible URL through user controls.
- `browser-state` covers loading, error, and rendered page states.
- `browser-agent-cursor` shows where an agent is about to act in the in-app browser or the user's connected Chromium browser.
- `takeover-card` presents a pending login or device-code intervention.
- `takeover-decision` lets the user continue, cancel, or complete the intervention.

## How to get to it (user POV)

- Choose **New tab**, then **Browser**.
- Open a browser artifact or link from chat.
- When an agent needs authentication, act on the cloud-browser intervention card in chat or the sidebar.

## Driving it with control-stella

Preconditions:

- The verifier is healthy. External pages require network access.
- Takeover requires a real pending intervention for the current account/conversation.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs nav browser` and require a selected Browser surface.
- **Navigate.** Discover the URL control with `inspect components`, enter a safe URL, and require its origin in the visible state.
- **Diagnose.** Capture `diagnostics network-summary --duration 2000` and `diagnostics console --duration 2000` around failures.
- **Agent cursor.** On a safe page with two separated buttons, ask an agent to click the first and then the second. Record the real browser surface. Require the pointer to travel to the resolved target before each page mutation, retain the blue glow and arrival wobble, and show no badge or click ring.
- **Takeover.** If a real intervention card is present, open it through its visible action and require the declared login or device-code state.
- **Decision.** Use only the card's user-facing continue/cancel/complete controls, then require the card state to update or disappear.

## Gotchas

- Browser content and cloud-browser live view are separate implementations with different trust boundaries.
- Never log full URLs containing credentials, cookies, or capability tokens.
- A takeover cannot be verified by creating internal state or calling the decision mutation directly.
- External site behavior is not Stella behavior. Assert Stella's navigation chrome, errors, and intervention UI.
- Renderer-only screenshots can omit the in-app `WebContentsView`. Use a compositor-level recording or screenshot when proving the cursor over native browser content.

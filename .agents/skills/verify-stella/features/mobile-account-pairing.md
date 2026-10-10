# Mobile account and pairing

Mobile account settings expose identity, the account's computers, Cloud Home, cloud-browser reset, appearance, theme, plan, and sign-out behavior.

## Sub-features

- `mobile-account` shows current identity and account actions.
- `mobile-computers` lists every computer signed in to the account; picking one in the chat settings sheet connects the phone to it (there are no pairing codes).
- `mobile-cloud-home` configures cloud memory/home behavior.
- `mobile-appearance` changes mode, theme, and gradient preferences.
- `mobile-sign-out` returns to the auth gate.

## How to get to it (user POV)

- Open Account from the main mobile navigation.
- Open the chat settings sheet (gear, top right of the chat) to see the account's computers.
- Open Cloud Home, browser, appearance, plan, or sign-out rows from Account.

## Driving it with control-stella-ios

Preconditions:

- The app is authenticated on a booted simulator.
- An online computer needs a separate desktop session signed in to the same test account (for example `control-stella.mjs session launch --account pro`, then `sign-in --email` with that run's account); never reuse a production one.

- **Account.** Capture the Account frame and require identity plus settings sections.
- **Appearance.** Select a mode or theme, navigate away, return, and require the selected value and visual theme to persist.
- **Cloud Home/browser.** Open the row and require its current enabled, unavailable, or error state. Confirm before any destructive browser-profile reset.
- **Computers.** Open the chat settings sheet and require the verifier-owned desktop to appear; picking it connects without a code.
- **Sign out.** If explicitly in scope, sign out and require the login gate. Treat it as a destructive session mutation and restore test state afterward.

## Gotchas

- Tokens and account identifiers are secrets. Redact them from proof.
- Reset browser profile and sign-out are destructive to the isolated account/session state.
- Some themes force a display mode, so mode controls can be locked by design.
- Cloud Home availability depends on account and backend configuration.

# Mobile account and pairing

Mobile account settings expose identity, desktop pairing, Cloud Home, cloud-browser reset, appearance, theme, plan, and sign-out behavior.

## Sub-features

- `mobile-account` shows current identity and account actions.
- `mobile-pairing` links the phone with a Stella desktop session.
- `mobile-cloud-home` configures cloud memory/home behavior.
- `mobile-appearance` changes mode, theme, and gradient preferences.
- `mobile-sign-out` returns to the auth gate.

## How to get to it (user POV)

- Open Account from the main mobile navigation.
- Choose the phone/desktop pairing entry and follow the displayed code or scan flow.
- Open Cloud Home, browser, appearance, plan, or sign-out rows from Account.

## Driving it with control-stella-ios

Preconditions:

- The app is authenticated on a booted simulator.
- Pairing needs a separate visible desktop session and must not reuse a production one without permission.

- **Account.** Capture the Account frame and require identity plus settings sections.
- **Appearance.** Select a mode or theme, navigate away, return, and require the selected value and visual theme to persist.
- **Cloud Home/browser.** Open the row and require its current enabled, unavailable, or error state. Confirm before any destructive browser-profile reset.
- **Pairing.** Open the pairing flow, capture both endpoints without secrets, and complete only with a verifier-owned desktop session.
- **Sign out.** If explicitly in scope, sign out and require the login gate. Treat it as a destructive session mutation and restore test state afterward.

## Gotchas

- Pairing codes, tokens, and account identifiers are secrets. Redact them from proof.
- Reset browser profile and sign-out are destructive to the isolated account/session state.
- Some themes force a display mode, so mode controls can be locked by design.
- Cloud Home availability depends on account and backend configuration.

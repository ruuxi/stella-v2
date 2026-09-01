# Mobile shell and authentication

The mobile shell gates users through startup, authentication, and onboarding before exposing the main tab/navigation structure.

## Sub-features

- `mobile-startup` resolves splash, stored theme, session, and initial route.
- `mobile-login` accepts supported sign-in flows and visible failures.
- `mobile-onboarding` steps through required first-run choices.
- `mobile-navigation` exposes chat, search, account, and other main destinations.

## How to get to it (user POV)

- Launch Stella from the iPhone Simulator home screen.
- Sign in from the login screen when no valid session exists.
- Complete onboarding after first authentication.
- Use the main navigation after the auth gate resolves.

## Driving it with control-stella-ios

Preconditions:

- Complete `control-stella-ios.sh doctor`, `stage`, `boot`, and the Expo build/launch recipe in [iOS](./ios.md).
- A sign-in test needs an approved test account and reachable auth service.

- **Startup.** Capture `frame` immediately after launch and again after settling. Require splash to resolve to login, onboarding, or main shell.
- **Login.** With `screen_input=yes`, capture `screen`, inspect coordinates, enter test credentials, submit once, and recapture `frame`.
- **Onboarding.** Advance one visible step at a time, recapturing after every transition. Require the final action to reach the main shell.
- **Navigation.** Tap each visible main destination from fresh inspected coordinates and capture its selected state.
- **Logs.** Use `control-stella-ios.sh logs` after a blank screen, redirect loop, or native crash.

## Gotchas

- Stored session and onboarding state change the initial route.
- Never put credentials in artifacts, shell history, or copied logs.
- OAuth/browser sheets and keyboard presentation can change screen coordinates.
- Simulator cannot prove device-only auth methods or hardware behavior.

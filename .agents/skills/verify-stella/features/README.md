# Stella Feature Map

This is the maintained map of Stella's user-visible desktop and iOS surfaces. Read the relevant feature file before driving the app. Commands use the agent-friendly desktop control utility at `.agents/skills/verify-stella/control-stella.mjs`; the compatibility wrapper under `scripts/` is not the canonical entry point.

## Desktop baseline

- Launch only with `node .agents/skills/verify-stella/control-stella.mjs session launch` and require `session doctor` to report healthy.
- Use the isolated run data and Chromium profile created by the helper. Never attach to the developer's Stella window or `~/.stella`.
- Start a recipe with no dialog or popover open. Use `drive press --key Escape` to dismiss transient UI.
- Prefer named journeys such as `settings open` and `apps open`. Use `drive`, `inspect`, and `diagnostics` commands when the map calls for a lower-level action.
- Store ARIA snapshots and screenshots under `.agents/skills/verify-stella/artifacts/<feature>/`.

## iOS baseline

- Use the existing `stella-mac` SSH alias and `.agents/skills/verify-stella/scripts/control-stella-ios.sh` from a local Linux session.
- Stage the Linux working tree into the helper-owned disposable Mac directory. Do not modify or reset the developer's Mac checkout.
- Simulator screenshots and observable app state are proof. A successful Expo build alone is not proof.
- Prefer the project-scoped XcodeBuildMCP tools for accessibility snapshots and semantic input. Run `snapshot_ui` before acting, target only refs from the current snapshot, and refresh after navigation or layout changes.
- Use coordinate input only as a fallback after a fresh whole-screen capture confirms the Simulator window and `doctor` reports `screen_input=yes`.

## Proof contract

- Prove the user entry point and the resulting visible state. Do not substitute an internal setter or raw database mutation.
- Pair a screenshot with an accessibility snapshot where the platform supports it.
- For mutations, read the result back from a second user-visible state or the isolated persisted data.
- Report blocked paths with the exact command and missing prerequisite. Authentication, provider credentials, entitlements, hardware, and remote cloud state are valid blockers.
- Cleanup only resources the verifier owns. Preserve artifacts.

## Desktop features

- [Chat](./chat.md) covers conversation readiness, new chats, drafting, and sending.
- [Rich chat](./chat-rich.md) covers attachments, context, model selection, voice, queued sends, message actions, and artifacts.
- [Home](./home.md) covers the full-body Home overlay and its composer-driven exit.
- [Conversation history](./conversation-history.md) covers the cloud-backed history popover and selection.
- [Workspace display](./workspace-display.md) covers right-side tabs, top-bar controls, visibility, and close behavior.
- [Quick chat](./quick-chat.md) covers the isolated sidebar conversation launched from New tab.
- [Files and viewers](./files-and-viewers.md) covers Files navigation and file-preview tabs.
- [Browser and takeover](./browser-and-takeover.md) covers browser tabs and cloud-browser user intervention.
- [Apps](./apps.md) covers empty, loading, populated, runtime, error, and cloud app states.
- [Settings](./settings.md) covers entry points, tabs, global search, and dismissal.
- [Account, models, and billing](./account-models-billing.md) covers account menus, execution target, model selection, usage, and billing entry points.

## iOS features

- [iOS verification infrastructure](./ios.md) covers SSH, staging, Expo builds, Simulator control, evidence, and cleanup.
- [Mobile shell and authentication](./mobile-shell-auth.md) covers startup gates, sign-in, onboarding, and main navigation.
- [Mobile chat](./mobile-chat.md) covers thread selection, composer behavior, messages, artifacts, and browser intervention cards.
- [Mobile account and pairing](./mobile-account-pairing.md) covers account settings, desktop pairing, Cloud Home, appearance, and sign-out.
- [Mobile sharing and notifications](./mobile-share-and-notifications.md) covers share intake, deep links, notifications, and OS share output.

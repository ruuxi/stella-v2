# Stella Feature Map

These notes describe Stella's desktop and iOS surfaces, entry points, and non-obvious dependencies. Consult the notes relevant to the behavior being verified; there is no requirement to read or exercise every linked surface.

The [verification skill](../SKILL.md) defines evidence and isolation boundaries. Driving sections are examples to adapt, not mandatory sequences or exhaustive acceptance criteria. Their expected states describe those examples; choose coverage from the requested behavior, current source, and observed app state.

The [desktop reference](../references/desktop.md) covers harness setup and diagnostics. The [iOS infrastructure reference](ios.md) covers SSH, disposable source staging, and Simulator control. Keep environment and resource-ownership requirements when adapting an example.

## Desktop features

- [Chat](./chat.md) covers conversation readiness, new chats, drafting, and sending.
- [Rich chat](./chat-rich.md) covers attachments, context, model selection, voice, queued sends, message actions, and artifacts.
- [Home](./home.md) covers the full-body Home overlay and its composer-driven exit.
- [Conversation history](./conversation-history.md) covers the cloud-backed history popover and selection.
- [Workspace display](./workspace-display.md) covers right-side tabs, top-bar controls, visibility, and close behavior.
- [Quick chat](./quick-chat.md) covers the isolated sidebar conversation launched from New tab.
- [Files and viewers](./files-and-viewers.md) covers Files navigation and file-preview tabs.
- [Browser and takeover](./browser-and-takeover.md) covers browser tabs and cloud-browser user intervention.
- [Agent cursor and computer use](./agent-cursor-and-computer-use.md) covers synchronized pointer presentation in browser and native computer-use actions.
- [Apps](./apps.md) covers empty, loading, populated, runtime, error, and cloud app states.
- [Settings](./settings.md) covers entry points, tabs, global search, and dismissal.
- [Desktop companion](./companion.md) covers the floating mark: toggle, hover arc, mini composer, bubbles, drag, and shortcut dictation.
- [Account, models, and billing](./account-models-billing.md) covers account menus, execution target, model selection, usage, and billing entry points.

## iOS features

- [iOS verification infrastructure](./ios.md) covers SSH, staging, Expo builds, Simulator control, evidence, and cleanup.
- [Mobile shell and authentication](./mobile-shell-auth.md) covers startup gates, sign-in, onboarding, and main navigation.
- [Mobile chat](./mobile-chat.md) covers thread selection, composer behavior, messages, artifacts, and browser intervention cards.
- [Mobile account and pairing](./mobile-account-pairing.md) covers account settings, desktop pairing, Cloud Home, appearance, and sign-out.
- [Mobile sharing and notifications](./mobile-share-and-notifications.md) covers share intake, deep links, notifications, and OS share output.

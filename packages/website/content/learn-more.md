# Learn More

This document is the source copy for the public Stella Learn More page. It replaces the old How It Works page and folds the old What's New page into one docs-style page.

## Verification Goal

Every public claim on this page should be checked against the current Stella monorepo, not memory alone.

- Website scope: `packages/website`
- Desktop scope: `packages/desktop` and `packages/desktop-ui`
- Runtime scope: `packages/runtime`
- Backend scope: `packages/backend`
- Mobile scope: `packages/mobile`

## Verified Facts

- Stella is a personal AI assistant available in the browser, desktop app, and mobile app.
- The launcher downloads the current desktop release archive and native helpers, writes the local environment file and launch script, installs what is needed, initializes the local repo state, and starts the desktop with `bun run electron:dev`.
- The installed desktop is a local repo-style runtime that can be edited, updated, and repaired.
- Stella has a single main chat surface. The orchestrator keeps the conversation going and delegates work to specialized agents instead of making the user manage many threads.
- Stella can use the computer, browser, files, Office-style documents, PDFs, spreadsheets, generated media, schedules, voice, dictation, connected apps, and local or managed models.
- Stella can change its own UI and behavior when the user asks. Renderer changes go through Vite HMR where possible, with a morph cover over visible refreshes. Deeper changes may require a reload or relaunch.
- Stella's managed model provider routes prompts and responses through Stella infrastructure and third-party providers. Stella does not intentionally retain provider request content as a model-training product, but may temporarily buffer responses and retains usage metadata for billing, limits, security, and reliability. Providers may retain submitted data under their own policies and configurations.
- BYOK and local model paths avoid the Stella managed model proxy for those model calls. Local credentials are stored locally in encrypted form.
- Anonymous managed-model usage is limited server-side with a salted hash of a device or client identifier plus request counts. Current retention for that anonymous usage row is seven days from last use.
- The mobile app works without a paired computer. Pairing enables tasks on that computer.

## Public Page Copy

### Hero

# Learn More

Stella is your personal AI assistant, available in your browser, desktop app, and mobile app. Ask once, keep talking, and Stella figures out which agent, app, file, browser, model, or tool should handle the work.

The unusual part is not just that Stella can use your computer. It is that the desktop app itself can change. Stella can learn your preferences, adjust the interface, add workflows, and turn the app into something closer to your own operating space.

### What Stella Is

Use Stella in your browser, on desktop, or on mobile. It works with your files, apps, and browser to help you get things done.

You can use Stella for normal assistant work: research, writing, spreadsheets, PDFs, Word documents, browser tasks, computer control, image generation, video and 3D workflows, media prompts, scheduling, reminders, dictation, realtime voice, and connected apps. Those capabilities are table stakes now. Stella's bigger bet is that all of this belongs in one personal assistant, one chat, and one interface that can keep adapting.

### One Chat, Many Agents

Most agent products make you choose a mode, start a new thread, pick a specialist, then remember where everything went. Stella is built around one continuous chat. You keep talking in the same place.

Behind the scenes, Stella can split work into smaller jobs, run specialized agents, keep track of active threads, and bring the result back into the conversation. The point is that you should not have to become a project manager for your assistant. Pro is designed for heavier multi-agent workflows.

### What Stella Can Do

**Use your computer.** Stella can inspect your screen, click, type, open apps, navigate windows, and work with what is actually in front of you.

**Use the web.** Stella can browse, search, read pages, fill forms, and use browser context when it helps.

**Work with files.** Stella can read, write, organize, summarize, and transform local files, including documents, spreadsheets, PDFs, presentations, images, and generated outputs.

**Create media.** Stella can help make images, videos, audio, 3D assets, small apps, games, mockups, and visual artifacts. Generated work opens in the display sidebar instead of cluttering the chat. Image, video, 3D, and voice generation come with the Pro plan.

**Listen and speak.** Stella supports in-app dictation, OS-wide dictation, read-aloud, and realtime voice. Wake-word style voice activation is optional, not a requirement. Dictation and wake word are available on every tier; read-aloud and realtime voice come with the Pro plan.

**Run routines.** Stella can create reminders, recurring check-ins, scheduled work, and local automations from plain English.

**Connect apps.** Stella can connect to services where supported, including the Stella mobile app, Google Workspace, and Store-backed integrations.

**Use the model you want.** You can use Stella's managed model provider for convenience, bring your own provider keys, use local models, use OpenRouter-style model choices where supported, or select Claude Code as the engine for the assistant runtime.

### Ways To Reach Stella

**Full desktop window.** The main Stella app has chat, display, settings, history, Store, media, files, and everything else in one place.

**Quick access.** Stella has desktop entry points for capture, chat, add-context, and voice so you can bring Stella into the app or page you are already using.

**Mini window.** A smaller Stella surface can stay nearby for quick asks without taking over your screen.

**Voice and dictation.** You can dictate into Stella or, when enabled, into other apps. Realtime voice is for talking to Stella in a live back-and-forth.

**Browser.** Open Stella in your browser to chat, start tasks, and work with files. No installation needed.

**Mobile app.** Use Stella from your phone without a paired computer. Connect the desktop app for tasks on that computer.

### Privacy

Read the Privacy Policy for details on how Stella handles your information and the choices available to you.

### Models And Providers

Stella has two model paths.

The managed path is Stella Provider, so you can install the app and use supported models without setting up provider accounts. Requests pass through Stella's infrastructure and third-party providers. Stella may temporarily buffer response data for streaming recovery, and providers may retain submitted data under their own policies and configurations.

The provider-control path is bring your own provider or local models. You can add your own provider credentials, use local runtimes, and use Claude Code directly as the assistant engine. Direct provider requests remain subject to that provider's data practices.

### The Technical Install Model

Stella ships through a launcher. The launcher is the installed wrapper that handles setup, updates, recovery, and startup.

The desktop app itself is a local runtime. The launcher downloads the platform desktop release archive and native helpers, writes `.env.local`, creates a launch script, installs dependencies as needed, initializes the local Git state, and launches the desktop with `bun run electron:dev`.

That is intentional. Stella can update itself while keeping local changes and recovery paths available when a self-change goes wrong.

### How Self-Change Works

When you ask Stella to change the app, an agent edits the local desktop code. Stella tracks the files involved, pauses or coordinates live updates, then applies the visible change through Vite HMR when possible.

If the change affects normal renderer code, Stella can often update the UI in place. If the change affects routes, shell structure, config, dependencies, native helpers, or deeper runtime code, Stella may need a reload or relaunch.

The morph overlay is the visual cover for this. It captures and covers the app while the new UI settles, then reveals the result so the change feels intentional rather than like a broken refresh.

If a self-change breaks startup, the launcher can show a recovery view and, when the latest commit is an agent-authored self-change, offer an undo path.

### What's New

#### The desktop app feels more like one continuous workspace

Recent updates cleaned up the chat surface, activity history, display sidebar, canvas previews, model picker, settings, Store, and embedded web views. The experience is moving away from scattered panes and toward one continuous desktop workspace.

#### Stella can reach more places

Mobile pairing, push updates, Google sign-in, Google Workspace connections, native integrations, and Store-backed integrations have all been expanded. The goal is to make Stella reachable from your desktop, phone, and the apps you already use without turning those apps into the source of truth.

#### Voice, dictation, and media got stronger

Stella added read-aloud, realtime voice options, OS-wide dictation polish, generated image galleries, music generation, video/model updates, and better media previews in the display sidebar.

#### The app can change itself with less disruption

Self-mod updates, HMR handling, morph transitions, update checks, launcher recovery, and undo paths have all been tightened so Stella can change without making the app feel fragile.

#### Privacy and billing moved into clearer boundaries


#### Model choice got more practical

Stella now has a simpler composer model picker for normal use, more detailed model settings for advanced users, Stella managed defaults, bring-your-own provider options, local model support, OpenRouter-style inventory where supported, and Claude Code as an engine option.

### Short Positioning

Stella is your personal AI assistant in your browser, desktop app, and mobile app. Keep one conversation while background agents handle the work.

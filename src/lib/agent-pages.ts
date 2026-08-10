// Markdown ("for agents") variants of the public Stella pages.
//
// Every indexable page has a `<route>.md` twin (the homepage lives at
// `/index.md`) so agents and LLMs can read clean, chrome-free copy instead of
// scraping the rendered React. The Store is intentionally excluded — it is a
// live catalog, not a static document.
//
// Marketing copy is authored here as plain markdown that mirrors the JSX pages.
// Dynamic pages reuse their real source of truth: `/learn-more/whats-new.md`
// is built from `changelogEntries`, and the legal pages render the same text
// the HTML pages do (`@/lib/legal-text`).

import { changelogEntries } from "@/app/learn-more/changelog-entries";
import {
  LEGAL_TITLES,
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
} from "@/lib/legal-text";
import { getSiteUrl } from "@/lib/site-url";

const MARKDOWN_HEADERS: HeadersInit = {
  "Content-Type": "text/markdown; charset=utf-8",
  // Match the other static text routes: cache hard at the edge, revalidate on deploy.
  "Cache-Control":
    "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
};

/** Build a `Response` for a markdown body with the shared headers. */
export function markdownResponse(body: string): Response {
  return new Response(body, { status: 200, headers: MARKDOWN_HEADERS });
}

/** Absolute URL for a site path (stella.sh in prod, localhost in dev). */
function abs(path: string): string {
  return new URL(path, getSiteUrl()).href;
}

/** Standard doc header: H1 + a note pointing back to the canonical HTML page. */
function header(title: string, route: string, ...taglines: string[]): string {
  const lines = [`# ${title}`, "", `> Markdown version of ${abs(route)} for agents and LLMs.`];
  for (const tagline of taglines) lines.push(`> ${tagline}`);
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  Home — /index.md                                                   */
/* ------------------------------------------------------------------ */

const HOME_MD = `${header(
  "Stella — your personal assistant",
  "/",
  "Give Stella a task and keep moving. It can work with your computer, browser, files, and apps while your work stays local.",
)}
Stella is your personal AI assistant that lives on your computer. It can work
with your files, browser, apps, and media, and it keeps separate projects in
focused chats you can return to at any time.

## One assistant, separate chats
Keep related work together, open a new chat when the context changes, and let
background tasks keep running while you move on.

## Stella can drive your computer
Keep working in one window while Stella moves through another — clicking,
typing, and finishing real tasks in your actual apps.

## Text Stella
Text Stella from iMessage, Telegram, Discord, or the mobile app. Every message
reaches the same assistant on your computer.

## Files are first-class work
Ask once. Stella creates editable reports, spreadsheets, decks, and PDFs ready
for the apps you already use (Word, Excel, PowerPoint, PDF).

## Private and open source
Stella runs locally, stays open source, and works with your agents, providers,
keys, and models.

- **Runs on your machine** — Your chats and files stay on your device. Nothing is stored on our servers.
- **Open source** — Apache-2.0, end to end. Read every line, fork it, and make it your own.
- **Bring your own** — Your harness, your provider, your keys, your model. No lock-in, ever.

Agents & harnesses: Claude Code, Codex, Cursor, OpenClaw, Hermes Agent.
Models & providers: OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot AI.

Source: https://github.com/ruuxi/stella-v2

## Explore
- Learn More: ${abs("/learn-more.md")}
- Agents: ${abs("/agents.md")}
- Voice: ${abs("/voice.md")}
- Storage: ${abs("/storage.md")}
- Pricing: ${abs("/pricing.md")}
- What's New: ${abs("/learn-more/whats-new.md")}
`;

/* ------------------------------------------------------------------ */
/*  Agents — /agents.md                                                */
/* ------------------------------------------------------------------ */

const AGENTS_MD = `${header(
  "Agents — one Stella, a whole team behind her",
  "/agents",
  "You talk to one assistant. Behind the scenes she hands work to a team of helpers that run in the background.",
)}
## You only ever talk to Stella
No juggling a dozen bots. Each chat has one assistant. Everything you ask goes
to Stella, and she figures out who should do what — you see the work and its
progress inline.

## She hands the work to helpers
Instead of doing everything herself, Stella spins up little helpers for each job
and sets them loose. Each one tackles its own task, then reports back to her
when it's done.

## Keep chatting while the work runs
When Stella sends off a task, she doesn't sit and wait — and neither do you.
Lots of jobs can run at the same time, and Stella tells you the moment each one
is finished.

## Nothing to set up — or bring your own
Out of the box, Stella runs on her own models. No keys, no accounts, no setup —
just open the app and go. Prefer something else? Plug in Claude, Codex, Cursor,
or your own key and Stella runs on that instead.

## Pictures, voice, and more — on Pro
Ask Stella to make an image, a video, a song, or a spoken reading, and she just
does it. It runs on the house models with nothing extra to wire up, and it
comes with the Pro plan.

## Ask once. Let the team handle the rest
You get the simplicity of a single assistant with the muscle of a whole crew
working in the background — on your models or hers. Orchestrator mode, where
Stella runs that crew in parallel, comes with Pro; Free and Go run a single
agent. See ${abs("/pricing.md")}.
`;

/* ------------------------------------------------------------------ */
/*  Voice — /voice.md                                                  */
/* ------------------------------------------------------------------ */

const VOICE_MD = `${header(
  "Voice — talk to Stella out loud",
  "/voice",
  "Speak instead of type, or just say \u201cHey Stella.\u201d Your words turn into text the moment you stop talking.",
)}
## Your voice becomes text instantly
Press the key and talk. On a modern Mac it all happens right on your computer,
so your words show up the moment you finish — fast, and even when you're
offline.

## Talk to type in any app
Dictation isn't just for Stella. Use it in any app on your computer and the
words drop straight into whatever you're typing — email, notes, chat, anywhere.

## It works on every computer
No modern Mac? No problem. On other computers your voice is turned into text in
the cloud, so dictation feels the same everywhere — Windows and Mac alike.

## Just say "Hey Stella"
Flip on the wake word and start talking with no clicking and no keyboard. It
listens for "Hey Stella" right on your computer, stays off until you turn it on,
and steps back the moment you say "bye."

## Have a real conversation
Talk back and forth like a phone call. Stella hears you in real time, answers
out loud, and can even take a look at your screen when you ask her to.

Live conversation and having Stella read her replies aloud come with the Pro
plan. Dictation and "Hey Stella" are on every tier, including Free — turning
your speech into text is never gated. See ${abs("/pricing.md")}.
`;

/* ------------------------------------------------------------------ */
/*  Storage — /storage.md                                              */
/* ------------------------------------------------------------------ */

const STORAGE_MD = `${header(
  "Storage — your stuff stays on your computer",
  "/storage",
  "Stella keeps your conversations on your own machine, not on our servers. Only the things you choose to send ever leave.",
)}
## Your conversations live on your laptop
Every chat is saved in a single file on your computer. We can't read it, because
it never reaches us. The only time your words go out is to the AI that writes
the reply.

## Backups stay off until you ask
If you ever want a safety copy, you can turn backups on. They get locked tight
before they leave your computer, and they come with a paid plan — so nothing is
ever backed up unless you opt in.

## Messages run through your own machine
Connect Stella to your texts or chat apps and the work happens on your computer
— it reads the message, does the task, and sends the reply. A message only
passes through us long enough to find your machine, and phone numbers are always
scrambled, never kept as-is.

## Your phone talks straight to your desktop
Use the app to drive your computer from anywhere. It connects right to your
desktop through a private tunnel — we only keep track of which devices are
paired, never what you say.

## The only things that leave are the ones you send
Publishing an app to the Store or posting in the community are the moments you
choose to share. When you publish, we get a tidied-up app — not your private
chats. Posts you make are public, like any message board.

## Private because it's on your machine
No cloud database of your life, nothing kept on our servers by default. Your
data is yours — on your computer, where you can open it, read it, and delete it
whenever you want.
`;

/* ------------------------------------------------------------------ */
/*  Pricing — /pricing.md                                              */
/* ------------------------------------------------------------------ */

const PRICING_MD = `${header(
  "Pricing — simple, transparent pricing",
  "/pricing",
  "Free is a taste. Go is where the usage gets generous. Pro is a different product — the tier that can generate image, video, 3D, and voice, and run a whole team of agents at once.",
)}
## Plans
- **Free** — $0. A one-time $0.50 of usage, not a monthly allowance: it does not refresh, and once it is used it is used. Includes the coding agent, personal assistant, and research/knowledge work, plus dictation. Text output only — no image, video, 3D, or voice generation, and no orchestrator mode.
- **Go** — $1 first month, then $5/mo. Everything in Free with dramatically higher limits: up to roughly $12 of model usage per 5 hours, ~$30 a week, and ~$60 a month, refreshing with your billing cycle. Still text output only (dictation included) — generation and orchestrator mode are on Pro.
- **Pro** — $15/mo (most popular). Everything in Go, plus image, video, 3D, and voice generation, and orchestrator mode, where Stella runs many agents at once. This is the only tier that can create media or work in parallel. Note that dictation and speech-to-text are on every tier — what Pro adds is spoken replies (read-aloud) and live voice conversation.

## Every plan includes
You are not paying for an API key. Every tier comes with the whole desktop app
— the assistant, research, the browser, your files — and usage limits that hold
their own at the price.

- Runs on your computer
- Private by default
- Coding, assistant, and research in one app
- Dictation and wake word on every tier
- Customizable interface
- Desktop and mobile access
- Bring your own models and keys

## Start with Stella for free
No credit card required. Download Stella and try it today.
`;

/* ------------------------------------------------------------------ */
/*  Learn More — /learn-more.md                                        */
/* ------------------------------------------------------------------ */

const LEARN_MORE_MD = `${header(
  "Learn More — Stella, in detail",
  "/learn-more",
)}
A private, open-source personal assistant for your computer. Ask Stella to work
with an app, file, browser, model, or tool, then keep moving while the work
runs. Chats keep different projects focused, while background agents can handle
independent work and report progress inline.

Source: https://github.com/ruuxi/stella-v2

## A desktop app, not just a chat box
Stella lives with your files, apps, browser, and local state, so it can help
with the real work on your machine instead of only answering questions in a web
tab. You can use Stella for research, writing, spreadsheets, PDFs, Word
documents, browser tasks, computer control, image generation, video and 3D
workflows, media prompts, scheduling, reminders, dictation, realtime voice, and
connected apps. Those capabilities belong in one personal desktop app, with
focused chats and a consistent interface instead of a maze of separate tools
and modes.

## Keep every project in its place
Open a chat for a project, switch instantly when your focus changes, and return
without losing your place. Stella can split work into smaller jobs, run
specialized agents, and bring their progress back into the chat. Running that
crew in parallel is orchestrator mode, which comes with the Pro plan.

## What Stella can do
- **Use your computer** — Inspect the screen, click, type, open apps, navigate windows, and work with what is actually in front of you.
- **Use the web** — Browse, search, read pages, fill forms, and use browser context when it helps.
- **Work with files** — Read, write, organize, summarize, and transform documents, spreadsheets, PDFs, presentations, images, and generated outputs.
- **Create media** — Help make images, video, audio, 3D assets, small apps, games, mockups, and visual artifacts. Image, video, 3D, and voice generation come with the Pro plan.
- **Listen and speak** — Use in-app dictation, OS-wide dictation, read-aloud, and realtime voice. Wake-word activation is optional. Dictation and wake word are on every tier; read-aloud and realtime voice come with the Pro plan.
- **Run routines** — Create reminders, recurring check-ins, scheduled work, and local automations from plain English.
- **Connect apps** — Use supported services and messaging apps, including mobile, Discord, Telegram, Slack, Teams, Linq, Google Workspace, and Store-backed integrations.
- **Choose your model** — Use Stella's managed provider, bring your own keys, use local models, pick OpenRouter-style options where supported, or select Claude Code as the engine.

## Ways to reach Stella
- **Full desktop window** — Chat, display, settings, history, Store, media, files, and everything else in one place.
- **Quick access** — Capture, chat, add context, or start voice from the app or page you are already using.
- **Mini window** — Keep a smaller Stella surface nearby for fast asks without taking over your screen.
- **Voice and dictation** — Dictate into Stella, dictate into other apps when enabled, or talk to Stella in realtime.
- **Phone** — Pair the mobile app with your desktop so your phone can message the Stella running on your computer.
- **Messaging apps** — Message Stella from supported apps. Full desktop-powered execution depends on pairing, connection settings, and your desktop being available.

## Local-first, with clear exceptions
Your normal desktop chat history, files, memories, generated local artifacts,
and app state live on your computer. We do not keep your desktop conversations
or files on our servers by default.

Some features need a backend: sign-in, billing, plan limits, managed model
access, connected app setup, mobile pairing, Store catalog data, push
notifications, and optional cloud features. The important boundary is that
Stella does not need a cloud copy of your whole desktop life to work.

### What we store
- **Account and billing records** — Sign-in identity, billing profile state, Stripe customer and subscription references, usage credit records, and payment metadata needed to run paid plans.
- **Usage metadata** — For managed model calls: owner ID, model, agent type, token counts, duration, success or failure, estimated cost, billing plan, and timestamps.
- **Anonymous limit counters** — A salted hash of the device or client identifier, request count, first request time, and last request time. Current retention is seven days after last use.
- **Device and pairing metadata** — Device IDs, device names where provided, platform, presence timestamps, mobile pairing records, pairing secret hashes, push tokens, and bridge registration URLs.
- **Connected app metadata** — The minimum connection records needed to know which account is linked to which Stella user and provider. Some connection secrets are encrypted.
- **Remote delivery state** — When you message Stella from a phone or connector, the backend may store request text, delivery metadata, request state, and routing info so the desktop can claim, cancel, complete, and deliver the work.
- **Optional cloud content** — Cloud backups, Store publishing, social or collaboration surfaces, and other hosted features store the data required to provide those features.

### What we do not store by default
- Your local desktop files.
- Your normal local desktop chat database.
- Your local memory markdown and runtime state.
- Your local provider API keys.
- A persistent copy of managed-model prompts and responses for the Stella Provider path.
- BYOK model traffic when the model call goes directly from your device to your provider.

## Use Stella, BYOK, local models, or Claude Code
Stella has a simple path for convenience and a private-control path for people
who want to bring their own providers. Stella Provider lets you install the app
and start using strong models without setting up accounts everywhere. Requests
pass through Stella's infrastructure in transit so billing and limits can work,
but prompt and response text is not persistently stored for that model path.

You can also add your own provider credentials, use local runtimes, and use
Claude Code directly as the assistant engine. In those paths, Stella is acting
as the desktop app and runtime you control, not as the model vendor.

## A packaged, local-first desktop app
Stella installs like a normal desktop app and keeps its runtime, conversations,
settings, and project state on your computer. Signed macOS packages and Windows
installers include the runtime and native helpers they need. Projects Stella
creates are ordinary local web apps under its workspace, kept separate from the
packaged application itself.

## A running changelog
Stella ships small, frequent releases. The full log, grouped by release with
highlights up top and the rest collapsed below, lives at
${abs("/learn-more/whats-new.md")}.
`;

/* ------------------------------------------------------------------ */
/*  What's New — /learn-more/whats-new.md (generated)                  */
/* ------------------------------------------------------------------ */

function renderWhatsNew(): string {
  const lines: string[] = [
    header(
      "What's New",
      "/learn-more/whats-new",
      "Every Stella release, in plain English. Each version's highlights up top, the rest tucked just below.",
    ),
  ];

  const formatItem = (
    item: string | { text: string; product: string },
  ): string => {
    if (typeof item === "string") return `- ${item}`;
    return `- [${item.product}] ${item.text}`;
  };

  for (const entry of changelogEntries) {
    const headline = entry.release ?? entry.era ?? entry.date;
    const secondary = entry.release ? ` (${entry.date})` : "";
    const tags = entry.tags?.length ? ` — ${entry.tags.join(", ")}` : "";
    lines.push(`## ${headline}${secondary}${tags}`, "");

    if (entry.highlights?.length) {
      lines.push("### Highlights");
      for (const item of entry.highlights) lines.push(formatItem(item));
      lines.push("");
    }
    if (entry.more?.length) {
      lines.push("### More in this release");
      for (const item of entry.more) lines.push(formatItem(item));
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/*  Legal — /terms.md and /privacy.md (rendered from source)          */
/* ------------------------------------------------------------------ */

function renderLegal(title: string, route: string, body: string): string {
  return `${header(title, route)}\n${body.trim()}\n`;
}

/* ------------------------------------------------------------------ */
/*  Registry + llms.txt                                               */
/* ------------------------------------------------------------------ */

export type AgentPage = {
  /** Canonical HTML route this mirrors. */
  route: string;
  /** The markdown URL served for agents. */
  mdPath: string;
  label: string;
  description: string;
  markdown: string;
};

export const AGENT_PAGES: AgentPage[] = [
  {
    route: "/",
    mdPath: "/index.md",
    label: "Home",
    description: "What Stella is and what it can do.",
    markdown: HOME_MD,
  },
  {
    route: "/learn-more",
    mdPath: "/learn-more.md",
    label: "Learn More",
    description: "Stella in detail: capabilities, access, privacy, models, and packaging.",
    markdown: LEARN_MORE_MD,
  },
  {
    route: "/pricing",
    mdPath: "/pricing.md",
    label: "Pricing",
    description: "Plans and what every plan includes.",
    markdown: PRICING_MD,
  },
  {
    route: "/agents",
    mdPath: "/agents.md",
    label: "Agents",
    description: "One assistant that delegates to background helpers.",
    markdown: AGENTS_MD,
  },
  {
    route: "/voice",
    mdPath: "/voice.md",
    label: "Voice",
    description: "Dictation, wake word, and live voice conversation.",
    markdown: VOICE_MD,
  },
  {
    route: "/storage",
    mdPath: "/storage.md",
    label: "Storage",
    description: "Where your data lives and what leaves your machine.",
    markdown: STORAGE_MD,
  },
  {
    route: "/learn-more/whats-new",
    mdPath: "/learn-more/whats-new.md",
    label: "What's New",
    description: "Running changelog, newest first.",
    markdown: renderWhatsNew(),
  },
  {
    route: "/privacy",
    mdPath: "/privacy.md",
    label: "Privacy Policy",
    description: "How FromYou LLC handles information.",
    markdown: renderLegal(LEGAL_TITLES.privacy, "/privacy", PRIVACY_POLICY),
  },
  {
    route: "/terms",
    mdPath: "/terms.md",
    label: "Terms of Service",
    description: "Terms governing your use of Stella.",
    markdown: renderLegal(LEGAL_TITLES.terms, "/terms", TERMS_OF_SERVICE),
  },
];

/** llms.txt index so agents can discover every markdown page in one fetch. */
export function renderLlmsTxt(): string {
  const lines = [
    "# Stella",
    "",
    "> Stella is a private, open-source desktop AI assistant. Focused chats",
    "> organize work across your computer, files, browser, apps, and media.",
    "> Everything stays on your machine by",
    "> default. Each page below has a clean markdown version for agents.",
    "",
    "## Pages",
  ];
  for (const page of AGENT_PAGES) {
    lines.push(`- [${page.label}](${abs(page.mdPath)}): ${page.description}`);
  }
  lines.push("", "## Source", "- [GitHub](https://github.com/ruuxi/stella-v2)");
  return `${lines.join("\n")}\n`;
}

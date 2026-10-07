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
  const lines = [
    `# ${title}`,
    "",
    `> Markdown version of ${abs(route)} for agents and LLMs.`,
  ];
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
  "Give Stella a task and keep moving. It can work with your computer, browser, files, and apps.",
)}
Stella is your personal AI assistant, available in your browser, desktop app,
and mobile app. Keep one ongoing conversation while Stella routes work to
background agents and tools.

## One chat for everything
No more juggling threads. Fire off a plan, a file, a message, and a background
task at once — they all flow into the same conversation and come back together.

## Stella can drive your computer
Keep working in one window while Stella moves through another — clicking,
typing, and finishing real tasks in your actual apps.

## Text Stella
Take Stella with you. Chat and keep up with your tasks from the mobile app,
wherever you are.

## Files are first-class work
Ask once. Stella creates editable reports, spreadsheets, decks, and PDFs ready
for the apps you already use (Word, Excel, PowerPoint, PDF).

## Choose your tools
Work with your preferred agents, providers, keys, and models.

Agents & harnesses: Claude Code, Codex, Cursor, OpenClaw, Hermes Agent.
Models & providers: OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot AI.

## Explore
- Learn More: ${abs("/learn-more.md")}
- One chat: ${abs("/one-chat.md")}
- Voice: ${abs("/voice.md")}
- Pricing: ${abs("/pricing.md")}
- What's New: ${abs("/learn-more/whats-new.md")}
`;

/* ------------------------------------------------------------------ */
/*  One chat — /one-chat.md                                            */
/* ------------------------------------------------------------------ */

const ONE_CHAT_MD = `${header(
  "One chat — everything in it",
  "/one-chat",
  "Other chat apps spread your life across a dozen threads. Stella is one ongoing conversation — ask, follow up, get results, come back tomorrow. It's all right here.",
)}
## Everything you ask lives in one place
Most chatbots want a fresh thread for every question, so your history ends up
scattered and the context goes with it. In Stella there's just one
conversation. The trip you planned last week, the email from this morning, the
thing you're about to ask — same place, same Stella.

## Work runs in the background. Your chat stays open
Ask for something big and Stella gets going on it without freezing the
conversation. Keep typing, ask something else, step away — she brings the
result back into the same chat the moment it's ready.

## No threads. So nothing falls between them
There's no hunting for the chat where you asked that thing. Follow-ups,
results, reminders, and scheduled work all land in the one conversation you
already have — with the context still intact.

## Nothing to set up — or bring your own
Out of the box, Stella runs on her own models. No keys, no accounts, no setup —
just open the app and go. Prefer something else? Plug in Claude, Codex, Cursor,
or your own key and Stella runs on that instead.

## Pictures, voice, and more — on Pro
Ask Stella to make an image, a video, a song, or a spoken reading, and she just
does it. It runs on the house models with nothing extra to wire up, and it
comes with the Pro plan.

## Ask once. Keep talking
One ongoing chat, with the work happening behind it — on Stella's models or
yours. Running several jobs at once in the background comes with Pro; other
plans work through one at a time. See ${abs("/pricing.md")}.
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
Start dictation and talk. Your words appear in the composer as you speak.

## Talk to type in any app
Dictation isn't just for Stella. Use it in any app on your computer and the
words drop straight into whatever you're typing — email, notes, chat, anywhere.

## It works on every computer
Use dictation in the desktop app on Windows and Mac.

## Just say "Hey Stella"
Flip on the wake word and start talking with no clicking and no keyboard. It
listens for "Hey Stella" right on your computer, stays off until you turn it on,
and steps back the moment you say "bye."

## Have a real conversation
Talk back and forth like a phone call. Stella hears you in real time, answers
out loud, and can even take a look at your screen when you ask her to.

Live conversation and having Stella read her replies aloud come with the Pro
plan. Dictation and "Hey Stella" are on every tier — turning
your speech into text is never gated. See ${abs("/pricing.md")}.
`;

/* ------------------------------------------------------------------ */
/*  Pricing — /pricing.md                                              */
/* ------------------------------------------------------------------ */

const PRICING_MD = `${header(
  "Pricing — choose your plan",
  "/pricing",
  "Pick the usage and capabilities you need.",
)}
## Plans
- **Free** — $0. No credit card, no trial. Includes the coding agent, personal assistant, research and knowledge work, dictation, and read-aloud.
- **Go** — $5/mo. 10× higher usage. Includes coding, assistant and research features, dictation, and read-aloud.
- **Pro** — $15/mo. The highest usage limits, image, video, 3D and voice generation, and multiple agents working together.

## Every plan includes
Every tier includes browser, desktop, and mobile access, with different usage limits.

- Browser, desktop, and mobile access
- Coding, assistant, and research in one app
- Dictation and wake word on every tier
- Customizable interface
- Work with files and apps
- Bring your own models and keys

## Choose Stella and get started
Free. No credit card, no trial. Download Stella and try it today.
`;

/* ------------------------------------------------------------------ */
/*  Learn More — /learn-more.md                                        */
/* ------------------------------------------------------------------ */

const LEARN_MORE_MD = `${header(
  "Learn More — Stella, in detail",
  "/learn-more",
)}
Your personal AI assistant, available in your browser, desktop app, and mobile app. Ask once, keep
talking, and Stella figures out which agent, app, file,
browser, model, or tool should handle the work. Background agents can handle
independent work and report progress inline without making you manage separate
threads.

## One assistant, wherever you are
Stella works with your files, apps, and browser to help you get things done. You can use Stella for research, writing, spreadsheets, PDFs, Word
documents, browser tasks, computer control, image generation, video and 3D
workflows, media prompts, scheduling, reminders, dictation, realtime voice, and
connected apps. Keep your work in one conversation, whether you use Stella in your browser,
on your desktop, or on your phone.

## You keep talking in the same place
Most agent products make you choose a mode, start a new thread, pick a
specialist, then remember where everything went. Stella keeps the top-level
experience continuous. Behind the scenes, it can split work into smaller jobs,
run specialized agents, keep track of active threads, and bring the result back
into the conversation. Orchestrator mode is the default, so you stay in one
conversation instead of becoming the project manager for your assistant.

## What Stella can do
- **Use your computer** — Inspect the screen, click, type, open apps, navigate windows, and work with what is actually in front of you.
- **Use the web** — Browse, search, read pages, fill forms, and use browser context when it helps.
- **Work with files** — Read, write, organize, summarize, and transform documents, spreadsheets, PDFs, presentations, images, and generated outputs.
- **Create media** — Help make images, video, audio, 3D assets, small apps, games, mockups, and visual artifacts. Image, video, 3D, and voice generation come with the Pro plan.
- **Listen and speak** — Use in-app dictation, OS-wide dictation, read-aloud, and realtime voice. Wake-word activation is optional. Dictation and wake word are on every tier; read-aloud and realtime voice come with the Pro plan.
- **Run routines** — Create reminders, recurring check-ins, scheduled work, and automations from plain English.
- **Connect apps** — Use supported services, including the Stella mobile app, Google Workspace, and Store-backed integrations.
- **Choose your model** — Use Stella's managed provider, bring your own keys, use local models, pick OpenRouter-style options where supported, or select Claude Code as the engine.

## Ways to reach Stella
- **Browser** — Open Stella in your browser to chat, start tasks, and work with files. No installation needed.
- **Desktop app** — Use Stella on macOS, Windows, or Linux, with access to your computer and desktop apps.
- **Mobile app** — Chat and manage tasks from your phone. Connect the desktop app when you want Stella to work on that computer.
- **Quick access on desktop** — Capture, chat, add context, or start voice from the app or page you are already using.
- **Mini window on desktop** — Keep a smaller Stella window nearby for quick asks without taking over your screen.
- **Voice and dictation** — Dictate into Stella or talk in realtime. The desktop app also supports dictation into other apps.

## Your privacy
Read our Privacy Policy for details on how Stella handles your information
and the choices available to you: ${abs("/privacy.md")}

## Use Stella, BYOK, local models, or Claude Code
Stella has a managed path for convenience and a provider-control path for people
who want to bring their own providers. Stella Provider lets you start using strong models without setting up accounts everywhere. Requests
pass through Stella's infrastructure in transit so billing and limits can work,
and responses may be buffered briefly to support stream recovery. The model
providers that fulfill requests may process and retain submitted data under
their own policies and Stella's configuration.

You can also add your own provider credentials, use local runtimes, and use
Claude Code directly as the assistant engine. Provider and engine options depend on the client you use.

## Get started
Open Stella in your browser at ${abs("/chat")}, download the desktop app, or
use the mobile app.

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
    description:
      "Stella in detail: capabilities, access, privacy, models, and packaging.",
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
    route: "/one-chat",
    mdPath: "/one-chat.md",
    label: "One chat",
    description: "One ongoing conversation: everything you ask, in one place.",
    markdown: ONE_CHAT_MD,
  },
  {
    route: "/voice",
    mdPath: "/voice.md",
    label: "Voice",
    description: "Dictation, wake word, and live voice conversation.",
    markdown: VOICE_MD,
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
    "> Stella is a personal AI assistant for browser, desktop, and mobile. One ongoing chat",
    "> coordinates work across your computer, files, browser, apps, and media.",
    "> Each page below has a clean markdown version for agents.",
    "",
    "## Pages",
  ];
  for (const page of AGENT_PAGES) {
    lines.push(`- [${page.label}](${abs(page.mdPath)}): ${page.description}`);
  }
  return `${lines.join("\n")}\n`;
}

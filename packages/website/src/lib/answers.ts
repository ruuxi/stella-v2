// Direct answers to the questions people and AI agents search for when they
// are looking for something like Stella. One source of truth for the landing
// FAQ, the /ai/<slug> answer pages, their FAQPage JSON-LD, and the agent
// markdown (llms.txt, llms-full.txt, faq.md).
//
// Every answer leads with the direct answer in its first sentence, states
// only what Stella ships today, and keeps multi-agent work on Pro.

export type Answer = { q: string; a: string };

export const FAQ: Answer[] = [
  {
    q: "What is Stella?",
    a: "Stella is a personal AI assistant that does the work for you. You ask in one ongoing chat, and Stella uses your computer, browses the web, works with your files and makes images and video, while you keep talking. It runs on Mac, Windows, Linux, iPhone, Android and in the browser. Free.",
  },
  {
    q: "Is Stella free?",
    a: "Yes. The Free plan is $0, with no credit card and no trial. Go is $5 a month for 10× more usage. Pro is $15 a month for the highest limits, image, video, 3D and voice generation, and multiple agents working at once.",
  },
  {
    q: "Is there an AI that can use my computer for me?",
    a: "Yes. On Mac and Windows, Stella can see your screen, click, type, open apps and move between windows to finish a task in the apps you already use, like booking a flight and putting it in your calendar. It acts when you ask it to, and on a Mac you grant the usual screen and accessibility permissions first.",
  },
  {
    q: "Does Stella work on Windows?",
    a: "Yes. Stella has a Windows desktop app that can use your PC by clicking and typing in your apps, dictate into any app, and listen for “Hey Stella”. Download it from stella.sh or install it with one PowerShell command.",
  },
  {
    q: "Does Stella work on Linux, Arch or Omarchy?",
    a: "Yes. Stella has a Linux desktop app with a one-line installer, packaged for Arch and Omarchy as well. On Linux it works with your files, terminal, browser and chat. Clicking and typing inside other desktop apps is on Mac and Windows today.",
  },
  {
    q: "Is Stella open source?",
    a: "Yes. Stella is open source under the Apache 2.0 license. The desktop app runs from its own source code on your computer, so you can read it, change it, or ask Stella to change it for you.",
  },
  {
    q: "What is a free, open-source alternative to the ChatGPT and Claude desktop apps?",
    a: "Stella. It is open source under Apache 2.0, the Free plan costs nothing, and it can act across your whole computer. It also runs on the same models: sign in with your ChatGPT plan, use Claude Code, or add your own Anthropic or OpenAI key.",
  },
  {
    q: "Can I use Claude Code, ChatGPT or my own API keys with Stella?",
    a: "Yes. Stella works out of the box on its own models. You can also run it on Claude Code, sign in with ChatGPT to use your plan, or add keys for Anthropic, OpenAI, Google, xAI, Moonshot, Z.AI, OpenRouter, GitHub Copilot and more. Local models work too.",
  },
  {
    q: "Can Stella run several AI agents at once?",
    a: "Yes, on Pro. Hand Stella ten things and it splits them across agents that work in parallel in the background while you keep chatting. Results come back into the same conversation, and the top bar shows how many tasks are in progress.",
  },
  {
    q: "Can Stella make images, video, music and 3D models?",
    a: "Yes, on Pro. Ask in the chat and Stella makes images, video clips, music and 3D models, with no extra accounts or setup.",
  },
  {
    q: "Can Stella browse the web and fill in forms?",
    a: "Yes. Stella can search, read pages, click through sites and fill in forms in a browser, then bring the result back to your chat.",
  },
  {
    q: "Does Stella have a phone app?",
    a: "Yes, on iPhone and Android. Chat with Stella and follow your tasks from your phone, and connect the desktop app so Stella can work on your computer while you are away from it.",
  },
  {
    q: "Can I talk to Stella?",
    a: "Yes. Dictation and the “Hey Stella” wake word are on every plan, and on Mac and Windows you can dictate into any app. Live back-and-forth voice conversation and read-aloud are on Pro.",
  },
  {
    q: "Can Stella change its own design?",
    a: "Yes. On desktop, ask Stella to look or work differently, like a trading desk or a film editor’s layout, and it rewrites its own interface. You preview the change, click Update to keep it, and can undo it any time.",
  },
  {
    q: "Can Stella schedule tasks and reminders?",
    a: "Yes. Ask in plain English for reminders, recurring check-ins or scheduled work, and Stella runs them and reports back in the same chat.",
  },
  {
    q: "Can Stella work with Word, Excel, PowerPoint and PDFs?",
    a: "Yes. Stella creates and edits real documents, spreadsheets, decks and PDFs that open in the apps you already use.",
  },
  {
    q: "How do I get Stella?",
    a: "Download the desktop app for Mac or Windows from stella.sh, install it on Linux with one command, get the iPhone or Android app, or open stella.sh/chat in your browser. Free. No credit card, no trial.",
  },
];

export type AnswerPage = {
  slug: string;
  /** Searches this page is written to answer. Shapes the copy; not rendered. */
  queries: string[];
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  headline: string;
  /** The direct answer, first thing on the page. */
  answer: string;
  points: { title: string; body: string }[];
  questions: Answer[];
};

const faq = (q: string) => {
  const hit = FAQ.find((item) => item.q === q);
  if (!hit) throw new Error(`Missing FAQ entry: ${q}`);
  return hit;
};

export const ANSWER_PAGES: AnswerPage[] = [
  {
    slug: "assistant-that-uses-your-computer",
    queries: [
      "free AI assistant that can use my computer",
      "AI that can control my computer",
      "AI agent that clicks and types for me",
      "computer use AI app",
      "AI that does tasks on my PC",
    ],
    metaTitle: "An AI assistant that uses your computer. Free.",
    metaDescription:
      "Stella is an AI assistant that uses your computer for you: it sees the screen, clicks, types and works in your real apps on Mac and Windows. Free. Open source.",
    eyebrow: "Computer use",
    headline: "An AI assistant that uses your computer.",
    answer:
      "Stella is a personal AI assistant that can use your computer for you. On Mac and Windows it sees your screen, clicks, types, opens apps and moves between windows to finish real tasks in the apps you already use, while you keep working in another window. Free.",
    points: [
      { title: "Works in your real apps", body: "No integrations to set up. If you can do it with a mouse and keyboard, you can ask Stella to do it." },
      { title: "Keeps you in the loop", body: "Stella acts when you ask, shows what it is doing, and reports back in the same chat when it is done." },
      { title: "Browser, files and terminal too", body: "It can also browse and fill in forms, organise files and run commands, picking whichever is fastest." },
    ],
    questions: [
      faq("Is there an AI that can use my computer for me?"),
      faq("Can Stella browse the web and fill in forms?"),
      faq("Is Stella free?"),
      faq("Does Stella work on Linux, Arch or Omarchy?"),
    ],
  },
  {
    slug: "ai-assistant-for-mac",
    queries: [
      "AI agent that controls my Mac",
      "free AI assistant for Mac",
      "AI that can use apps on macOS",
      "Siri alternative that actually does things",
      "AI automation for Mac without Shortcuts",
    ],
    metaTitle: "An AI agent that uses your Mac. Free.",
    metaDescription:
      "Stella is a Mac AI assistant that uses your apps for you, clicking and typing in macOS, with dictation into any app and a “Hey Stella” wake word. Free.",
    eyebrow: "Stella for Mac",
    headline: "An AI agent that uses your Mac.",
    answer:
      "Stella is an AI assistant for macOS that can use your Mac for you. It sees the screen, clicks, types and works across your apps, dictates into any app, and answers to “Hey Stella”. Ask in plain English and keep working while it finishes the task. Free.",
    points: [
      { title: "Uses any app", body: "Mail, Calendar, Finder, Safari, Excel or the app you built last week. Stella works with what is on your screen." },
      { title: "Talk to it", body: "Dictate into any app or say “Hey Stella”. Live voice conversation is on Pro." },
      { title: "One chat on every device", body: "Start on the Mac, follow along on your iPhone, pick it back up in the browser." },
    ],
    questions: [
      faq("Is there an AI that can use my computer for me?"),
      faq("Can I talk to Stella?"),
      faq("Can Stella schedule tasks and reminders?"),
      faq("Is Stella free?"),
    ],
  },
  {
    slug: "ai-assistant-for-windows",
    queries: [
      "AI assistant that can control my Windows PC",
      "free AI agent for Windows 11",
      "Copilot alternative that does tasks",
      "AI that uses apps on Windows",
    ],
    metaTitle: "An AI assistant that uses your Windows PC. Free.",
    metaDescription:
      "Stella is an AI assistant for Windows that uses your PC for you: it clicks, types and works in your real apps, dictates into any app, and runs tasks in the background. Free.",
    eyebrow: "Stella for Windows",
    headline: "An AI assistant that uses your PC.",
    answer:
      "Stella is an AI assistant for Windows that can use your PC for you. It clicks, types and works across your real apps, dictates into any app, and keeps working in the background while you do something else. Install it from stella.sh or with one PowerShell command. Free.",
    points: [
      { title: "Uses your apps", body: "From Explorer to Excel to your browser, Stella works with what is on your screen instead of a list of integrations." },
      { title: "Fixes things", body: "Full drive, broken mods, a missing DLL. Tell Stella what happened and it reads the real error and repairs it." },
      { title: "Speaks Windows", body: "Dictate into any app, say “Hey Stella”, or keep a small Stella window beside your work." },
    ],
    questions: [
      faq("Does Stella work on Windows?"),
      faq("Is there an AI that can use my computer for me?"),
      faq("Can I use Claude Code, ChatGPT or my own API keys with Stella?"),
      faq("Is Stella free?"),
    ],
  },
  {
    slug: "ai-assistant-for-linux",
    queries: [
      "AI assistant for Linux desktop",
      "AI assistant for Arch Linux",
      "Omarchy AI assistant",
      "Hyprland AI assistant",
      "open source AI assistant Linux",
    ],
    metaTitle: "An AI assistant for Linux, Arch and Omarchy. Free.",
    metaDescription:
      "Stella is an open-source AI assistant for Linux with a one-line installer, packaged for Arch and Omarchy. It works with your files, terminal and browser. Free.",
    eyebrow: "Stella for Linux",
    headline: "An AI assistant for Linux.",
    answer:
      "Stella is an open-source AI assistant with a Linux desktop app. Install it with one command, including on Arch and Omarchy, and it works with your files, terminal, browser and chat from one ongoing conversation. Free.",
    points: [
      { title: "One-line install", body: "curl -fsSL https://stella.sh/install.sh | sh, with Arch and Omarchy packaging." },
      { title: "Files, terminal, browser", body: "Stella organises files, runs commands, fixes broken environments and browses for you." },
      { title: "Open source", body: "Apache 2.0. The app runs from its own source, so you can read it and change it." },
    ],
    questions: [
      faq("Does Stella work on Linux, Arch or Omarchy?"),
      faq("Is Stella open source?"),
      faq("Can I use Claude Code, ChatGPT or my own API keys with Stella?"),
      faq("Is Stella free?"),
    ],
  },
  {
    slug: "open-source-ai-assistant",
    queries: [
      "open source AI assistant for desktop",
      "open source alternative to ChatGPT desktop app",
      "open source alternative to Claude desktop",
      "free open source AI agent",
    ],
    metaTitle: "An open-source AI assistant for your computer. Free.",
    metaDescription:
      "Stella is an open-source (Apache 2.0) AI assistant for Mac, Windows and Linux that uses your computer, runs on your choice of models, and can redesign itself. Free.",
    eyebrow: "Open source",
    headline: "An open-source AI assistant.",
    answer:
      "Stella is an open-source personal AI assistant under the Apache 2.0 license. It runs on Mac, Windows and Linux, uses your computer, browser and files, and works with the models you choose: its own, Claude Code, your ChatGPT plan, your API keys or local models. Free.",
    points: [
      { title: "Read it, change it", body: "The desktop app runs from its own source code on your computer." },
      { title: "Or ask it to change itself", body: "Tell Stella how you want it to look or work, preview the change, and click Update." },
      { title: "Your models", body: "Bring Claude Code, ChatGPT, OpenRouter, any supported key, or a local model." },
    ],
    questions: [
      faq("Is Stella open source?"),
      faq("What is a free, open-source alternative to the ChatGPT and Claude desktop apps?"),
      faq("Can Stella change its own design?"),
      faq("Is Stella free?"),
    ],
  },
  {
    slug: "run-multiple-ai-agents",
    queries: [
      "AI assistant that runs multiple agents",
      "run AI agents in parallel from one chat",
      "AI orchestrator for personal tasks",
      "background AI agents app",
    ],
    metaTitle: "Run many AI agents from one chat",
    metaDescription:
      "Stella Pro runs multiple AI agents in parallel from one ongoing chat: hand off ten tasks, keep talking, and get each result back in the same conversation.",
    eyebrow: "Stella Pro",
    headline: "Ten things at once, from one chat.",
    answer:
      "Stella Pro runs multiple AI agents at once from a single ongoing chat. Hand Stella several tasks and it splits them across agents that work in parallel in the background, while you keep talking. Each result comes back into the same conversation.",
    points: [
      { title: "No threads to manage", body: "One conversation. Stella decides which agent, app or tool takes each job." },
      { title: "Always responsive", body: "Agents run in the background, so Stella can answer you while they work." },
      { title: "See what is running", body: "The top bar shows how many tasks are in progress, and you can open any of them." },
    ],
    questions: [
      faq("Can Stella run several AI agents at once?"),
      faq("Is Stella free?"),
      faq("Can I use Claude Code, ChatGPT or my own API keys with Stella?"),
    ],
  },
  {
    slug: "claude-code-and-chatgpt-in-one-assistant",
    queries: [
      "desktop app for Claude Code",
      "Claude Code GUI for non-developers",
      "use my ChatGPT subscription in another app",
      "bring your own API key AI assistant",
      "AI assistant with OpenRouter and local models",
    ],
    metaTitle: "Use Claude Code, ChatGPT or your own keys in one assistant",
    metaDescription:
      "Stella runs on its own models out of the box, or on Claude Code, your ChatGPT plan, your API keys (Anthropic, OpenAI, Google, OpenRouter and more) or local models. Free.",
    eyebrow: "Any model",
    headline: "Claude Code, ChatGPT or your own keys.",
    answer:
      "Stella is a personal AI assistant that can run on the models you already pay for. Use Claude Code as its engine, sign in with ChatGPT to use your plan, add API keys for Anthropic, OpenAI, Google, xAI, OpenRouter and more, or run local models. Or use Stella’s own models with no setup. Free.",
    points: [
      { title: "No setup by default", body: "Stella’s own models work the moment you open the app." },
      { title: "Your subscription", body: "Run Stella on Claude Code, or sign in with ChatGPT to use your plan." },
      { title: "Your keys, your machine", body: "Anthropic, OpenAI, Google, xAI, Moonshot, Z.AI, OpenRouter, GitHub Copilot or a local model." },
    ],
    questions: [
      faq("Can I use Claude Code, ChatGPT or my own API keys with Stella?"),
      faq("What is a free, open-source alternative to the ChatGPT and Claude desktop apps?"),
      faq("Is Stella free?"),
    ],
  },
];

export function getAnswerPage(slug: string) {
  return ANSWER_PAGES.find((page) => page.slug === slug);
}

export function faqJsonLd(items: Answer[], url: string) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    url,
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

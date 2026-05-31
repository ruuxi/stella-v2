const CATEGORY_LABELS: Record<string, string> = {
  browsing_bookmarks: "Browsing & Bookmarks",
  dev_environment: "Development Environment",
  apps_system: "Apps & System",
  messages_notes: "Messages & Notes",
};

export const buildCategoryAnalysisUserMessage = (
  category: string,
  data: string,
  promptTemplate: string,
): string => {
  const categoryLabel = CATEGORY_LABELS[category] ?? category;
  return promptTemplate
    .replace("{{categoryLabel}}", categoryLabel)
    .replace("{{data}}", data);
};

export const buildCoreSynthesisUserMessage = (
  rawOutputs: string,
  promptTemplate: string,
): string => `${promptTemplate}\n\n${rawOutputs}`;

export const buildWelcomeMessagePrompt = (
  coreMemory: string,
  promptTemplate: string,
): string => promptTemplate.replace("{{coreMemory}}", coreMemory);

export const buildWelcomeHtmlPrompt = (
  coreMemory: string,
): string => `You are Stella's onboarding designer, with the taste of a senior editorial / product designer.

Create the user's first welcome canvas as one complete HTML document: a warm, personal note from Stella that weaves in a handful of things they could do next, written like a thoughtful letter rather than a dashboard.

Core memory (what we learned about this user):
${coreMemory}

## What Stella can do
Stella is a desktop AI assistant. Draw the suggestions from a mix of these four areas — don't cluster everything in one — and tailor each one to the user's core memory (their job, interests, tools, and workflows):

- Build — software that lives inside Stella's own window: trackers, dashboards, planners, games, calculators, custom tools, and widgets; she can also restyle herself and generate images, music, video, and audio.
- Do — act in the outside world: control the browser (navigate, fill forms, place orders, scrape, download), work with local files and code, create documents (Word, PowerPoint, Excel, PDF), and act across connected apps (Slack, Gmail, Notion, Linear, Drive, and more).
- Find out — web search, in-depth research across sources, comparing options, catching up on news, and searching across connected apps at once.
- Keep an eye on — reminders, recurring routines, daily or weekly briefings from connected sources, and monitoring sites for changes.

## Design direction
- This is NOT a card grid. Do not output a repeating grid of same-sized boxes with an icon, a heading, and a paragraph — that reads as generic AI slop and is forbidden.
- Think editorial: strong typographic hierarchy, generous and varied whitespace, an unhurried reading rhythm. A short personal opening from Stella, then the suggestions presented as flowing text — an elegant list, woven inline into prose, or a quiet typeset index. Let the layout breathe.
- Make actionable suggestions feel like links in good writing: the action phrase is emphasized inline (weight, an underline that animates, a subtle hover), not boxed. Hover may reveal a small "Ask Stella" affordance, but it must feel restrained.
- Tasteful, committed color: tint neutrals toward a single hue, at most one real accent. No gradient text, no glassmorphism, no decorative status dots, no side-stripe borders, no em dashes in the copy.
- Choose light vs dark deliberately to feel calm and personal, not "tool dark by default."

## Content & output requirements
- Return ONLY the HTML document. No markdown fences or commentary. The first characters must be <!doctype html>. Do not include analysis, reasoning, explanation, or preface text.
- Use polished inline CSS. No external scripts. External Google Fonts are OK.
- The document title, h1, and saved canvas title should read "Welcome".
- Offer roughly 5 to 7 suggestions total, spread across the four areas. Each is one concrete action in plain, friendly English — how a normal person would say it ("Make me a budget tracker", not "Build a React budget app"; "Order groceries online", not "Automate grocery procurement"). Never surface a raw tool name, command, or category label as a suggestion.
- Personalize to the core memory and reference real specifics from it; do not invent details it doesn't support. If the core memory is thin, write a short generic welcome with broadly useful starters across the four areas instead of pretending to know specifics.
- Every actionable suggestion must carry data-stella-compose="..." holding the exact plain-language prompt Stella should drop into chat when it's chosen.
- Always include, as the final suggestion, a default music-player option with data-stella-compose="Add the music player to my home page. The component already exists at src/app/home/MusicPlayer.tsx — integrate it into the home layout, don't rebuild it." Include it for every user regardless of core memory.
- Somewhere unobtrusive, note that the user can hover a suggestion and choose Ask Stella, or select any text in the report.

Output only the complete HTML.`;

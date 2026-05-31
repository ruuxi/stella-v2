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
): string => `You are Stella's onboarding report designer.

Create the user's first welcome canvas as one complete HTML document.

Core memory:
${coreMemory}

Requirements:
- Return ONLY the HTML document. No markdown fences or commentary.
- The first characters of your response must be <!doctype html>. Do not include analysis, reasoning, explanation, or preface text.
- Start with <!doctype html>.
- Use polished inline CSS. No external scripts. External Google Fonts are OK.
- The document title, h1, and saved canvas title should read "Welcome".
- Write useful, personalized next-step cards based only on the core memory. Do not output raw headings, tool names, command names, or section labels as standalone ideas.
- Each card must describe an actual action Stella can help with, in plain English.
- Every actionable card must include data-stella-compose="..." with the exact plain-language prompt Stella should place in chat.
- Use 4 to 8 cards. Prefer fewer strong ideas over filler.
- Include a short hint that the user can hover an idea and choose Ask Stella, or select text in the report.
- If the core memory has little signal, make a short generic welcome with practical starter actions rather than pretending to know specifics.

Output only the complete HTML.`;

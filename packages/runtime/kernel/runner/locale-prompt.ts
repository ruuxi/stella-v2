const LOCALE_ENGLISH_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ko: "Korean",
  pl: "Polish",
  sv: "Swedish",
  nb: "Norwegian Bokmål",
  da: "Danish",
  fi: "Finnish",
  cs: "Czech",
  el: "Greek",
  tr: "Turkish",
  ro: "Romanian",
  hu: "Hungarian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  he: "Hebrew",
};

export const getResponseLanguageSystemPrompt = (
  locale: string | undefined,
): string | undefined => {
  if (!locale) return undefined;
  const normalized = locale.trim();
  if (!normalized || normalized === "en" || normalized.startsWith("en-")) {
    return undefined;
  }
  const name = LOCALE_ENGLISH_NAMES[normalized];
  if (!name) return undefined;
  return [
    `Respond to the user in ${name} (${normalized}) unless the user explicitly switches.`,
    "Keep code, commands, filenames, API names, and quoted source text in their original language.",
  ].join(" ");
};

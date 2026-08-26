export const THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS = 2_000;

const THREAD_SUMMARY_NEVER_SHRINK_RATIO = 0.5;
const THREAD_SUMMARY_HEADINGS = [
  "Topic",
  "Key Points",
  "Current State",
  "Open Items",
];

export const normalizeSummaryForValidation = (summary) =>
  summary
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\S\r\n]+/gu, " ")
    .trim();

const invalidInput = (reason) => ({
  valid: false,
  reason,
  visibleCodePoints: 0,
  wordCount: 0,
  uniqueWordCount: 0,
});

const countVisibleCodePoints = (value) =>
  Array.from(normalizeSummaryForValidation(value)).filter(
    (codePoint) => !/\s/u.test(codePoint),
  ).length;

const segmentSummaryWords = (summary) => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return Array.from(segmenter.segment(summary))
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase());
};

const summarySectionBodies = (summary) => {
  const matches = Array.from(
    summary.matchAll(
      /^##\s*(Topic|Key Points|Current State|Open Items)\s*$/gimu,
    ),
  );
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = match[1].toLocaleLowerCase();
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? summary.length;
    sections.set(heading, summary.slice(bodyStart, bodyEnd).trim());
  }
  return sections;
};

const longestRepeatedCodePointRun = (value) => {
  let longest = 0;
  let current = 0;
  let previous = "";
  for (const codePoint of value) {
    if (codePoint === previous) {
      current += 1;
    } else {
      previous = codePoint;
      current = 1;
    }
    longest = Math.max(longest, current);
  }
  return longest;
};

/**
 * Canonical summary acceptance shared by online compaction and the offline
 * checkpoint repair classifier. Unknown runtime types fail closed here so an
 * untrusted persisted JSON value can never be coerced into validity.
 */
export const validateThreadSummary = (
  summary,
  middleTokens,
  previousSummary,
) => {
  if (typeof summary !== "string") {
    return invalidInput("summary must be a string");
  }
  if (
    typeof middleTokens !== "number" ||
    !Number.isFinite(middleTokens) ||
    middleTokens < 0
  ) {
    return invalidInput("middleTokens must be a finite non-negative number");
  }
  if (previousSummary !== undefined && typeof previousSummary !== "string") {
    return invalidInput("previousSummary must be a string when provided");
  }

  const normalized = normalizeSummaryForValidation(summary);
  const visible = Array.from(normalized).filter(
    (codePoint) => !/\s/u.test(codePoint),
  );
  const words = segmentSummaryWords(normalized);
  const uniqueWords = new Set(words);
  const base = {
    visibleCodePoints: visible.length,
    wordCount: words.length,
    uniqueWordCount: uniqueWords.size,
  };
  if (!normalized || visible.length === 0) {
    return { valid: false, reason: "no visible content", ...base };
  }

  const previousVisible = previousSummary
    ? countVisibleCodePoints(previousSummary)
    : 0;
  if (
    previousVisible > 0 &&
    visible.length < previousVisible * THREAD_SUMMARY_NEVER_SHRINK_RATIO
  ) {
    return {
      valid: false,
      reason: `shrank below never-shrink floor (${visible.length} visible vs previous ${previousVisible})`,
      ...base,
    };
  }

  if (middleTokens < THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS) {
    return { valid: true, ...base };
  }

  const sections = summarySectionBodies(normalized);
  const missingSection = THREAD_SUMMARY_HEADINGS.find(
    (heading) =>
      !segmentSummaryWords(sections.get(heading.toLowerCase()) ?? "").length,
  );
  if (missingSection) {
    return {
      valid: false,
      reason: `missing informative ## ${missingSection} section`,
      ...base,
    };
  }

  const scale = Math.max(
    0,
    Math.log2(middleTokens / THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS),
  );
  const minVisibleCodePoints = Math.min(150, Math.round(64 + scale * 14));
  const minWords = Math.min(24, Math.round(10 + scale * 2));
  if (visible.length < minVisibleCodePoints || words.length < minWords) {
    return {
      valid: false,
      reason: `insufficient information for ${middleTokens} folded tokens`,
      ...base,
    };
  }

  const placeholderFragments = [
    "[what the conversation is about]",
    "important information, decisions, and conclusions from the conversation",
    "where things stand now — what has been done, what is in progress",
    "unresolved questions, pending tasks, or next steps discussed",
  ];
  const lower = normalized.toLocaleLowerCase();
  if (placeholderFragments.some((fragment) => lower.includes(fragment))) {
    return { valid: false, reason: "template boilerplate", ...base };
  }

  const frequencies = new Map();
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  const mostCommonWord = Math.max(0, ...frequencies.values());
  const uniqueRatio = uniqueWords.size / Math.max(1, words.length);
  const withoutDividerRuns = normalized.replace(/[=\-_*#~─]{3,}/gu, " ");
  if (
    (words.length >= 12 && uniqueRatio < 0.3) ||
    mostCommonWord / Math.max(1, words.length) > 0.3 ||
    longestRepeatedCodePointRun(withoutDividerRuns) >= 16
  ) {
    return { valid: false, reason: "extreme repetition", ...base };
  }

  const longAsciiWords = words.filter((word) => /^[a-z]{5,}$/u.test(word));
  const vowelFreeWords = longAsciiWords.filter(
    (word) => !/[aeiouy]/u.test(word),
  );
  if (
    longAsciiWords.length >= 12 &&
    vowelFreeWords.length / longAsciiWords.length > 0.55
  ) {
    return {
      valid: false,
      reason: "gibberish-like token distribution",
      ...base,
    };
  }

  return { valid: true, ...base };
};

// Case- and accent-insensitive fold for matching: decompose, drop combining
// diacritics (the U+0300–U+036F block covers Latin accents), and lowercase. So
// "Café" and "cafe" match. Uses the combining-marks range rather than the
// `\p{Diacritic}` property escape for broad RN engine compatibility.
export const foldText = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

// Split a raw query into folded terms for multi-word (AND) matching.
export const foldQueryTerms = (query: string): string[] =>
  foldText(query).split(/\s+/).filter(Boolean);

// Fold a string while tracking, for each folded character, the original index
// it came from. Lets the snippet highlight map a match found in folded space
// back onto the original (accented/cased) text. `map[k]` is the original UTF-16
// index of folded char `k`; the trailing entry maps to the string end.
export function foldWithMap(text: string): { folded: string; map: number[] } {
  const folded: string[] = [];
  const map: number[] = [];
  let originalIndex = 0;
  for (const char of text) {
    const dec = char
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    for (const f of dec) {
      folded.push(f);
      map.push(originalIndex);
    }
    originalIndex += char.length;
  }
  map.push(text.length);
  return { folded: folded.join(""), map };
}

// A short preview of a matched message, windowed around the earliest matching
// term so the hit is visible (and can be emphasised) in the row — accent- and
// case-insensitively, mapping the folded match back onto the original text.
export function buildSearchSnippet(
  text: string,
  query: string,
): { before: string; match: string; after: string } {
  const terms = foldQueryTerms(query);
  const { folded, map } = foldWithMap(text);
  let foldIdx = -1;
  let termLen = 0;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at >= 0 && (foldIdx < 0 || at < foldIdx)) {
      foldIdx = at;
      termLen = term.length;
    }
  }
  if (foldIdx < 0) {
    return {
      before: text.slice(0, 120),
      match: "",
      after: text.length > 120 ? "…" : "",
    };
  }
  const matchStart = map[foldIdx] ?? 0;
  const matchEnd = map[foldIdx + termLen] ?? text.length;
  const start = Math.max(0, matchStart - 28);
  const before = (start > 0 ? "…" : "") + text.slice(start, matchStart);
  const match = text.slice(matchStart, matchEnd);
  const tailEnd = matchEnd + 90;
  const after =
    text.slice(matchEnd, tailEnd) + (tailEnd < text.length ? "…" : "");
  return { before, match, after };
}

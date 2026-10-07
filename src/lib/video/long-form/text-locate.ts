/** Locate a model-reproduced passage in the original narration while ignoring
 * trivial differences: Unicode form, typographic quotes/dashes, whitespace and
 * punctuation at the edges. The ORIGINAL narration span is returned, so text is
 * always derived from the source of truth. Only a unique occurrence is accepted. */
const FOLD: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-", "…": "..." };

function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let c = text[i].normalize("NFKC");
    c = FOLD[c] ?? c;
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      folded += " "; map.push(i); lastSpace = true; continue;
    }
    for (const ch of c.toLowerCase()) { folded += ch; map.push(i); }
    lastSpace = false;
  }
  return { folded, map };
}
const EDGE = /^[\s"'.,;:!?()\[\]¿¡-]+|[\s"'.,;:!?()\[\]¿¡-]+$/g;

export function locateNormalized(narration: string, quote: string): string | null {
  if (narration.includes(quote)) return quote;
  const needle = fold(quote).folded.replace(EDGE, "");
  if (needle.split(" ").filter(Boolean).length < 3) return null;
  const { folded, map } = fold(narration);
  const at = folded.indexOf(needle);
  if (at < 0 || folded.indexOf(needle, at + 1) !== -1) return null;
  const start = map[at], end = map[at + needle.length - 1];
  return narration.slice(start, end + 1);
}

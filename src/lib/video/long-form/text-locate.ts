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

/** Word tokens of a text with their original character spans; punctuation and case are ignored. */
function wordSpans(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu))
    out.push({ word: m[0].normalize("NFKC").toLowerCase().replace(/’/g, "'"), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/**
 * Literal span of `narration` whose WORD sequence equals the quote's, ignoring punctuation and case
 * (incident dbc89879: an 18-word editing mark differed from the narration only in inner punctuation).
 * Unique occurrence only; the original narration span is returned.
 */
export function locateWordSequence(narration: string, quote: string, minWords = 3): string | null {
  const q = wordSpans(quote).map(w => w.word), n = wordSpans(narration);
  if (q.length < minWords) return null;
  const hits: number[] = [];
  for (let i = 0; i + q.length <= n.length; i++) if (q.every((w, j) => n[i + j].word === w)) hits.push(i);
  return hits.length === 1 ? narration.slice(n[hits[0]].start, n[hits[0] + q.length - 1].end) : null;
}

/**
 * Longest contiguous run of the quote's words that occurs literally in the narration, returned as the
 * ORIGINAL narration span (incident e8048599: a 35-word editing mark condensed a sentence of its own
 * block; measured runs: 16 literal words, then a rewritten tail). Accepted only when the run is unique and
 * either identifies the passage on its own (>= `identifyingWords` contiguous identical words) or is at least
 * `minWords` long and covers `minShare` of the quote. Otherwise null. Nothing is invented: the result is
 * always narration text.
 */
export function longestLiteralRun(narration: string, quote: string, minWords = 8, minShare = 0.6, identifyingWords = 12): string | null {
  const q = wordSpans(quote).map(w => w.word), n = wordSpans(narration);
  let best = { len: 0, at: -1, count: 0 };
  for (let i = 0; i < n.length; i++) for (let j = 0; j < q.length; j++) {
    let k = 0;
    while (i + k < n.length && j + k < q.length && n[i + k].word === q[j + k]) k++;
    if (k > best.len) best = { len: k, at: i, count: 1 };
    else if (k === best.len && k > 0 && i !== best.at) best.count++;
  }
  const enough = best.len >= identifyingWords || (best.len >= minWords && best.len >= Math.ceil(q.length * minShare));
  if (!enough || best.count !== 1) return null;
  return narration.slice(n[best.at].start, n[best.at + best.len - 1].end);
}

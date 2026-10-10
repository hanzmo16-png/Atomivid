/**
 * Podcast → video visual plan (pure, no I/O, no paid calls).
 *  - Scenes follow the narration: cut at sentence ends close to `targetSeconds` (8–18 s), using the word timings of
 *    the paid narration when available, or an even split otherwise.
 *  - Each scene gets stock searches built from its own words (stopwords removed), ranked by how often each word
 *    recurs in the whole episode (its topic; title words count extra), so a scene about "the third and fourth kind"
 *    searches the episode's subject rather than a one-off abstract word; the title is the last fallback.
 */
import type { WordTiming } from "@/lib/providers/types";

export type Scene = { index: number; start: number; end: number; text: string; query: string; queries?: string[] };
/** Word → occurrences across the whole episode (title words weigh extra). */
export type Topic = ReadonlyMap<string, number>;
const TITLE_WEIGHT = 3;

const STOP = new Set(("a al algo algunas algunos ante antes aquel aquella aquellas aquellos aqui así aunque cada casi como con contra cual cuales cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha había hace hacia han hasta hay la las le les lo los más mas me mi mientras mismo mucho muy nada ni no nos nosotros o otra otras otro otros para pero poco por porque que quien quienes se sea según ser si sí sin sobre solo son su sus también tan tanto te tiene tienen todo todos tras tu tú un una uno unos usted ya yo the a an and are as at be but by for from has have he her his i in is it its of on or our she that the their them they this to was we were what when which who will with you your").split(" "));

const contentWords = (text: string) => (text.toLowerCase().normalize("NFC").match(/[\p{L}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w));

export function topicOf(script: string, title: string): Topic {
  const t = new Map<string, number>();
  for (const w of contentWords(script)) t.set(w, (t.get(w) ?? 0) + 1);
  for (const w of contentWords(title)) t.set(w, (t.get(w) ?? 0) + TITLE_WEIGHT);
  return t;
}

function salient(text: string, max = 3, topic?: Topic): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  contentWords(text).forEach((w, i) => {
    const c = counts.get(w) ?? { n: 0, first: i };
    c.n++;
    counts.set(w, c);
  });
  const weight = (w: string) => topic?.get(w) ?? 0;
  return [...counts.entries()]
    .sort((a, b) => weight(b[0]) - weight(a[0]) || b[1].n - a[1].n || b[0].length - a[0].length || a[1].first - b[1].first)
    .slice(0, max)
    .map(([w]) => w);
}

export function sceneQuery(text: string, title: string, topic?: Topic): string {
  const terms = salient(text, 3, topic);
  if (terms.length >= 2) return terms.join(" ");
  return [...terms, ...salient(title, 2)].slice(0, 3).join(" ") || title.slice(0, 40);
}

function withQueries(scene: Omit<Scene, "query" | "queries">, title: string, topic: Topic): Scene {
  const text = scene.text || title;
  const s = { ...scene, query: sceneQuery(text, title, topic) };
  return { ...s, queries: sceneQueries({ text, query: s.query }, title, topic) };
}

/** Scenes from word timings (preferred): cut after a sentence end once >= min, or forcibly at max. */
export function scenesFromWords(words: WordTiming[], durationSeconds: number, title: string, opts: { min?: number; target?: number; max?: number } = {}): Scene[] {
  const min = opts.min ?? 8, target = opts.target ?? 12, max = opts.max ?? 18;
  const topic = topicOf(words.map((w) => w.text).join(" "), title);
  const scenes: Omit<Scene, "query" | "queries">[] = [];
  let start = 0, bucket: string[] = [];
  const push = (end: number) => {
    scenes.push({ index: scenes.length, start, end, text: bucket.join(" ") });
    start = end; bucket = [];
  };
  for (const w of words) {
    bucket.push(w.text);
    const len = w.endSeconds - start;
    const sentenceEnd = /[.!?…]["»”)]?$/.test(w.text);
    if ((sentenceEnd && len >= min) || len >= max || (len >= target && /[,;:]$/.test(w.text))) push(w.endSeconds);
  }
  if (bucket.length || start < durationSeconds) {
    if (scenes.length && durationSeconds - start < min / 2) {
      const last = scenes[scenes.length - 1];
      last.end = durationSeconds; last.text = [last.text, ...bucket].join(" ").trim();
    } else push(durationSeconds);
  }
  scenes[scenes.length - 1].end = durationSeconds;
  return scenes.filter((s) => s.end - s.start > 0.05).map((s, i) => withQueries({ ...s, index: i }, title, topic));
}

/** Scene lengths: ~12 s for short episodes; ~15 s past 10 minutes (fewer stock searches over a 30-minute episode). */
export function sceneLengths(durationSeconds: number) {
  return durationSeconds > 600 ? { min: 10, target: 15, max: 22 } : { min: 8, target: 12, max: 18 };
}

/** Even split when no word timings exist (own recordings): ~12 s scenes, queries from the title/script. */
export function evenScenes(durationSeconds: number, title: string, script: string | null, target = 12): Scene[] {
  const n = Math.max(1, Math.round(durationSeconds / target));
  const len = durationSeconds / n;
  const sentences = (script ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
  const topic = topicOf(script ?? "", title);
  return Array.from({ length: n }, (_, i) => {
    const text = sentences.length ? sentences.slice(Math.floor((i * sentences.length) / n), Math.floor(((i + 1) * sentences.length) / n)).join(" ") : "";
    return withQueries({ index: i, start: i * len, end: i === n - 1 ? durationSeconds : (i + 1) * len, text }, title, topic);
  });
}

/**
 * Subtitle words for the editor (podcast_editor words_json): absolute seconds, ordered, non-overlapping, and
 * kept inside the audio (the editor's verification rejects a cue past the end; it adds a 0.1 s tail to groups).
 */
export function wordsJson(words: WordTiming[], durationSeconds: number) {
  const limit = Math.max(0, durationSeconds - 0.15);
  const out: { text: string; start: number; end: number }[] = [];
  for (const w of words) {
    const text = w.text.trim();
    const start = Math.max(w.startSeconds, out.length ? out[out.length - 1].end : 0);
    if (!text || start >= limit - 0.05) continue;
    const end = Math.min(limit, Math.max(w.endSeconds, start + 0.05));
    out.push({ text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
  }
  return { words: out };
}

/** Searches for one scene, most specific first; the episode title is the coherent fallback. Deduplicated. */
export function sceneQueries(scene: Pick<Scene, "text" | "query">, title: string, topic?: Topic): string[] {
  // Two terms find footage far more often than three on a stock site; each extra search costs rate-limit quota.
  // With a topic, a second term joins only when it recurs in the episode: a one-off abstract word narrows the search
  // away from the subject.
  const terms = salient(scene.text, 2, topic).filter((w, i) => i === 0 || !topic || (topic.get(w) ?? 0) >= 2);
  const out = [terms.join(" "), terms[0] ?? "", salient(title, 2).join(" ") || scene.query]
    .map((q) => q.trim()).filter(Boolean);
  return [...new Set(out)];
}

export type ClipCandidate = { sourceId: string; durationSeconds?: number };

/** Slowest playback accepted to stretch a clip over its scene (below this it looks like slow motion). */
export const MIN_CLIP_SPEED = 0.7;

/**
 * Picks the stock clip for a scene of `needSeconds`: long enough (natively, or slowed down to at most
 * MIN_CLIP_SPEED), never one of the clips shown just before, and preferably one not used yet in the episode.
 * `speed` <= 1 is the playback rate needed to cover the scene. Null when nothing qualifies.
 */
export function pickClip<T extends ClipCandidate>(candidates: T[], needSeconds: number, recent: readonly string[], used: ReadonlySet<string>): { clip: T; speed: number } | null {
  const fit = candidates.filter((c) => (c.durationSeconds ?? 0) >= needSeconds * MIN_CLIP_SPEED && !recent.includes(c.sourceId));
  const fresh = fit.filter((c) => !used.has(c.sourceId));
  const pool = fresh.length ? fresh : fit;
  const clip = pool.find((c) => (c.durationSeconds ?? 0) >= needSeconds) ?? pool[0];
  if (!clip) return null;
  return { clip, speed: Math.min(1, Number(((clip.durationSeconds ?? 0) / needSeconds).toFixed(3))) };
}

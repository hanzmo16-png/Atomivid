/**
 * «¿Cabe este texto en la duración elegida?» — one pure module used by the form (live counter) AND by the
 * server (creation, POST /script, avatar text-to-speech), so the text is never counted one way and
 * validated another.
 *
 * Three different things, never mixed:
 *   - technical input limit: characters the form and the server accept at all (MAX_NARRATION_CHARS);
 *   - recommended capacity: the word range whose CENTRAL estimate lands inside the worker's ±10 % window;
 *   - estimated duration: a RANGE from the narrator's calibrated speaking rate. Only the audio confirms it
 *     (generate-video.ts measures the real narration and stops before footage when it does not fit).
 *
 * Compatibility uses the worker's own rule (duration-check.ts): the narration must end within ±10 % of the
 * target, after at most ONE bounded pace correction (voice.ts clamps speed to 0.85–1.15, already reserved
 * in the voice envelope). A text is blocked only when it CLEARLY does not fit: even its central estimate is
 * outside what that single correction can reach.
 */
import { WORDS_PER_SECOND } from "./script-pacing";

/**
 * Technical input limit, shared by Reel and Avatar text: room for the longest offered duration (90 s at the
 * fast end of the band with long words) — the duration fit, not this limit, decides what can start.
 */
export const MAX_NARRATION_CHARS = 2500;
/** duration-check.ts: ±10 %. */
const WORKER_TOLERANCE = 0.1;
/** voice.ts: speed correction clamp. */
const MIN_SPEED = 0.85, MAX_SPEED = 1.15;
/**
 * Speaking-rate band around the calibrated central rate (script-pacing.ts, measured narrations). The band
 * reflects voice, language and punctuation variation; PROVISIONAL until the read-only calibration
 * (T-20261018-1930) replaces it with measured p10/p90 per language.
 */
export const RATE_BAND = { es: { slow: 2.45, mid: WORDS_PER_SECOND, fast: 3.15 }, en: { slow: 2.45, mid: WORDS_PER_SECOND, fast: 3.15 } } as const;
/** A line break is read as a longer pause than a sentence end inside running text. */
const LINE_BREAK_PAUSE = { min: 0.2, max: 0.5 };
/** Typical running-text characters per word incl. space (only for showing a capacity in characters). */
const CHARS_PER_WORD = 6;

export type NarrationLanguage = "es" | "en";
export type NarrationStats = {
  /** Normalised text, exactly what is stored and sent to the voice (and billed per character). */
  text: string;
  chars: number;
  /** Written words, counted like the script quality check (whitespace-separated). */
  words: number;
  /** Words as they will be SPOKEN: numbers and symbols expand («1995», «30 %»). */
  spokenWords: number;
  lineBreaks: number;
  numbers: number;
  /** Estimated narration seconds: [fast, central, slow]. */
  estimate: { min: number; mid: number; max: number };
};

/** Only whitespace is normalised (line endings, repeated spaces/blank lines); words and punctuation are untouched. */
export function normalizeNarration(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[\t\f\v  ]+/g, " ").split("\n").map(l => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** Spoken words for one run of digits («7» → 1, «25» → ~3, «1995» → ~4–5 in Spanish). Upper-leaning on purpose. */
function spokenWordsForDigits(digits: string): number {
  const n = digits.replace(/^0+(?=\d)/, "").length;
  return n <= 1 ? 1 : n === 2 ? 3 : n === 3 ? 4 : n === 4 ? 5 : n + 2;
}

/**
 * Stats of the text AS IT WILL BE NARRATED. A Reel narrates its scenes joined by a space
 * (generate-video.ts), so its line breaks are scene boundaries, not pauses; Avatar sends the text as written.
 */
export function narrationStats(raw: string, language: NarrationLanguage = "es", mode: "visual" | "avatar" = "visual"): NarrationStats {
  const text = canonicalNarration(raw, mode);
  const tokens = text ? text.split(/\s+/).filter(Boolean) : [];
  let spoken = 0, numbers = 0;
  for (const token of tokens) {
    const runs = token.match(/\d+/g);
    const letters = /[^\d\W_]/u.test(token.replace(/\d/g, ""));
    if (runs) { numbers += runs.length; spoken += runs.reduce((s, r) => s + spokenWordsForDigits(r), 0) + (letters ? 1 : 0); }
    else spoken += 1;
    if (/%/.test(token)) spoken += language === "es" ? 2 : 1; // «por ciento» / «percent»
    if (/[$€£]/.test(token)) spoken += 1;
  }
  const lineBreaks = (text.match(/\n+/g) ?? []).length;
  const band = RATE_BAND[language];
  const at = (rate: number, pause: number) => Math.round((spoken / rate + lineBreaks * pause) * 10) / 10;
  return { text, chars: text.length, words: tokens.length, spokenWords: spoken, lineBreaks, numbers,
    estimate: { min: at(band.fast, LINE_BREAK_PAUSE.min), mid: at(band.mid, (LINE_BREAK_PAUSE.min + LINE_BREAK_PAUSE.max) / 2), max: at(band.slow, LINE_BREAK_PAUSE.max) } };
}

export type FitVerdict = "compatible" | "borderline" | "too_long" | "too_short" | "empty" | "over_limit";
export type DurationFit = {
  verdict: FitVerdict;
  /** Can a paid step start with this text and this duration? Only «compatible» and «borderline». */
  allowed: boolean;
  targetSeconds: number;
  /** Durations (among those offered for the mode) this text is compatible with. */
  compatibleDurations: number[];
  message: string;
};

/** Natural narration seconds the worker can accept for a target, with and without its single pace correction. */
export function acceptanceWindow(targetSeconds: number) {
  return { strict: { min: targetSeconds * (1 - WORKER_TOLERANCE), max: targetSeconds * (1 + WORKER_TOLERANCE) },
    reachable: { min: targetSeconds * (1 - WORKER_TOLERANCE) * MIN_SPEED, max: targetSeconds * (1 + WORKER_TOLERANCE) * MAX_SPEED } };
}

/** Recommended capacity for a duration: words (and approximate characters) whose central estimate fits ±10 %. */
export function recommendedCapacity(targetSeconds: number, language: NarrationLanguage = "es") {
  const { strict } = acceptanceWindow(targetSeconds), rate = RATE_BAND[language].mid;
  const minWords = Math.ceil(strict.min * rate), maxWords = Math.floor(strict.max * rate);
  return { minWords, maxWords, approxMinChars: minWords * CHARS_PER_WORD, approxMaxChars: maxWords * CHARS_PER_WORD };
}

const round5 = (s: number, dir: "down" | "up") => Math.max(5, (dir === "down" ? Math.floor(s / 5) : Math.ceil(s / 5)) * 5);
export function formatRange(e: NarrationStats["estimate"]): string {
  const lo = round5(e.min, "down"), hi = round5(e.max, "up");
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}

function verdictFor(stats: NarrationStats, target: number): FitVerdict {
  if (!stats.text) return "empty";
  if (stats.chars > MAX_NARRATION_CHARS) return "over_limit";
  const { strict, reachable } = acceptanceWindow(target);
  if (stats.estimate.mid > reachable.max) return "too_long";
  if (stats.estimate.mid < reachable.min) return "too_short";
  return stats.estimate.mid >= strict.min && stats.estimate.mid <= strict.max && stats.estimate.min >= reachable.min && stats.estimate.max <= reachable.max
    ? "compatible" : "borderline";
}

const list = (ds: number[]) => ds.length === 1 ? `${ds[0]} segundos` : `${ds.slice(0, -1).join(", ")} o ${ds[ds.length - 1]} segundos`;

/** Fit of an own script for a target duration among the durations the mode actually offers. Never changes anything. */
export function fitForDuration(stats: NarrationStats, targetSeconds: number, offered: number[]): DurationFit {
  const verdict = verdictFor(stats, targetSeconds);
  const compatibleDurations = offered.filter(d => verdictFor(stats, d) === "compatible");
  const about = `Tu guion duraría aproximadamente ${formatRange(stats.estimate)} segundos`;
  // Suggest comfortable durations first; otherwise the viable-but-tight ones (never one that is blocked).
  const borderline = offered.filter(d => verdictFor(stats, d) === "borderline");
  const alt = (compatibleDurations.length ? compatibleDurations : borderline).filter(d => d !== targetSeconds);
  let message: string;
  switch (verdict) {
    case "empty": message = "Escribe o pega el texto que quieres narrar."; break;
    case "over_limit": message = `El texto tiene ${stats.chars} caracteres y el límite técnico es ${MAX_NARRATION_CHARS}. Acórtalo para continuar.`; break;
    case "too_long": message = `${about} y elegiste ${targetSeconds}. ${alt.length ? `Selecciona ${list(alt)} o acorta el texto.` : "Acorta el texto: no cabe en ninguna duración disponible."}`; break;
    case "too_short": message = `${about} y elegiste ${targetSeconds}. ${alt.length ? `Selecciona ${list(alt)} o amplía el texto.` : "Amplía el texto para llegar a la duración mínima disponible."}`; break;
    case "borderline": message = `${about}: está cerca del límite de ${targetSeconds} segundos. Puede necesitar un ajuste leve de ritmo; si el audio real no cabe, nos detenemos antes de buscar imágenes y conservamos el audio.${alt.length ? ` Con ${list(alt)} cabría con holgura.` : ""}`; break;
    default: message = `${about}: compatible con ${targetSeconds} segundos. La duración exacta se confirma al generar el audio.`;
  }
  return { verdict, allowed: verdict === "compatible" || verdict === "borderline", targetSeconds, compatibleDurations, message };
}

/**
 * Avatar text-to-speech has no target, only a hard maximum: the SLOW end of the range must fit, because the
 * paid voice happens before the real duration is known (same conservatism as the previous 2.5 words/s rule).
 */
export function fitForMaximum(stats: NarrationStats, maxSeconds: number): DurationFit {
  const base = { targetSeconds: maxSeconds, compatibleDurations: [] as number[] };
  if (!stats.text) return { ...base, verdict: "empty", allowed: false, message: "Escribe el texto que quieres narrar." };
  if (stats.chars > MAX_NARRATION_CHARS) return { ...base, verdict: "over_limit", allowed: false, message: `El texto tiene ${stats.chars} caracteres y el límite técnico es ${MAX_NARRATION_CHARS}. Acórtalo para continuar.` };
  if (stats.estimate.max > maxSeconds) return { ...base, verdict: "too_long", allowed: false,
    message: `Tu texto duraría aproximadamente ${formatRange(stats.estimate)} segundos y el límite de Avatar es ${maxSeconds}. Acorta el texto antes de generar la voz.` };
  return { ...base, verdict: "compatible", allowed: true, message: `Tu texto duraría aproximadamente ${formatRange(stats.estimate)} segundos (límite de Avatar: ${maxSeconds}). La duración exacta se confirma al generar el audio.` };
}

/**
 * The narration EXACTLY as the voice will receive it. A Reel narrates its scenes joined by one space
 * (generate-video.ts), so line breaks become spaces; Avatar sends the normalised text as written. This is the
 * single reference the counter, the scene split and the «narration untouched» check compare against.
 */
export function canonicalNarration(raw: string, mode: "visual" | "avatar" = "visual"): string {
  const normalized = normalizeNarration(raw);
  return mode === "visual" ? normalized.replace(/\n+/g, " ") : normalized;
}

/** Words whose trailing period is not a sentence end (ES/EN), compared without the period, lower case. */
const ABBREVIATIONS = new Set(["sr", "sra", "srta", "sres", "dr", "dra", "dres", "lic", "ing", "prof", "profa", "arq", "gral", "cap", "av", "avda",
  "núm", "nro", "pág", "págs", "ej", "aprox", "dpto", "depto", "ud", "uds", "vd", "vds", "art", "cía", "mr", "mrs", "ms", "st", "jr", "vs", "fig",
  "vol", "no", "approx", "dept", "est", "inc", "ltd", "co", "corp", "p", "pp"]);

/**
 * True when the token (as written, with its punctuation) ends a sentence. Only «!», «?», «…» or a period that
 * is not an abbreviation, an initial («J.») or a dotted acronym («EE.», «UU.», «e.g.», «p.m.») count.
 */
function endsSentence(token: string): boolean {
  const core = token.replace(/["»”’')\]]+$/u, "");
  if (/[!?…]$/u.test(core)) return true;
  if (!core.endsWith(".")) return false;
  if (/\.\.$/.test(core)) return true; // «...» written with periods
  const word = core.slice(0, -1).replace(/^[«"“‘(¿¡[]+/u, "");
  if (/^\p{L}$/u.test(word)) return false; // initial
  if (/^(\p{L}{1,3}\.)+\p{L}{1,3}$/u.test(word) || /^\p{Lu}{2}$/u.test(word)) return false; // p.m. / e.g. / EE. UU.
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Deterministic scenes for an own script. Cuts happen ONLY at a space or line break that already exists in
 * the text, right after a sentence end; nothing inside a word, figure, URL or abbreviation is ever a cut
 * point («3.14», «$1.500», «ejemplo.com» contain no space). Every scene is a slice of canonicalNarration(),
 * so joining the scenes with one space gives it back character for character — by construction, and
 * re-checked at the end: if that ever failed, the whole text stays one scene rather than altered.
 */
export function splitIntoScenes(text: string, targetSeconds: number, maxSceneChars = 800): string[] {
  const canonical = canonicalNarration(text, "visual");
  if (!canonical) return [];
  // Tokens of the normalised text with their separator; a line break is always a sentence boundary.
  const parts = normalizeNarration(text).split(/( |\n+)/);
  const sentences: string[] = [];
  let current = "";
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i], separator = parts[i + 1] ?? "";
    current = current ? `${current} ${token}` : token;
    if (!separator || separator.includes("\n") || endsSentence(token)) { sentences.push(current); current = ""; }
  }
  if (current) sentences.push(current);

  const scenes = Math.max(1, Math.min(10, Math.round(targetSeconds / 5), sentences.length));
  const total = sentences.reduce((sum, x) => sum + x.length, 0);
  const out: string[] = [];
  let scene = "";
  for (const sentence of sentences) {
    const next = scene ? `${scene} ${sentence}` : sentence;
    const remainingScenes = scenes - out.length;
    if (scene && (next.length > maxSceneChars || (remainingScenes > 1 && scene.length >= total / scenes))) { out.push(scene); scene = sentence; }
    else scene = next;
  }
  if (scene) out.push(scene);
  return out.join(" ") === canonical ? out : [canonical];
}

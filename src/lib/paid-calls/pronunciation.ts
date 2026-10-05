/**
 * Speak-only pronunciation aliases at the TTS boundary (PI V2 Fase B4, RB-07).
 *
 * An alias replaces a display word ONLY in the text sent to TTS ("Thermopylae" → "thermopilee").
 * The display text is never modified, and the word timings that come back are mapped to the
 * display word, so subtitles never show the alias.
 *
 * Lint (Thermopylae regression R1): an alias whose spoken form contains a hyphen or any uppercase
 * letter ("THER-MOP-Y-LAE", "Eph-IAL-tes") is rejected before the paid-call gate — the provider
 * reads such respellings letter by letter or with broken stress. No dictionary is created or sent.
 */
import type { WordTiming } from "@/lib/providers/types";

export type PronunciationAlias = { word: string; spoken: string };
export type AliasLintReason = "empty" | "hyphen" | "uppercase";

export class PronunciationAliasError extends Error {
  constructor(readonly word: string, readonly spoken: string, readonly reason: AliasLintReason) {
    super(`Alias de pronunciación rechazado para "${word}" (${reason}): "${spoken}". No se llamó al proveedor de voz.`);
    this.name = "PronunciationAliasError";
  }
}

export class TtsVoiceMissingError extends Error {
  constructor() {
    super("Falta voice_id para la síntesis de voz. No se llamó al proveedor de voz.");
    this.name = "TtsVoiceMissingError";
  }
}

const HYPHEN = /[-‐‑‒–—−]/u;
const UPPER = /\p{Lu}/u;

export function lintPronunciationAliases(aliases: readonly PronunciationAlias[] = []): void {
  for (const a of aliases) {
    const spoken = a.spoken ?? "";
    if (!spoken.trim() || !a.word?.trim()) throw new PronunciationAliasError(a.word ?? "", spoken, "empty");
    if (HYPHEN.test(spoken)) throw new PronunciationAliasError(a.word, spoken, "hyphen");
    if (UPPER.test(spoken)) throw new PronunciationAliasError(a.word, spoken, "uppercase");
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, "gu");

/** The text sent to TTS: each alias word replaced (whole word, case-sensitive) by its spoken form. */
export function spokenText(displayText: string, aliases: readonly PronunciationAlias[] = []): string {
  return aliases.reduce((t, a) => t.replace(wordRe(a.word), a.spoken.trim()), displayText);
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const lead = (t: string) => /^[^\p{L}\p{N}]*/u.exec(t)?.[0] ?? "";
const trail = (t: string) => /[^\p{L}\p{N}]*$/u.exec(t)?.[0] ?? "";

/** Map the timings of a spoken alias back to its display word (one timing per display word). */
export function restoreDisplayWords(words: readonly WordTiming[], aliases: readonly PronunciationAlias[] = []): WordTiming[] {
  if (aliases.length === 0) return words.map((w) => ({ ...w }));
  const forms = aliases.map((a) => ({ word: a.word, tokens: a.spoken.trim().split(/\s+/).map(norm) }));
  const out: WordTiming[] = [];
  for (let i = 0; i < words.length; ) {
    const hit = forms.find((f) => f.tokens.length > 0 && f.tokens.every((tok, k) => i + k < words.length && norm(words[i + k].text) === tok));
    if (!hit) {
      out.push({ ...words[i] });
      i++;
      continue;
    }
    const first = words[i];
    const last = words[i + hit.tokens.length - 1];
    out.push({ text: `${lead(first.text)}${hit.word}${trail(last.text)}`, startSeconds: first.startSeconds, endSeconds: last.endSeconds });
    i += hit.tokens.length;
  }
  return out;
}

export class CaptionWordCountMismatchError extends Error {
  constructor(readonly beatId: string, readonly expected: number, readonly received: number) {
    super(`Subtítulos del beat ${beatId}: el texto visible tiene ${expected} palabras y la voz devolvió ${received}. No se desplazan palabras: el subtítulo no se construye.`);
    this.name = "CaptionWordCountMismatchError";
  }
}

/**
 * Subtitle words from the canonical display text (PI V2 B4.1, RB-07): one display token per spoken
 * word timing, index by index. If the counts differ, it throws — words are never shifted to fit.
 */
export function canonicalWords(displayText: string, spokenWords: readonly WordTiming[], beatId = "?"): WordTiming[] {
  const tokens = displayText.split(/\s+/).filter(Boolean);
  if (tokens.length !== spokenWords.length) throw new CaptionWordCountMismatchError(beatId, tokens.length, spokenWords.length);
  return tokens.map((text, i) => ({ text, startSeconds: spokenWords[i].startSeconds, endSeconds: spokenWords[i].endSeconds }));
}

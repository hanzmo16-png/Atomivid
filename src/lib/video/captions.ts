import type { WordTiming } from "@/lib/providers/types";
import type { Caption } from "../../../remotion/VerticalReel";
import { isEmphasisWord } from "./caption-emphasis";
const MAX_CAPTION_WORDS = 7;
const MIN_CAPTION_WORDS = 2;
const MAX_CAPTION_CHARS = 52;
export function buildCaptions(words: WordTiming[], emphasisSet: ReadonlySet<string>): Caption[] {
  const captions: Caption[] = [];
  let group: WordTiming[] = [];
  let groupChars = 0;

  const flush = () => {
    if (group.length === 0) return;
    const emphasisWords = group.filter((w) => isEmphasisWord(w.text, emphasisSet)).map((w) => w.text);
    captions.push({
      text: group.map((w) => w.text).join(" "),
      startSeconds: group[0].startSeconds,
      endSeconds: group[group.length - 1].endSeconds,
      ...(emphasisWords.length > 0 ? { emphasisWords } : {}),
    });
    group = [];
    groupChars = 0;
  };

  for (const word of words) {
    const nextChars = groupChars + (groupChars > 0 ? 1 : 0) + word.text.length;
    // Si esta palabra excede el presupuesto de caracteres, cierra el
    // bloque actual ANTES de agregarla (nunca corta una palabra a la
    // mitad) — salvo que el bloque siga vacío (una palabra muy larga sola).
    if (group.length > 0 && nextChars > MAX_CAPTION_CHARS) {
      flush();
    }
    group.push(word);
    groupChars += (groupChars > 0 ? 1 : 0) + word.text.length;

    const endsSentence = /[.!?…]["”’\')\]]*$/.test(word.text);
    const endsPhrase = /[,.;:!?…]["”’\')\]]*$/.test(word.text);
    const longEnough = group.length >= MIN_CAPTION_WORDS;

    if (group.length >= MAX_CAPTION_WORDS || groupChars >= MAX_CAPTION_CHARS || (endsPhrase && (longEnough || endsSentence))) {
      flush();
    }
  }
  flush();

  // Une el remanente únicamente dentro de la misma oración y presupuesto.
  if (captions.length >= 2) {
    const last = captions[captions.length - 1];
    if (last.text.split(/\s+/).length < MIN_CAPTION_WORDS) {
      const prev = captions[captions.length - 2];
      if (/[.!?…]["”’\')\]]*$/.test(prev.text) || prev.text.length + 1 + last.text.length > MAX_CAPTION_CHARS || prev.text.split(/\s+/).length + last.text.split(/\s+/).length > MAX_CAPTION_WORDS) return captions;
      prev.text = `${prev.text} ${last.text}`;
      prev.endSeconds = last.endSeconds;
      prev.emphasisWords = [...(prev.emphasisWords ?? []), ...(last.emphasisWords ?? [])];
      if (prev.emphasisWords.length === 0) delete prev.emphasisWords;
      captions.pop();
    }
  }

  return captions;
}


/**
 * Advisory editorial preflight for podcast scripts. Offline and deterministic: no providers, ledger,
 * storage or network. It does NOT establish audience retention, fact accuracy or publication readiness.
 * No generated rewrite: the author keeps full control of words and claims.
 */
export type PodcastLanguage = "es" | "en";
export type EditorialFindingCode =
  | "SHORT_SCRIPT" | "OVER_LIMIT" | "GENERIC_OPENING" | "OPENING_WITHOUT_TENSION"
  | "LONG_SENTENCE" | "REPEATED_PASSAGE" | "ENDING_REVIEW";
export type EditorialFinding = {
  code: EditorialFindingCode;
  importance: "high" | "medium" | "note";
  message: string;
  evidence?: string;
};
export type PodcastEditorialReport = {
  schema: "atomivid/podcast-editorial-preflight@1";
  language: PodcastLanguage;
  decision: "INSUFFICIENT_INPUT" | "REVISE" | "REVIEWABLE";
  words: number;
  characters: number;
  estimatedNarrationSeconds: number;
  openingWindowSeconds: number;
  openingWords: number;
  findings: EditorialFinding[];
  limitations: string[];
};

const MIN_SCRIPT_CHARS = 20;
const MAX_SCRIPT_CHARS = 30_000;
const OPENING_SECONDS = 35;
const SPEAKING_WPM: Record<PodcastLanguage, number> = { es: 145, en: 150 };
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const GENERIC: Record<PodcastLanguage, RegExp> = {
  es: /^(?:hola(?:\s+a\s+tod[oa]s)?|bienvenid[oa]s?(?:\s+a|\s+al)?|en\s+el\s+episodio\s+de\s+hoy|hoy\s+(?:vamos\s+a|hablaremos\s+de)|qué\s+tal\s+(?:amigos|a\s+todos))/iu,
  en: /^(?:hello\s+(?:everyone|everybody)|welcome\s+(?:back\s+)?to|in\s+today['’]?s\s+episode|today\s+we(?:'ll|\s+will|\s+are\s+going\s+to)|hey\s+everyone)/iu,
};
const CONTRAST: Record<PodcastLanguage, RegExp> = {
  es: /\b(?:pero|aunque|sin\s+embargo|nadie|imposible|secreto|por\s+qué|cómo\s+es\s+posible)\b/iu,
  en: /\b(?:but|yet|however|although|nobody|impossible|secret|why|how\s+could)\b/iu,
};
const ENDING: Record<PodcastLanguage, RegExp> = {
  es: /\b(?:en\s+resumen|en\s+conclusión|para\s+terminar|la\s+pregunta\s+es|ahora\s+te\s+toca|qué\s+opinas|nos\s+vemos|hasta\s+el\s+próximo)\b/iu,
  en: /\b(?:in\s+conclusion|to\s+sum\s+up|the\s+question\s+is|what\s+do\s+you\s+think|until\s+next\s+time|the\s+takeaway)\b/iu,
};
const copy: Record<PodcastLanguage, Record<EditorialFindingCode, string>> = {
  es: {
    SHORT_SCRIPT: "El guion es demasiado corto para el mínimo técnico del Podcast (20 caracteres).",
    OVER_LIMIT: "El guion supera el máximo técnico de 30 000 caracteres del Podcast.",
    GENERIC_OPENING: "La apertura empieza con un saludo o una introducción convencional; revisa si la idea principal puede aparecer antes.",
    OPENING_WITHOUT_TENSION: "En la primera ventana estimada no aparece una pregunta o contraste explícito. Revisa si existe una promesa narrativa clara.",
    LONG_SENTENCE: "Hay oraciones extensas que podrían dificultar la respiración o la comprensión en voz alta.",
    REPEATED_PASSAGE: "Se repite un pasaje largo casi literalmente; comprueba si es intencional.",
    ENDING_REVIEW: "No se detectó una señal de cierre convencional; revisa manualmente que el episodio tenga un desenlace deliberado.",
  },
  en: {
    SHORT_SCRIPT: "The script is below the Podcast technical minimum (20 characters).",
    OVER_LIMIT: "The script exceeds the Podcast technical maximum of 30,000 characters.",
    GENERIC_OPENING: "The opening starts with a conventional greeting; consider leading with the central idea.",
    OPENING_WITHOUT_TENSION: "The estimated opening contains no explicit question or contrast; review its narrative promise.",
    LONG_SENTENCE: "Long sentences may make spoken delivery harder to follow.",
    REPEATED_PASSAGE: "A long passage appears more than once; check whether the repetition is intentional.",
    ENDING_REVIEW: "No conventional closure cue was detected; review whether the episode concludes intentionally.",
  },
};

const snippet = (s: string) => s.replace(/\s+/gu, " ").trim().slice(0, 100);
const normalize = (s: string) => s.toLocaleLowerCase("und")
  .normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => [...s.matchAll(WORD)].length;

export function reviewPodcastScript(script: string, language: PodcastLanguage): PodcastEditorialReport {
  if (language !== "es" && language !== "en") throw new TypeError("Unsupported podcast language");
  if (typeof script !== "string") throw new TypeError("Podcast script must be a string");
  const text = script.replace(/\r\n?/gu, "\n").trim();
  const tokens = [...text.matchAll(WORD)];
  const total = tokens.length;
  const openingCount = Math.min(total, Math.ceil((OPENING_SECONDS / 60) * SPEAKING_WPM[language]));
  const last = tokens[openingCount - 1];
  const opening = last ? text.slice(0, (last.index ?? 0) + last[0].length) : "";
  const findings: EditorialFinding[] = [];
  const add = (code: EditorialFindingCode, importance: EditorialFinding["importance"], evidence?: string) =>
    findings.push({ code, importance, message: copy[language][code], ...(evidence ? { evidence: snippet(evidence) } : {}) });

  if (text.length < MIN_SCRIPT_CHARS) add("SHORT_SCRIPT", "high");
  if (text.length > MAX_SCRIPT_CHARS) add("OVER_LIMIT", "high");
  if (GENERIC[language].test(opening)) add("GENERIC_OPENING", "medium", opening);
  if (total >= 40 && !/[¿?]/u.test(opening) && !CONTRAST[language].test(opening)) add("OPENING_WITHOUT_TENSION", "note", opening);

  const sentences = text.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
  const long = sentences.find((sentence) => words(sentence) > 44);
  if (long) add("LONG_SENTENCE", "medium", long);
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (words(sentence) < 12) continue;
    const normalized = normalize(sentence);
    if (seen.has(normalized)) { add("REPEATED_PASSAGE", "medium", sentence); break; }
    seen.add(normalized);
  }
  if (total >= 70) {
    const end = tokens[Math.max(0, total - 65)];
    const tail = end ? text.slice(end.index ?? 0) : "";
    if (!ENDING[language].test(tail)) add("ENDING_REVIEW", "note");
  }
  const decision = text.length < MIN_SCRIPT_CHARS ? "INSUFFICIENT_INPUT"
    : findings.some((f) => f.importance === "high" || f.importance === "medium") ? "REVISE" : "REVIEWABLE";
  return {
    schema: "atomivid/podcast-editorial-preflight@1", language, decision,
    words: total, characters: text.length,
    estimatedNarrationSeconds: Math.round((total * 60) / SPEAKING_WPM[language]),
    openingWindowSeconds: OPENING_SECONDS, openingWords: openingCount,
    findings,
    limitations: language === "es" ? [
      "Orientativo: no predice retención, viralidad ni tasa de finalización.",
      "No verifica hechos, fuentes, derechos, naturalidad de voz ni adecuación editorial humana.",
      "No reserva dinero, no genera guion, no llama a proveedores y no autoriza producción.",
    ] : [
      "Advisory only: does not predict audience retention, virality or completion.",
      "Does not verify facts, sources, rights, voice quality or human editorial suitability.",
      "Does not reserve money, rewrite the script, call providers or authorize production.",
    ],
  };
}

const BANNED_OPENERS = [
  "welcome back to the channel",
  "in today's video",
  "in this video we",
  "hey guys",
  "what's up everybody",
  "vamos a hablar de",
  "en el video de hoy",
  "bienvenidos de nuevo",
];

const GENERIC_SLOP = [
  "marcus aurelius once said",
  "sigma mindset",
  "dark psychology",
  "these 7 secrets",
  "scientists say",
  "studies show that people who",
];

export function usesBannedOpener(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return BANNED_OPENERS.some((p) => lower.startsWith(p) || lower.includes(`${p} `));
}

export function slopScore(text: string): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const phrase of GENERIC_SLOP) {
    if (lower.includes(phrase)) hits += 1;
  }
  if (usesBannedOpener(text)) hits += 2;
  return hits;
}

export function assertOriginalHook(hook: string): void {
  if (!hook.trim()) throw new Error("Hook is empty.");
  if (usesBannedOpener(hook)) {
    throw new Error("Hook uses a banned generic opener.");
  }
}

/** Competitive references may inform structure only — never copy transcripts. */
export function rejectTranscriptRewriteIntent(input: {
  sourceTranscript?: string;
  rewriteRequested?: boolean;
}): void {
  if (input.rewriteRequested) {
    throw new Error("Transcript-rewrite flow is forbidden in Long Form.");
  }
  if (input.sourceTranscript && input.sourceTranscript.trim().length > 400) {
    throw new Error("Pasting a competitor transcript to rewrite is forbidden.");
  }
}

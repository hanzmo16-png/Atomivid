/**
 * Contract of the podcast journey: what the platform can really produce today, the owner's review before producing,
 * and the draft kept while going back. Pure (no I/O) so the UI, the API routes and the tests share one definition.
 *
 * Capabilities are the server's, not wishes: one narrator (one saved voice of the account, or the owner's recording),
 * Spanish or English, the standard montage of the worker. Two narrators, mixed modes and the Director engine exist
 * in the Director package but the worker does not run them from the app: requests asking for them are refused early
 * instead of being silently produced another way.
 * Client-safe (no Node modules): the confirmation fingerprint lives in production-confirm.ts (server only).
 */
export const PODCAST_CAPABILITIES = {
  sources: ["tts", "upload"] as const,
  languages: ["es", "en"] as const,
  narrationModes: ["un_narrador"] as const,
  /** Fields of the Director package contract that the platform does not accept yet (see INTEGRACION docs). */
  unavailable: {
    narrationMode: "Solo está disponible un narrador: el worker no produce episodios con dos narradores ni mixtos.",
    voices: "Solo se usa una voz guardada por episodio.",
    guestVoiceId: "Solo se usa una voz guardada por episodio: no hay segundo narrador.",
    montageEngine: "El motor de montaje lo fija el servidor; no se elige desde la aplicación.",
    avatar: "El podcast no incluye avatar.",
  } as Record<string, string>,
};

/** Early refusal of options the server cannot run (a request is never produced in a different mode than asked). */
export function unsupportedOption(body: Record<string, unknown>): string | null {
  for (const [key, message] of Object.entries(PODCAST_CAPABILITIES.unavailable)) {
    if (!(key in body) || body[key] === undefined || body[key] === null) continue;
    if (key === "narrationMode" && body[key] === "un_narrador") continue;
    return message;
  }
  return null;
}

export type ReviewableEpisode = { id: string; title: string; language: "es" | "en"; source: "tts" | "upload"; script: string | null; voice_id: string | null; voice_name: string | null; status: string; audio_sha256?: string | null };

/** What the review step shows, in order. Every line is a real server setting of this episode. */
export function productionSummary(e: ReviewableEpisode, form: { budgetUsd: number | null; runBudgetUsd: number | null; scheduleAt: string | null; pendingUsd: number }): Array<{ label: string; value: string }> {
  const usd = (n: number) => `USD ${n.toFixed(2)}`;
  return [
    { label: "Episodio", value: e.title },
    { label: "Idioma", value: e.language === "en" ? "Inglés" : "Español" },
    { label: "Narración", value: e.source === "upload" ? "Tu grabación (un narrador)" : `Un narrador · voz guardada «${e.voice_name ?? "—"}»` },
    { label: "Montaje", value: "Estándar del servidor: escenas que siguen la narración, clips y fotos con licencia de Pexels, subtítulos si hay tiempos por palabra" },
    { label: "Coste pendiente", value: e.status === "ready" || e.source === "upload" ? "USD 0 (la narración ya existe)" : `hasta ${usd(form.pendingUsd)} (narración)` },
    { label: "Presupuesto total", value: form.budgetUsd == null ? "sin cambiar" : usd(form.budgetUsd) },
    ...(form.pendingUsd > 0 ? [{ label: "Máximo nuevo de esta ejecución", value: form.runBudgetUsd == null ? "—" : usd(form.runBudgetUsd) }] : []),
    { label: "Inicio", value: form.scheduleAt ? `programado: ${new Date(form.scheduleAt).toLocaleString("es-MX")}` : "ahora" },
    { label: "Entrega", value: "MP4 16:9 1080p, para revisar aquí; la publicación queda detenida hasta que la apruebes" },
  ];
}

// ---- draft kept while going back (browser only; never contains anything the server did not show the owner)
export type EpisodeDraft = { v: 1; mode: "tts" | "upload"; title: string; script: string; language: "es" | "en"; voiceId: string };
export const DRAFT_KEY = "atomivid:podcast:nuevo-episodio:v1";

export function parseDraft(raw: string | null, maxChars: number): EpisodeDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<EpisodeDraft>;
    if (d.v !== 1 || (d.mode !== "tts" && d.mode !== "upload") || (d.language !== "es" && d.language !== "en")) return null;
    if (typeof d.title !== "string" || typeof d.script !== "string" || typeof d.voiceId !== "string") return null;
    return { v: 1, mode: d.mode, language: d.language, title: d.title.slice(0, 200), script: d.script.slice(0, maxChars), voiceId: d.voiceId.slice(0, 100) };
  } catch { return null; }
}

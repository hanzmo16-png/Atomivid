/** Server-only half of the production contract: the fingerprint that ties the owner's confirmation to the episode. */
import { createHash } from "node:crypto";
import type { ReviewableEpisode } from "./production-contract";

/**
 * Fingerprint of what the owner sees when confirming a production: title, language, origin, voice and the exact
 * script (or the stored recording). The video request must carry it; if the episode changed in between, the server
 * refuses (409) and the owner reviews again.
 */
export function productionFingerprint(e: ReviewableEpisode): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([e.id, e.title, e.language, e.source, e.voice_id ?? null, e.source === "tts" ? createHash("sha256").update(e.script ?? "").digest("hex") : e.audio_sha256 ?? null]));
  return h.digest("hex").slice(0, 32);
}

export function checkConfirmation(e: ReviewableEpisode, confirm: unknown): { ok: true } | { error: string; status: number } {
  if (typeof confirm !== "string" || !confirm) return { error: "Revisa la configuración y confirma antes de producir.", status: 400 };
  if (confirm !== productionFingerprint(e)) return { error: "El episodio cambió desde tu revisión. Vuelve a revisarlo y confirma de nuevo.", status: 409 };
  return { ok: true };
}


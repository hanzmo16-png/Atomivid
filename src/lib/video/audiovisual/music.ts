/**
 * Selección musical por DIRECCIÓN (no por palabras sueltas). Reutiliza el
 * catálogo existente (providers/music/manifest.ts, 22 pistas).
 *
 * Los tonos del manifest son gruesos (p. ej. "cinematic" cubre tanto un
 * crescendo triunfal como un piano dramático), así que cada pista recibe
 * aquí un carácter más fino. FUENTE de ese carácter: el prompt con el que
 * se generó cada pista de Eleven Music (scripts/generate-music-library.ts)
 * y la descripción pública de las dos de Pixabay — NO una escucha. Una
 * pista nueva sin clasificar aquí nunca se elige en modo dirigido (lo
 * comprueba music.test.ts), así el catálogo no se contamina en silencio.
 *
 * Reglas:
 *  - Una pista es compatible si tiene al menos un carácter REQUERIDO por la
 *    dirección y ninguno PROHIBIDO.
 *  - Orden: primero las que coinciden con el carácter más prioritario;
 *    desempate determinístico por semilla (requestId) → repetible.
 *  - Sin pista compatible → "no_compatible". NUNCA se cae a otra pista
 *    cualquiera ni se genera música de pago.
 */
import type { MusicTrackEntry } from "@/lib/providers/music/manifest";
import { seededIndex } from "@/lib/providers/music/select";
import type { MusicDirectionId } from "./catalog";

export type TrackCharacter =
  | "dark" | "eerie" | "suspense" | "mysterious"
  | "playful" | "fun" | "upbeat"
  | "uplifting" | "triumphant" | "epic" | "warm" | "dreamy"
  | "emotional" | "calm" | "introspective"
  | "neutral" | "corporate" | "tech" | "elegant";

export type TrackEnergy = "low" | "medium" | "high";

export const TRACK_CHARACTER: Record<string, { character: TrackCharacter[]; energy: TrackEnergy; basis: string }> = {
  "pixabay-335162": { character: ["upbeat", "corporate", "uplifting"], energy: "medium", basis: "título y descripción Pixabay: Upbeat Corporate Inspiring" },
  "pixabay-266030": { character: ["uplifting", "triumphant", "epic"], energy: "high", basis: "título Pixabay: powerful, motivational (build-up)" },
  "elevenlabs-motivational-1": { character: ["uplifting", "triumphant"], energy: "medium", basis: "prompt: uplifting motivational … inspiring climax" },
  "elevenlabs-motivational-2": { character: ["uplifting", "upbeat", "corporate"], energy: "high", basis: "prompt: energetic motivational corporate … hopeful" },
  "elevenlabs-corporate-1": { character: ["corporate", "neutral"], energy: "medium", basis: "prompt: clean modern corporate background" },
  "elevenlabs-corporate-2": { character: ["corporate", "tech", "calm"], energy: "low", basis: "prompt: minimal corporate tech … calm" },
  "elevenlabs-cinematic-1": { character: ["epic", "triumphant"], energy: "high", basis: "prompt: epic … triumphant swell" },
  "elevenlabs-cinematic-2": { character: ["emotional"], energy: "medium", basis: "prompt: dramatic … emotional and sweeping" },
  "elevenlabs-inspirational-1": { character: ["warm", "uplifting"], energy: "low", basis: "prompt: warm inspirational … hopeful" },
  "elevenlabs-inspirational-2": { character: ["uplifting", "dreamy"], energy: "low", basis: "prompt: uplifting … dreamy and hopeful" },
  "elevenlabs-tension-1": { character: ["dark", "eerie", "suspense"], energy: "low", basis: "prompt: dark suspenseful … eerie strings, horror atmosphere" },
  "elevenlabs-tension-2": { character: ["suspense", "mysterious", "eerie"], energy: "medium", basis: "prompt: tense mysterious … unsettling textures" },
  "elevenlabs-reflective-1": { character: ["calm", "introspective"], energy: "low", basis: "prompt: calm reflective … introspective" },
  "elevenlabs-reflective-2": { character: ["calm", "warm"], energy: "low", basis: "prompt: gentle reflective … warm, serene" },
  "elevenlabs-energetic-1": { character: ["upbeat", "fun"], energy: "high", basis: "prompt: high energy upbeat … fun and fast-paced" },
  "elevenlabs-energetic-2": { character: ["playful", "fun"], energy: "medium", basis: "prompt: playful … bouncy, lighthearted" },
  "elevenlabs-minimal-1": { character: ["neutral", "calm"], energy: "low", basis: "prompt: minimal ambient … understated" },
  "elevenlabs-minimal-2": { character: ["neutral", "tech"], energy: "low", basis: "prompt: minimal electronic … modern and simple" },
  "elevenlabs-technology-1": { character: ["tech"], energy: "medium", basis: "prompt: futuristic tech … glitchy percussion" },
  "elevenlabs-technology-2": { character: ["tech"], energy: "medium", basis: "prompt: sleek technology … pulsing arpeggios" },
  "elevenlabs-luxury-1": { character: ["elegant", "calm"], energy: "low", basis: "prompt: elegant luxury … smooth piano, refined" },
  "elevenlabs-luxury-2": { character: ["elegant"], energy: "low", basis: "prompt: upscale luxury … jazz-influenced piano" },
};

/** Requeridos en orden de prioridad (el primero pesa más); prohibidos nunca pasan. */
export const MUSIC_RULES: Record<MusicDirectionId, { required: TrackCharacter[]; forbidden: TrackCharacter[] }> = {
  tension: {
    required: ["suspense", "eerie", "dark", "mysterious"],
    forbidden: ["uplifting", "triumphant", "upbeat", "playful", "fun", "corporate", "elegant", "warm", "epic"],
  },
  playful: {
    required: ["playful", "fun"],
    forbidden: ["dark", "eerie", "suspense", "mysterious", "triumphant", "epic", "corporate"],
  },
  uplifting: {
    required: ["uplifting", "triumphant", "warm"],
    forbidden: ["dark", "eerie", "suspense", "mysterious", "playful"],
  },
  neutral: {
    required: ["neutral", "tech", "corporate"],
    forbidden: ["dark", "eerie", "suspense", "triumphant", "epic", "playful", "fun", "uplifting"],
  },
  emotional: {
    required: ["emotional", "introspective", "calm", "dreamy", "warm"],
    forbidden: ["upbeat", "playful", "fun", "corporate", "triumphant", "dark", "eerie", "tech"],
  },
  driving: {
    required: ["epic", "upbeat", "triumphant"],
    forbidden: ["calm", "dark", "eerie", "playful", "corporate", "introspective"],
  },
};

export type DirectedMusicSelection =
  | { status: "matched"; candidates: MusicTrackEntry[] }
  | { status: "no_compatible"; reason: string };

/** Pistas compatibles, ordenadas (la primera es la elegida; las siguientes, reemplazos igual de compatibles si falla la descarga). */
export function selectDirectedTracks({
  manifest,
  direction,
  seed,
}: {
  manifest: MusicTrackEntry[];
  direction: MusicDirectionId;
  seed: string;
}): DirectedMusicSelection {
  const rules = MUSIC_RULES[direction];
  const ranked = manifest
    .map((track) => {
      const info = TRACK_CHARACTER[track.id];
      if (!info) return null;
      if (info.character.some((c) => rules.forbidden.includes(c))) return null;
      const ranks = info.character.map((c) => rules.required.indexOf(c)).filter((r) => r >= 0);
      if (ranks.length === 0) return null;
      return { track, rank: Math.min(...ranks) };
    })
    .filter((x): x is { track: MusicTrackEntry; rank: number } => x !== null);

  if (ranked.length === 0) {
    return { status: "no_compatible", reason: `El catálogo no tiene pistas compatibles con la dirección musical «${direction}».` };
  }

  // Grupos por rango; dentro de cada grupo, rotación determinística por semilla.
  const byRank = new Map<number, MusicTrackEntry[]>();
  for (const r of ranked) byRank.set(r.rank, [...(byRank.get(r.rank) ?? []), r.track]);
  const candidates: MusicTrackEntry[] = [];
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(rank)!;
    const start = seededIndex(`${seed}:${direction}:${rank}`, group.length);
    candidates.push(...group.slice(start), ...group.slice(0, start));
  }
  return { status: "matched", candidates };
}

export function compatibleTrackCount(manifest: MusicTrackEntry[], direction: MusicDirectionId): number {
  const result = selectDirectedTracks({ manifest, direction, seed: "count" });
  return result.status === "matched" ? result.candidates.length : 0;
}

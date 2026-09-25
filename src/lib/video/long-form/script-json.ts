/**
 * Forma de video_requests.script_json para mode="long_form" — módulo
 * liviano (sin Remotion ni proveedores) para que rutas API y páginas
 * puedan validarlo sin arrastrar el pipeline de render a su bundle.
 */
import type { NarrativeBeat } from "./types";

/** Forma persistida en video_requests.script_json para mode="long_form" — un guion ya aprobado (beats con narración), sin shots todavía: buildLongFormTimeline() los calcula contra la duración REAL narrada, igual que el CLI. */
export type LongFormScriptBeatInput = Pick<
  NarrativeBeat,
  "id" | "type" | "purpose" | "narration" | "claims" | "sources" | "emotionalTone" | "patternInterrupt"
> & {
  /** Escenas filmables declaradas por el guionista (inglés) — ver visual-intents.ts. Ausente en guiones anteriores. */
  visuals?: unknown;
};

export type LongFormScriptJson = {
  topic: string;
  beats: LongFormScriptBeatInput[];
};

export function isLongFormScriptJson(value: unknown): value is LongFormScriptJson {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { topic?: unknown; beats?: unknown };
  return (
    typeof candidate.topic === "string" &&
    Array.isArray(candidate.beats) &&
    candidate.beats.length > 0 &&
    candidate.beats.every(
      (b) => b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string" && typeof (b as { narration?: unknown }).narration === "string",
    )
  );
}


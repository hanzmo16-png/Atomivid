/**
 * Carga y valida un guion REAL ya finalizado (p. ej.
 * content/long-form/<video-id>/gobekli-script-002-final.json) al formato que
 * buildLongFormTimeline() ya espera — sin reconstrucción manual. No
 * reemplaza buildFixtureScript() (que sigue siendo el default del
 * orquestador): esto es una fuente ALTERNATIVA, explícita, para cuando ya
 * existe un guion real aprobado.
 *
 * Valida con Zod (mismo patrón que documentary-script.ts) para fallar
 * claro y temprano si el archivo no tiene la forma esperada, en vez de
 * dejar que un guion mal formado llegue silenciosamente hasta la síntesis
 * de voz.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { BEAT_TYPES } from "./types";
import type { NarrativeBeat } from "./types";

const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  support: z.enum(["sourced", "inference", "unverified"]),
  sourceIds: z.array(z.string()),
});

const BeatSchema = z.object({
  id: z.string(),
  type: z.enum(BEAT_TYPES),
  purpose: z.string(),
  narration: z.string().min(1),
  claims: z.array(ClaimSchema).default([]),
  emotionalTone: z.string().optional(),
  patternInterrupt: z.boolean().optional(),
});

const ScriptSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["primary", "secondary", "reference"]),
  locator: z.string().optional(),
  notes: z.string().optional(),
});

const ScriptFileSchema = z.object({
  meta: z.object({
    topic: z.string(),
    isFixtureContent: z.boolean(),
  }),
  researchPack: z
    .object({
      sources: z.array(ScriptSourceSchema),
    })
    .optional(),
  beats: z.array(BeatSchema).min(1),
});

export type LoadedScript = {
  topic: string;
  isFixtureContent: boolean;
  beats: Pick<
    NarrativeBeat,
    "id" | "type" | "purpose" | "narration" | "claims" | "emotionalTone" | "patternInterrupt"
  >[];
};

export class InvalidScriptFileError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`El archivo de guion "${filePath}" no tiene la forma esperada: ${String(cause)}`);
    this.name = "InvalidScriptFileError";
  }
}

/** Lee y valida un guion real desde disco — lanza con un mensaje claro si el archivo no calza con el schema, nunca deja pasar un guion mal formado en silencio. */
export function loadScriptFromFile(filePath: string): LoadedScript {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidScriptFileError(filePath, err);
  }

  const result = ScriptFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidScriptFileError(filePath, result.error.message);
  }

  const { meta, beats } = result.data;
  return {
    topic: meta.topic,
    isFixtureContent: meta.isFixtureContent,
    beats: beats.map((b) => ({
      id: b.id,
      type: b.type,
      purpose: b.purpose,
      narration: b.narration,
      claims: b.claims,
      emotionalTone: b.emotionalTone,
      patternInterrupt: b.patternInterrupt,
    })),
  };
}

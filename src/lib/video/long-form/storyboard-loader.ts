/**
 * Carga y valida un storyboard real ya aprobado (p. ej.
 * content/long-form/<video-id>/gobekli-storyboard-003.json) y lo agrupa
 * por beatId — listo para pasarle a buildShotsFromStoryboard() (ver
 * storyboard-shots.ts) beat por beat dentro de buildLongFormTimeline().
 *
 * Mismo patrón que script-loader.ts: valida con Zod para fallar claro y
 * temprano si el archivo no tiene la forma esperada, en vez de dejar que
 * un storyboard mal formado llegue silenciosamente hasta el render.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { StoryboardShotInput } from "./storyboard-shots";

const LicensingSchema = z
  .object({
    status: z.string().optional(),
  })
  .partial()
  .optional();

const StoryboardShotSchema = z.object({
  beatId: z.string(),
  shotId: z.string(),
  durationApprox: z.number().positive(),
  assetType: z.string(),
  visualIntent: z.string(),
  description: z.string().nullable().optional(),
  queryOrPrompt: z.string().nullable().optional(),
  sourceRequirement: z.string().nullable().optional(),
  hybridClassification: z.string().optional(),
  licensing: LicensingSchema,
});

const StoryboardFileSchema = z.object({
  meta: z.object({
    videoId: z.string(),
    totalShots: z.number().int().positive(),
  }),
  shots: z.array(StoryboardShotSchema).min(1),
});

export type LoadedStoryboard = {
  videoId: string;
  totalShots: number;
  /** Shots agrupados por beatId, en el mismo orden en que aparecen en el archivo. */
  shotsByBeatId: Map<string, StoryboardShotInput[]>;
};

export class InvalidStoryboardFileError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`El archivo de storyboard "${filePath}" no tiene la forma esperada: ${String(cause)}`);
    this.name = "InvalidStoryboardFileError";
  }
}

/** Lee y valida un storyboard real desde disco — lanza con un mensaje claro si el archivo no calza con el schema. */
export function loadStoryboardFromFile(filePath: string): LoadedStoryboard {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidStoryboardFileError(filePath, err);
  }

  const result = StoryboardFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidStoryboardFileError(filePath, result.error.message);
  }

  const { meta, shots } = result.data;
  const shotsByBeatId = new Map<string, StoryboardShotInput[]>();
  for (const shot of shots) {
    const list = shotsByBeatId.get(shot.beatId) ?? [];
    list.push({
      shotId: shot.shotId,
      durationApprox: shot.durationApprox,
      assetType: shot.assetType,
      visualIntent: shot.visualIntent,
      description: shot.description,
      queryOrPrompt: shot.queryOrPrompt,
      sourceRequirement: shot.sourceRequirement,
      hybridClassification: shot.hybridClassification,
      licensing: shot.licensing,
    });
    shotsByBeatId.set(shot.beatId, list);
  }

  return { videoId: meta.videoId, totalShots: meta.totalShots, shotsByBeatId };
}

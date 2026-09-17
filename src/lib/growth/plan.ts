import { z } from "zod";

export const growthChannelSchema = z.enum(["tiktok", "instagram_reels", "youtube_shorts"]);
export const contentPillarSchema = z.enum(["product_proof", "creator_education", "build_in_public"]);

export const growthBriefSchema = z.object({
  scheduledFor: z.string().datetime(),
  channel: growthChannelSchema,
  pillar: contentPillarSchema,
  language: z.enum(["es", "en"]),
  objective: z.enum(["awareness", "activation", "conversion"]),
  hook: z.string().min(10).max(280),
  topic: z.string().min(10).max(500),
  callToAction: z.string().min(3).max(120),
  experimentKey: z.string().min(1).max(120),
});

export type GrowthBriefDraft = z.infer<typeof growthBriefSchema>;

const SEEDS: ReadonlyArray<Omit<GrowthBriefDraft, "scheduledFor" | "channel" | "language" | "experimentKey">> = [
  {
    pillar: "product_proof",
    objective: "activation",
    hook: "Este reel se creó sin cámara y sin abrir un editor de video.",
    topic: "Demostración completa: de una idea breve a un reel terminado con ATOMIVID.",
    callToAction: "Prueba ATOMIVID",
  },
  {
    pillar: "creator_education",
    objective: "awareness",
    hook: "La mayoría de los videos faceless fallan antes del segundo tres.",
    topic: "Tres errores de ritmo, imágenes y voz que reducen la retención de un reel.",
    callToAction: "Guarda esta guía",
  },
  {
    pillar: "build_in_public",
    objective: "awareness",
    hook: "Nuestro primer video funcionó técnicamente, pero todavía no era comercial.",
    topic: "Comparación honesta entre la primera generación de ATOMIVID y el nuevo estándar.",
    callToAction: "Sigue la evolución",
  },
  {
    pillar: "product_proof",
    objective: "conversion",
    hook: "Una misma idea puede convertirse en contenido para tres plataformas.",
    topic: "Cómo ATOMIVID adapta un concepto para TikTok, Reels y YouTube Shorts.",
    callToAction: "Únete a la beta",
  },
];

const CHANNELS = growthChannelSchema.options;
const HOURS_UTC = [15, 19, 23];

export function createWeeklyGrowthPlan(weekStartsOn: string, count = 12): GrowthBriefDraft[] {
  z.string().date().parse(weekStartsOn);
  z.number().int().min(3).max(21).parse(count);

  return Array.from({ length: count }, (_, index) => {
    const seed = SEEDS[index % SEEDS.length];
    const date = new Date(`${weekStartsOn}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + Math.floor(index / 2));
    date.setUTCHours(HOURS_UTC[index % HOURS_UTC.length]);

    return growthBriefSchema.parse({
      ...seed,
      scheduledFor: date.toISOString(),
      channel: CHANNELS[index % CHANNELS.length],
      language: "es",
      experimentKey: `${seed.pillar}-${index % 2 === 0 ? "hook-a" : "hook-b"}`,
    });
  });
}

export function mondayFor(date = new Date()): string {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result.toISOString().slice(0, 10);
}

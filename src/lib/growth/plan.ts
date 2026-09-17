import { z } from "zod";

export const growthChannelSchema = z.enum(["tiktok", "instagram_reels", "youtube_shorts"]);
export type GrowthChannel = z.infer<typeof growthChannelSchema>;

export const approvalModeSchema = z.enum(["required", "automatic"]);

export const contentPillarSchema = z.enum([
  "product_proof",
  "creator_education",
  "build_in_public",
]);
export type ContentPillar = z.infer<typeof contentPillarSchema>;

export const growthPlanConfigSchema = z.object({
  weekStartsOn: z.string().date(),
  timezone: z.string().min(1),
  locale: z.enum(["es", "en"]),
  approvalMode: approvalModeSchema.default("required"),
  postsPerWeek: z.number().int().min(3).max(21).default(12),
  channels: z.array(growthChannelSchema).min(1),
});
export type GrowthPlanConfig = z.input<typeof growthPlanConfigSchema>;

export const growthBriefSchema = z.object({
  id: z.string().min(1),
  scheduledFor: z.string().datetime({ offset: true }),
  channel: growthChannelSchema,
  pillar: contentPillarSchema,
  language: z.enum(["es", "en"]),
  objective: z.enum(["awareness", "activation", "conversion"]),
  hook: z.string().min(10),
  topic: z.string().min(10),
  callToAction: z.string().min(3),
  status: z.literal("draft"),
  requiresApproval: z.boolean(),
  experimentKey: z.string().min(1),
});
export type GrowthBrief = z.infer<typeof growthBriefSchema>;

export const weeklyGrowthPlanSchema = z.object({
  weekStartsOn: z.string().date(),
  timezone: z.string().min(1),
  approvalMode: approvalModeSchema,
  briefs: z.array(growthBriefSchema),
});
export type WeeklyGrowthPlan = z.infer<typeof weeklyGrowthPlanSchema>;

const SEED_BRIEFS: ReadonlyArray<
  Pick<GrowthBrief, "pillar" | "objective" | "hook" | "topic" | "callToAction">
> = [
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

const POSTING_HOURS_UTC = [15, 19, 23];

function scheduledDate(weekStartsOn: string, index: number): string {
  const date = new Date(`${weekStartsOn}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Math.floor(index / 2));
  date.setUTCHours(POSTING_HOURS_UTC[index % POSTING_HOURS_UTC.length], 0, 0, 0);
  return date.toISOString();
}

/**
 * Creates a deterministic, review-first launch plan. It deliberately does not
 * call an LLM or publish anything: generation and delivery are later adapters.
 */
export function createWeeklyGrowthPlan(input: GrowthPlanConfig): WeeklyGrowthPlan {
  const config = growthPlanConfigSchema.parse(input);
  const briefs = Array.from({ length: config.postsPerWeek }, (_, index) => {
    const seed = SEED_BRIEFS[index % SEED_BRIEFS.length];
    const channel = config.channels[index % config.channels.length];

    return growthBriefSchema.parse({
      id: `${config.weekStartsOn}-${String(index + 1).padStart(2, "0")}`,
      scheduledFor: scheduledDate(config.weekStartsOn, index),
      channel,
      language: config.locale,
      status: "draft",
      requiresApproval: config.approvalMode === "required",
      experimentKey: `${seed.pillar}-${index % 2 === 0 ? "hook-a" : "hook-b"}`,
      ...seed,
    });
  });

  return weeklyGrowthPlanSchema.parse({
    weekStartsOn: config.weekStartsOn,
    timezone: config.timezone,
    approvalMode: config.approvalMode,
    briefs,
  });
}

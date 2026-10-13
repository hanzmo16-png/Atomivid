/**
 * Planning from a shot list (Hans, 2026-10-13): when a piece is authored as a list of planned shots (fiction, no
 * narration), the Director plans ONE shot per planned shot instead of re-cutting a word-count simulation.
 *
 * Each planned shot becomes one storyboard scene (one segment) with its own duration, so the plan keeps the
 * authored length and order, and each generated clip is offered only to its own shot. The Director still chooses the
 * recipe (and with it movement, transitions, label and sound) and the audit still applies; nothing is generated here.
 */
import type { GeneratedScript } from "@/lib/providers/types";
import type { Storyboard, StoryboardScene } from "@/lib/video/storyboard/types";
import type { ReelAdapterOptions } from "./from-reel";

export type PlannedShot = {
  id: string;
  /** Narrative line the shot illustrates (the Director's anchor and recipe keywords). Not voiced. */
  text: string;
  seconds: number;
  subject: string; action: string; environment: string;
  shotType: string; camera: string; lighting: string;
  energy?: "low" | "medium" | "high";
  /** Two or more short visual concepts (English), used as tags. */
  concepts: string[];
};

export type ShotListIdentity = { place: string; palette: string; lighting: string; tone: string; arc: string; recurring: string };

const ROUND = (x: number) => Math.round(x * 1000) / 1000;

export function storyboardFromShotList(shots: PlannedShot[], identity: ShotListIdentity): Storyboard {
  if (!shots.length) throw new Error("shot list is empty");
  const scenes: StoryboardScene[] = shots.map((s, i) => {
    if (!(s.seconds > 0) || !Number.isFinite(s.seconds)) throw new Error(`shot ${s.id}: invalid duration ${s.seconds}`);
    const first = i === 0, last = i === shots.length - 1;
    const concepts = s.concepts.length >= 2 ? s.concepts.slice(0, 4) : [...s.concepts, `${s.subject} ${s.action}`].slice(0, 2);
    return {
      id: `shot-${s.id}`, order: i, narrationText: s.text, estimatedDurationSeconds: s.seconds,
      literalMeaning: s.text, emotionalSubtext: identity.tone, narrativeGoal: first ? "gancho inicial" : last ? "cierre memorable" : "desarrollo",
      dominantEmotion: identity.tone, energy: s.energy ?? "medium", subject: s.subject,
      // The shot's own line travels with its action: the material is made FOR this line, so its topics (derived from
      // the action by the Director's lexicon) must be the line's, whatever language the visual description uses.
      visibleAction: `${s.action} — ${s.text}`, environment: s.environment,
      timeOfDay: "según el plano", shotType: s.shotType, cameraMovement: s.camera, lighting: s.lighting, colorPalette: identity.palette,
      visualStyle: "photorealistic cinematic fiction", imagePrompt: `${s.subject}, ${s.action}, ${s.environment}`,
      negativePrompt: "text overlay, watermark, logo", stockQueries: concepts, resourceType: "generated_video",
      priority: first ? 1 : last ? 2 : 3, confidence: 1,
      selectionRationale: "plano previsto en la lista de planos (autoría humana), no inferido de la narración",
      continuityWithPrevious: first ? "none" : "misma nave, misma dirección de pantalla", continuityWithNext: last ? "none" : "continuidad espacial con el plano siguiente",
      maxCostUsd: 0, fallbackStrategy: ["retry_prompt", "motion_graphic"],
    } as StoryboardScene;
  });
  return {
    visualIdentity: { characterAgeAndAppearance: identity.recurring, wardrobe: "no aplica", place: identity.place, colorPalette: identity.palette,
      lighting: identity.lighting, realismLevel: "photorealistic cinematic", aspectRatio: "9:16", emotionalTone: identity.tone, narrativeArc: identity.arc },
    hookDescription: shots[0].text, closingDescription: shots[shots.length - 1].text, scenes,
  };
}

/** The script the Director anchors on: one segment per planned shot (text only; nothing is voiced). */
export function scriptFromShotList(title: string, shots: PlannedShot[]): GeneratedScript {
  return { title, segments: shots.map(s => ({ text: s.text, visualQuery: s.concepts[0] ?? s.subject, visualConcepts: s.concepts, energy: s.energy })) };
}

/** Authored timings: each shot occupies exactly its planned seconds, back to back from 0. */
export function shotListTimings(shots: PlannedShot[]): { start: number; end: number }[] {
  let t = 0;
  return shots.map(s => { const r = { start: ROUND(t), end: ROUND(t + s.seconds) }; t += s.seconds; return r; });
}

/** Adapter bounds so that each planned shot stays ONE shot (never split, never merged). */
export function shotListAdapter(shots: PlannedShot[]): ReelAdapterOptions {
  const secs = shots.map(s => s.seconds);
  return { shotSeconds: { min: Math.min(1.5, ...secs), max: Math.max(...secs) + 0.01 } };
}

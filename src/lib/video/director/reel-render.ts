/**
 * Director plan → existing VerticalReel render, on the material the pipeline REALLY resolved (pure: no provider,
 * storage, ledger or network). Used by generate-video.ts only behind CINEMATIC_DIRECTOR_RENDER_ENABLED.
 *
 * 1. Storyboard (the real one when VISUAL_DIRECTOR_ENABLED produced it, else the deterministic simulation).
 * 2. Director input from the Reel; its PLANNED inventory is replaced by what really exists: one asset per resolved
 *    beat, with the real media type (a still is never declared as a clip), real provenance (generated image =
 *    AI recreation) and the beat's window inside its segment.
 * 3. proposePlan (recipes) → planToVerticalReel (re-audit, measured timings, per-scene direction, blockers).
 * The plan stays a proposal (executable=false, paidCalls=0): it only arranges material that already exists.
 */
import type { GeneratedScript } from "@/lib/providers/types";
import type { Storyboard } from "@/lib/video/storyboard/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import type { Caption, VerticalReelProps } from "../../../../remotion/VerticalReel";
import type { DirectorInputRaw, DirectorPlan, RecipeCatalog } from "./contract";
import { inputFromReel } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog } from "./recipes";
import { planToVerticalReel, type BridgeBlocker, type ExistingMedia, type ShotApplication } from "./render-bridge";

export type ResolvedBeat = { url: string; mediaType: "image" | "video"; source: "stock" | "fixture" | "generated"; start: number; end: number };

export type DirectedReel =
  | { ok: true; props: Omit<VerticalReelProps, "musicUrl" | "accentColor" | "showLogo">; applied: ShotApplication[]; plan: DirectorPlan; input: DirectorInputRaw; storyboardSource: "real" | "simulated" }
  | { ok: false; blockers: BridgeBlocker[]; plan: DirectorPlan | null; input: DirectorInputRaw | null; storyboardSource: "real" | "simulated" };

export function directReel(a: {
  script: GeneratedScript; storyboard?: Storyboard; beatsBySegment: ResolvedBeat[][]; sceneTimings: { start: number; end: number }[];
  audioUrl: string; captions: Caption[]; narrationGaps: VerticalReelProps["narrationGaps"]; durationSeconds: number; catalog?: RecipeCatalog;
}): DirectedReel {
  const storyboardSource = a.storyboard ? "real" as const : "simulated" as const;
  let input: DirectorInputRaw | null = null, plan: DirectorPlan | null = null;
  try {
    const sb = a.storyboard ?? simulateStoryboard(a.script);
    const raw = inputFromReel(sb);
    const scenes = [...sb.scenes].sort((x, y) => x.order - y.order);
    const media: Record<string, ExistingMedia> = {};
    const inventory: DirectorInputRaw["inventory"] = raw.inventory.flatMap(planned => {
      const segId = planned.content?.window?.segmentId ?? (planned.tags ?? []).find(t => t.startsWith("segment:"))?.slice(8);
      const idx = scenes.findIndex(s => s.id === segId);
      const beats = idx >= 0 ? a.beatsBySegment[idx] ?? [] : [];
      if (!beats.length || planned.kind === "avatar") return [planned];
      const t = a.sceneTimings[idx], span = Math.max(1e-6, t.end - t.start);
      return beats.map((b, i) => {
        const id = i === 0 ? planned.id : `${planned.id}:b${i}`;
        // Licence: stock comes from the configured stock provider's licence (Pexels: free to use, already the
        // production basis); fixtures are synthetic; a generated image is ours. All three may be rendered.
        media[id] = { url: b.url, mediaType: b.mediaType, license: "CLEARED" };
        return {
          ...planned, id,
          kind: b.mediaType === "video" ? "video" as const : "image" as const,
          motion: b.mediaType === "video" ? "real" as const : "still" as const,
          provenance: b.source === "generated" ? "ai_recreation" as const : "stock_illustrative" as const,
          license: "CLEARED" as const,
          content: { ...planned.content!, topics: planned.content?.topics ?? [], window: { segmentId: segId!, from: clamp01((b.start - t.start) / span), to: clamp01((b.end - t.start) / span) } },
        };
      });
    });
    input = { ...raw, inventory };
    const catalog = a.catalog ?? bundledRecipeCatalog();
    plan = proposePlan(input, catalog);
    const segmentTimes = Object.fromEntries(scenes.map((s, i) => [s.id, a.sceneTimings[i]]).filter(([, t]) => t));
    const bridged = planToVerticalReel({ plan, input, catalog, media, segmentTimes, audioUrl: a.audioUrl, captions: a.captions,
      durationSeconds: a.durationSeconds, narrationGaps: a.narrationGaps });
    if (!bridged.ok) return { ok: false, blockers: bridged.blockers, plan, input, storyboardSource };
    return { ok: true, props: bridged.props, applied: bridged.applied, plan, input, storyboardSource };
  } catch (err) {
    return { ok: false, blockers: [{ code: "DIRECTOR_ERROR", detail: err instanceof Error ? err.message : String(err) }], plan, input, storyboardSource };
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** One readable sentence for the user when the Director refuses to render (codes kept for support). */
export function directorBlockMessage(blockers: BridgeBlocker[]): string {
  const codes = [...new Set(blockers.map(b => b.code))];
  const first = blockers[0];
  return `El Director no pudo montar este video sin inventar material (${codes.join(", ")}): ${first?.detail ?? "motivo desconocido"}`.slice(0, 400);
}

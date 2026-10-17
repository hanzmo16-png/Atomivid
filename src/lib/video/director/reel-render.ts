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
import type { GeneratedScript, MediaLicense } from "@/lib/providers/types";
import type { Storyboard } from "@/lib/video/storyboard/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import type { Caption, VerticalReelProps } from "../../../../remotion/VerticalReel";
import type { DirectorInputRaw, DirectorPlan, RecipeCatalog } from "./contract";
import { inputFromReel, type ReelAdapterOptions } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog } from "./recipes";
import { planToVerticalReel, type BridgeBlocker, type ExistingMedia, type ShotApplication } from "./render-bridge";

/** `license` is REQUIRED (T36 C1): whoever resolves a beat must say what its licence is (beat-license.ts). */
export type ResolvedBeat = { url: string; mediaType: "image" | "video"; source: "stock" | "fixture" | "generated"; license: MediaLicense; start: number; end: number };

export type DirectedReel =
  | { ok: true; props: Omit<VerticalReelProps, "musicUrl" | "accentColor" | "showLogo">; applied: ShotApplication[]; plan: DirectorPlan; input: DirectorInputRaw; storyboardSource: "real" | "simulated" }
  | { ok: false; blockers: BridgeBlocker[]; plan: DirectorPlan | null; input: DirectorInputRaw | null; storyboardSource: "real" | "simulated" };

export function directReel(a: {
  script: GeneratedScript; storyboard?: Storyboard; beatsBySegment: ResolvedBeat[][]; sceneTimings: { start: number; end: number }[];
  audioUrl: string; captions: Caption[]; narrationGaps: VerticalReelProps["narrationGaps"]; durationSeconds: number; catalog?: RecipeCatalog;
  /** Optional adapter settings (e.g. a shot list's own shot-length bounds). Absent = historic Reel defaults. */
  adapter?: ReelAdapterOptions;
  /** Render options forwarded to the bridge (clip sound, label wording). Absent = historic behaviour. */
  clipAudio?: "off" | "recipe"; labelText?: Partial<Record<string, string>>;
}): DirectedReel {
  const storyboardSource = a.storyboard ? "real" as const : "simulated" as const;
  let input: DirectorInputRaw | null = null, plan: DirectorPlan | null = null;
  try {
    const sb = a.storyboard ?? simulateStoryboard(a.script);
    const raw = inputFromReel(sb, a.adapter);
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
        // Licence: the verdict resolved with the beat (beat-license.ts), never assumed. Anything but CLEARED makes the
        // bridge refuse the shot (LICENSE_NOT_CLEARED_FOR_RENDER) instead of rendering it.
        media[id] = { url: b.url, mediaType: b.mediaType, license: b.license };
        return {
          ...planned, id,
          kind: b.mediaType === "video" ? "video" as const : "image" as const,
          motion: b.mediaType === "video" ? "real" as const : "still" as const,
          provenance: b.source === "generated" ? "ai_recreation" as const : "stock_illustrative" as const,
          license: b.license,
          content: { ...planned.content!, topics: planned.content?.topics ?? [], window: { segmentId: segId!, from: clamp01((b.start - t.start) / span), to: clamp01((b.end - t.start) / span) } },
        };
      });
    });
    input = { ...raw, inventory };
    const catalog = a.catalog ?? bundledRecipeCatalog();
    plan = proposePlan(input, catalog);
    const segmentTimes = Object.fromEntries(scenes.map((s, i) => [s.id, a.sceneTimings[i]]).filter(([, t]) => t));
    const bridged = planToVerticalReel({ plan, input, catalog, media, segmentTimes, audioUrl: a.audioUrl, captions: a.captions,
      durationSeconds: a.durationSeconds, narrationGaps: a.narrationGaps, clipAudio: a.clipAudio, labelText: a.labelText });
    if (!bridged.ok) return { ok: false, blockers: bridged.blockers, plan, input, storyboardSource };
    return { ok: true, props: bridged.props, applied: bridged.applied, plan, input, storyboardSource };
  } catch (err) {
    return { ok: false, blockers: [{ code: "DIRECTOR_ERROR", detail: err instanceof Error ? err.message : String(err) }], plan, input, storyboardSource };
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const RIGHTS_BLOCKERS = new Set(["LICENSE_NOT_CLEARED_FOR_RENDER", "MATERIAL_NOT_AUTHORISED"]);
const CONTRACT_BLOCKERS = new Set(["CONTRACT_INVALID", "DIRECTOR_ERROR", "LABEL_NOT_RENDERABLE"]);

/**
 * One readable, actionable sentence when the Director refuses to render (codes kept for support). T-34 B3: by
 * category — material and rights problems say which shot and what to change; contract/internal errors go to support.
 * Never promises a refund: what this attempt already used is shown by the attempt state, not by this text.
 */
export function directorBlockMessage(blockers: BridgeBlocker[]): string {
  const codes = [...new Set(blockers.map(b => b.code))];
  const first = blockers.find(b => RIGHTS_BLOCKERS.has(b.code)) ?? blockers[0];
  const shot = first?.shotId ? ` (plano ${first.shotId})` : "";
  const action = codes.some(c => CONTRACT_BLOCKERS.has(c))
    ? "Qué hacer: es un fallo interno del Director; contacta a soporte con el código del intento."
    : codes.some(c => RIGHTS_BLOCKERS.has(c))
      ? `Problema de derechos o licencia del material${shot}: no se usó. Qué hacer: cambia esa escena del guion para que use otro material, o pide soporte para revisar la licencia.`
      : `Falta material visual adecuado${shot}. Qué hacer: ajusta la escena (descripción visual más concreta o más breve) y vuelve a generar.`;
  const head = `El Director no pudo montar este video sin inventar material (${codes.join(", ")}): ${(first?.detail ?? "motivo desconocido").slice(0, 160)}.`;
  return `${head} ${action} No se publicó ningún video con montaje clásico.`.slice(0, 600);
}

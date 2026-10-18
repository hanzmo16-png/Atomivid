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
import { cardAssetId, dataCardAsset, extractFigures, MIN_CARD_SECONDS, withDataCards, type DataCardPlan, type Figure, type NeutralReason } from "./data-card";
import { inputFromReel, type ReelAdapterOptions } from "./from-reel";
import { proposePlan } from "./propose";
import { bundledRecipeCatalog } from "./recipes";
import { planToVerticalReel, type BridgeBlocker, type ExistingMedia, type ShotApplication } from "./render-bridge";

/** `license` is REQUIRED (T36 C1): whoever resolves a beat must say what its licence is (beat-license.ts).
 *  `data_card` (T42): a deterministic data card rendered by the pipeline itself (data-card.ts), never a provider asset;
 *  `card` (T44) is the claim it shows and the narration it covers, so the Director binds the card to that window. */
export type ResolvedBeat = {
  url: string; mediaType: "image" | "video"; source: "stock" | "fixture" | "generated" | "data_card"; license: MediaLicense; start: number; end: number;
  /** Correction 2: `treatment: "neutral"` = the figure-less slate for this window (no claim, no figure); absent = card. */
  card?: { text: string; windowText: string; figures: Figure[]; treatment?: "card" | "neutral"; neutralReason?: NeutralReason;
    /** T44 F3: how start/end were obtained (cardWindows); absent = unknown, reported as estimated. */
    timing?: "word_timestamps" | "estimated_proportional" };
};

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
    // The storyboard estimate belongs to preflight. Once narration exists, both the cut count and
    // inventory windows must use its measured clock. Otherwise a fast delivery can resolve one beat
    // while the estimate requests two shots, exhausting existing material and proposing a paid image.
    if (a.sceneTimings.length !== scenes.length || a.sceneTimings.some(t =>
      !Number.isFinite(t.start) || !Number.isFinite(t.end) || t.start < 0 || t.end <= t.start)) {
      return { ok: false, blockers: [{ code: "INVALID_TIME", detail: "faltan tiempos medidos válidos para las escenas" }], plan, input, storyboardSource };
    }
    const segments = raw.segments.map((seg, i) => ({ ...seg, start: a.sceneTimings[i].start, end: a.sceneTimings[i].end }));
    const media: Record<string, ExistingMedia> = {};
    // T44: a scene resolved entirely as data cards becomes one Director segment PER CARD (the claim and the measured
    // narration window it covers), so a card is only ever planned next to its own claim: "30 %" cannot stay on screen
    // while "70 %" is narrated. Its planned stock is replaced by the cards (withDataCards).
    const cardPlans: DataCardPlan[] = [];
    const cardTimes: Record<string, { start: number; end: number }[]> = {};
    const shortCards: BridgeBlocker[] = [];
    scenes.forEach((sc, idx) => {
      const beats = a.beatsBySegment[idx] ?? [];
      const seg = raw.segments[idx];
      if (!seg || !beats.length || !beats.every(b => b.source === "data_card")) return;
      const n = Math.max(1, (seg.text.match(/\S+/g) ?? []).length);
      beats.forEach((b, k) => {
        const neutral = b.card?.treatment === "neutral";
        // Correction 2 (GATE 2): a numeric card may not dress a window shorter than MIN_CARD_SECONDS; that window takes
        // the neutral slate (generate-video builds it so). Any other caller offering a figure for it is refused here,
        // fail-closed, never accepted as an ordinary card and never stretched.
        if (!neutral && b.end - b.start < MIN_CARD_SECONDS) {
          const figures = (b.card?.figures ?? extractFigures(b.card?.text ?? seg.text)).map(f => f.display).join(" · ");
          shortCards.push({ code: "CARD_WINDOW_SHORT", shotId: `${sc.id}#${k + 1}`, detail: `tarjeta numérica «${figures || seg.text.slice(0, 40)}» en una ventana de ${Math.round((b.end - b.start) * 1000)} ms (< ${Math.round(MIN_CARD_SECONDS * 1000)} ms): esa ventana debe llevar la tarjeta neutral sin cifra` });
        }
        const text = neutral ? "" : b.card?.text ?? seg.text, windowText = b.card?.windowText ?? seg.text, figures = neutral ? [] : b.card?.figures ?? extractFigures(text);
        cardPlans.push({ sceneIndex: idx, segmentId: sc.id, index: k, count: beats.length, text, figures, figure: figures[0] ?? null, windowText, fromToken: 0, toToken: n, tokenCount: n, from: 0, to: 1,
          ...(b.card?.timing ? { timing: b.card.timing } : {}),
          ...(neutral ? { treatment: "neutral" as const, neutralReason: b.card?.neutralReason ?? "short_window" as const } : {}) });
        media[cardAssetId(sc.id, k, beats.length)] = { url: b.url, mediaType: b.mediaType, license: b.license };
      });
      cardTimes[sc.id] = beats.map(b => ({ start: b.start, end: b.end }));
    });
    if (shortCards.length) return { ok: false, blockers: shortCards, plan, input, storyboardSource };
    const cardScenes = new Set(cardPlans.map(c => c.segmentId));
    const inventory: DirectorInputRaw["inventory"] = raw.inventory.flatMap(planned => {
      const segId = planned.content?.window?.segmentId ?? (planned.tags ?? []).find(t => t.startsWith("segment:"))?.slice(8);
      const idx = scenes.findIndex(s => s.id === segId);
      const beats = idx >= 0 ? a.beatsBySegment[idx] ?? [] : [];
      if (!beats.length || planned.kind === "avatar" || (segId && cardScenes.has(segId))) return [planned];
      const t = a.sceneTimings[idx], span = Math.max(1e-6, t.end - t.start);
      return beats.map((b, i) => {
        const id = i === 0 ? planned.id : `${planned.id}:b${i}`;
        // Licence: the verdict resolved with the beat (beat-license.ts), never assumed. Anything but CLEARED makes the
        // bridge refuse the shot (LICENSE_NOT_CLEARED_FOR_RENDER) instead of rendering it.
        media[id] = { url: b.url, mediaType: b.mediaType, license: b.license };
        // T42: a data card is a deterministic graphic of this segment's own sentence (policy: measurable data).
        if (b.source === "data_card") {
          const card = dataCardAsset({ id: segId!, text: raw.segments.find(s => s.id === segId)?.text ?? "" }, id);
          return { ...card, license: b.license, content: { ...card.content!, window: { segmentId: segId!, from: clamp01((b.start - t.start) / span), to: clamp01((b.end - t.start) / span) } } };
        }
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
    input = { ...withDataCards({ ...raw, segments, inventory }, cardPlans, cardTimes), totalSeconds: segments.at(-1)?.end ?? 0 };
    const catalog = a.catalog ?? bundledRecipeCatalog();
    plan = proposePlan(input, catalog);
    const segmentTimes = Object.fromEntries(input.segments.map(s => [s.id, { start: s.start, end: s.end }]));
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
const CONTRACT_BLOCKERS = new Set(["CONTRACT_INVALID", "DIRECTOR_ERROR", "LABEL_NOT_RENDERABLE", "CARD_WINDOW_SHORT"]);
const EDITORIAL_BLOCKERS = new Set(["AUDIT_POLICY_REVIEW", "AUDIT_POLICY_VIOLATION", "AUDIT_FACTUAL_MISMATCH", "AUDIT_DECISION_PENDING", "AUDIT_NO_MATERIAL"]);

/**
 * T42: the stored message is sanitised for the customer (customer-error.ts replaces UPPER_CASE identifiers with
 * «[configuración interna]»), so no code may appear in it. Codes travel in director.json and the worker log; here
 * each one becomes plain words, and the detail text loses any upper-case identifier the same way.
 */
const CODE_WORDS: Record<string, string> = {
  AUDIT_POLICY_REVIEW: "revisión editorial pendiente", AUDIT_POLICY_VIOLATION: "política editorial", AUDIT_FACTUAL_MISMATCH: "correspondencia factual",
  AUDIT_DECISION_PENDING: "decisión editorial pendiente", AUDIT_NO_MATERIAL: "plano sin material", AUDIT_LICENSE_PENDING: "licencia pendiente", AUDIT_LICENSE_NOT_CLEARED: "licencia no autorizada",
  MEDIA_MISSING: "material faltante", MATERIAL_NOT_AUTHORISED: "material nuevo no autorizado", LICENSE_NOT_CLEARED_FOR_RENDER: "licencia no autorizada",
  REAL_MOTION_WITHOUT_CLIP: "movimiento prometido sin clip", INVALID_TIME: "tiempos no válidos", TIMING_MISSING: "tiempos no medidos", TIMELINE_GAP: "hueco en la línea de tiempo", DURATION_SHORT: "duración corta",
  CONTRACT_INVALID: "contrato inválido", DIRECTOR_ERROR: "error interno", LABEL_NOT_RENDERABLE: "etiqueta no representable", ASPECT_MISMATCH: "formato no compatible",
  CARD_WINDOW_SHORT: "tarjeta numérica en una ventana demasiado breve",
};
export const plainWords = (s: string) => s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (m) => CODE_WORDS[m] ?? m.toLowerCase().replace(/_/g, " "));

/**
 * One readable, actionable sentence when the Director refuses to render (codes kept for support in director.json and
 * the log, never in this text). T-34 B3: by category — material and rights problems say which shot and what to
 * change; editorial blocks say which sentence to rewrite; contract/internal errors go to support.
 * Never promises a refund: what this attempt already used is shown by the attempt state, not by this text.
 */
export function directorBlockMessage(blockers: BridgeBlocker[]): string {
  const codes = [...new Set(blockers.map(b => b.code))];
  const first = blockers.find(b => RIGHTS_BLOCKERS.has(b.code)) ?? blockers.find(b => EDITORIAL_BLOCKERS.has(b.code)) ?? blockers[0];
  const shot = first?.shotId ? ` (plano ${first.shotId})` : "";
  const action = codes.some(c => CONTRACT_BLOCKERS.has(c))
    ? "Qué hacer: es un fallo interno del Director; contacta a soporte con el código del intento."
    : codes.some(c => RIGHTS_BLOCKERS.has(c))
      ? `Problema de derechos o licencia del material${shot}: no se usó. Qué hacer: cambia esa escena del guion para que use otro material, o pide soporte para revisar la licencia.`
      : codes.some(c => EDITORIAL_BLOCKERS.has(c))
        ? `La frase de ese plano${shot} necesita evidencia real o una tarjeta determinista que este Reel no tiene. Qué hacer: reformula esa frase en el guion (o quita la cifra, fecha o referencia que no pueda verse en una tarjeta) y vuelve a generar.`
        : `Falta material visual adecuado${shot}. Qué hacer: ajusta la escena (descripción visual más concreta o más breve) y vuelve a generar.`;
  const why = codes.map(c => CODE_WORDS[c] ?? plainWords(c)).join(", ");
  const head = `El Director no pudo montar este video sin inventar material (${why}): ${plainWords((first?.detail ?? "motivo desconocido").slice(0, 160))}.`;
  return `${head} ${action} No se publicó ningún video con montaje clásico.`.slice(0, 600);
}

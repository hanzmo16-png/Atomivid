/**
 * T42 — measurable data in a Reel under the Director: a deterministic DATA CARD instead of an illustrative clip.
 *
 * The documentary policy (policy.ts) classes a narrative unit with a figure, a date or a place as `measurable_data`
 * and only accepts real evidence or a deterministic graphic for it; planned illustrative stock is "allowed with
 * review", which the render bridge turns into a hard blocker AFTER the narration was synthesised (second pilot,
 * 2026-10-18: `AUDIT_POLICY_REVIEW` on scene-0-s1). This module closes that gap in two places, both pure:
 *
 *  1. `directorReelPreflight(script)` — BEFORE anything is reserved or paid — says which scenes get a data card and
 *     which sentences the Director cannot honour at all (human remains, specific evidence) so the worker and the
 *     render route stop before spending, with an explanation the user can act on in the script editor.
 *  2. `dataCardSvg` / `dataCardAsset` — the card itself: the exact figure as written in the script, in large
 *     deterministic typography, with the sentence underneath. No model, no provider, no network, no bytes invented.
 */
import type { GeneratedScript } from "@/lib/providers/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { DirectorInputSchema, type DirectorInput, type DirectorInputRaw, type InventoryAsset } from "./contract";
import { inputFromReel } from "./from-reel";
import { topicsOf, treatmentAllowed, unitPolicy, words } from "./policy";
import { unitsFor } from "./propose";

export const DATA_CARD_RECIPE_ID = "reel-data-card";

export type Figure = { display: string; kind: "percent" | "times" | "year" | "quantity" | "number" };

const NUM = "(\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d+)?)";
const PATTERNS: { kind: Figure["kind"]; re: RegExp; display: (m: RegExpMatchArray) => string }[] = [
  { kind: "percent", re: new RegExp(`${NUM}\\s*(%|por ciento|porciento)`, "i"), display: (m) => `${m[1]} %` },
  { kind: "times", re: new RegExp(`${NUM}\\s*(veces)\\b`, "i"), display: (m) => `${m[1]} veces` },
  { kind: "quantity", re: new RegExp(`${NUM}\\s*(millones|millón|millon|mil|metros|kilómetros|kilometros|km|horas|minutos|segundos|días|dias|años|anos|semanas|meses|euros|dólares|dolares|personas|toneladas|kilos)\\b`, "i"), display: (m) => `${m[1]} ${m[2].toLowerCase()}` },
  { kind: "year", re: /\b(1\d{3}|20\d{2})\b/, display: (m) => m[1] },
  { kind: "number", re: new RegExp(`\\b${NUM}\\b`), display: (m) => m[1] },
];

/** The first measurable figure of a sentence, exactly as written (never computed, never rounded). */
export function extractFigure(text: string): Figure | null {
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return { kind: p.kind, display: p.display(m) };
  }
  return null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) { out.push(line); line = w; } else line = next;
    if (out.length === maxLines) break;
  }
  if (line && out.length < maxLines) out.push(line);
  if (out.length === maxLines && text.split(/\s+/).join(" ").length > out.join(" ").length) out[maxLines - 1] = `${out[maxLines - 1].replace(/[.,;:]?$/, "")}…`;
  return out;
}

export const DATA_CARD_WIDTH = 1080;
export const DATA_CARD_HEIGHT = 1920;

/**
 * Deterministic 9:16 card: the figure (when there is one) in large type, the sentence as written, a footer that says
 * where the datum comes from. Same input → byte-identical SVG. Everything is escaped; nothing external is loaded.
 */
export function dataCardSvg(a: { text: string; figure: Figure | null; accent?: string }): string {
  const accent = /^#[0-9a-f]{6}$/i.test(a.accent ?? "") ? a.accent! : "#f2b705";
  const figure = a.figure?.display ?? null;
  const figureSize = !figure ? 0 : figure.length <= 5 ? 240 : figure.length <= 9 ? 170 : 120;
  const lines = wrap(a.text.trim(), 26, 5);
  const lineH = 72;
  const textTop = figure ? 1010 : 760;
  const textLines = lines.map((l, i) => `<text x="540" y="${textTop + i * lineH}" font-size="56" fill="#f4f4f4" text-anchor="middle" font-family="sans-serif">${esc(l)}</text>`).join("");
  const figureEl = figure
    ? `<text x="540" y="860" font-size="${figureSize}" font-weight="700" fill="${accent}" text-anchor="middle" font-family="sans-serif">${esc(figure)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DATA_CARD_WIDTH}" height="${DATA_CARD_HEIGHT}" viewBox="0 0 ${DATA_CARD_WIDTH} ${DATA_CARD_HEIGHT}">`
    + `<rect width="100%" height="100%" fill="#101418"/>`
    + `<rect x="120" y="${figure ? 560 : 640}" width="60" height="10" fill="${accent}"/>`
    + figureEl + textLines
    + `<text x="540" y="1700" font-size="34" fill="#9aa3ad" text-anchor="middle" font-family="sans-serif">Dato tal como aparece en el guion · tarjeta determinista</text>`
    + `</svg>`;
}

/**
 * The card as a Director inventory asset: a deterministic graphic planned for the whole segment. `diagram` (not
 * `text`) on purpose: only the data-card recipe dresses diagrams in a Reel, so a title recipe with a 3 s limit never
 * takes the shot and rotation cannot swap it out. The policy accepts any `data_graphic` for measurable data.
 */
export function dataCardAsset(seg: { id: string; text: string }, id = `${seg.id}:card`): InventoryAsset {
  const figure = extractFigure(seg.text);
  return {
    id, kind: "graphic", provenance: "data_graphic", motion: "still", license: "CLEARED",
    tags: [`segment:${seg.id}`, "tarjeta", "dato", ...words(seg.text)],
    content: {
      visualType: "diagram", topics: topicsOf(seg.text), bibleClass: "DETERMINISTIC",
      visualIntent: figure ? `tarjeta determinista con el dato «${figure.display}» tal como lo dice el guion` : "tarjeta determinista con la frase del guion",
      description: seg.text, window: { segmentId: seg.id, from: 0, to: 1 },
    },
  };
}

export type DataCardPlan = { sceneIndex: number; segmentId: string; text: string; figure: Figure | null };
export type PreflightBlocker = { sceneIndex: number; segmentId: string; sentence: string; policyClass: string; reason: string; hint: string };
export type ReelPreflight = { cards: DataCardPlan[]; blockers: PreflightBlocker[] };

const HINTS: Record<string, string> = {
  human_remains: "la frase habla de restos humanos y un Reel no dispone de evidencia real para mostrarlos: reformula la frase o quítala",
  specific_evidence: "la frase nombra evidencia concreta (pilares, estructuras, relieves u objetos) que el material ilustrativo no puede presentar como vista: reformula la frase sin mostrar esa evidencia",
};

/**
 * Pure, pre-spend: the same storyboard, units and policy the Director will apply at render time, evaluated on the
 * approved script alone. `cards`: segments that get a deterministic data card (figure/date/place). `blockers`:
 * sentences the Director cannot honour in a Reel with any material it may use; the caller stops BEFORE reserving
 * or synthesising anything and tells the user which sentence to change.
 */
export function directorReelPreflight(script: GeneratedScript): ReelPreflight {
  const sb = simulateStoryboard(script);
  const raw = inputFromReel(sb);
  const input: DirectorInput = DirectorInputSchema.parse(raw);
  const scenes = [...sb.scenes].sort((a, b) => a.order - b.order);
  const cards: DataCardPlan[] = [];
  const blockers: PreflightBlocker[] = [];
  input.segments.forEach((seg, sceneIndex) => {
    if (seg.locked) return;
    const units = unitsFor(seg, input.constraints.minShotSeconds, input.constraints.maxShotSeconds);
    for (const u of units) {
      const pol = unitPolicy(input, seg, u.text);
      if (pol.class === "measurable_data") {
        if (!cards.some((c) => c.segmentId === seg.id)) cards.push({ sceneIndex, segmentId: seg.id, text: seg.text, figure: extractFigure(seg.text) });
        continue;
      }
      if (pol.class !== "human_remains" && pol.class !== "specific_evidence") continue;
      // What the render will really offer this unit: planned illustrative stock (the only free material of a Reel).
      const v = treatmentAllowed(pol, { provenance: "stock_illustrative", visual: "concept", isNew: false, plannedForSegment: true, topicMatch: true, neutral: false }, true);
      if (v.allowed && !v.review) continue;
      if (blockers.some((b) => b.segmentId === seg.id)) continue;
      blockers.push({ sceneIndex, segmentId: seg.id, sentence: u.text, policyClass: pol.class, reason: v.review ?? v.reason, hint: HINTS[pol.class] });
    }
  });
  void scenes;
  return { cards, blockers };
}

/** Inspection/preflight input with the data cards in place of the planned stock of their segments. */
export function withDataCards(raw: DirectorInputRaw, cards: DataCardPlan[]): DirectorInputRaw {
  if (!cards.length) return raw;
  const bySeg = new Map(cards.map((c) => [c.segmentId, c]));
  const inventory = raw.inventory.flatMap((a) => {
    const segId = a.content?.window?.segmentId ?? (a.tags ?? []).find((t) => t.startsWith("segment:"))?.slice(8);
    const card = segId ? bySeg.get(segId) : undefined;
    if (!card || a.kind === "avatar") return [a];
    return [dataCardAsset({ id: card.segmentId, text: card.text })];
  });
  return { ...raw, inventory };
}

/** Thrown BEFORE any reservation or provider call when the script has sentences the Director cannot honour. */
export class DirectorPreflightBlockedError extends Error {
  override name = "DirectorPreflightBlockedError";
  constructor(readonly blockers: PreflightBlocker[]) {
    super(preflightBlockMessage(blockers));
  }
}

/** Plain words only (no codes, no internal names): which scene, which sentence, what to change. */
export function preflightBlockMessage(blockers: PreflightBlocker[]): string {
  const items = blockers.slice(0, 3).map((b) => `escena ${b.sceneIndex + 1} («${b.sentence.slice(0, 80)}${b.sentence.length > 80 ? "…" : ""}»): ${b.hint}`);
  const more = blockers.length > 3 ? ` Y ${blockers.length - 3} escena(s) más con el mismo tipo de problema.` : "";
  return `El Director no puede montar este Reel con el guion actual y se detuvo antes de generar voz o gastar nada. ${items.join(" ")}.${more} Edita el guion y vuelve a generar; si crees que la frase es correcta, pide soporte.`.slice(0, 600);
}

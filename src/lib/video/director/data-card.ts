/**
 * T42/T44 — measurable data in a Reel under the Director: a deterministic DATA CARD instead of an illustrative clip.
 *
 * The documentary policy (policy.ts) classes a narrative unit with a figure, a date or a place as `measurable_data`
 * and only accepts real evidence or a deterministic graphic for it; planned illustrative stock is "allowed with
 * review", which the render bridge turns into a hard blocker AFTER the narration was synthesised (second pilot,
 * 2026-10-18: `AUDIT_POLICY_REVIEW` on scene-0-s1). This module closes that gap in two places, both pure:
 *
 *  1. `directorReelPreflight(script)` — BEFORE anything is reserved or paid — says which CLAIMS get a data card and
 *     which sentences the Director cannot honour at all (human remains, several figures in one clause) so the worker
 *     and the render route stop before spending, with an explanation the user can act on in the script editor.
 *  2. `dataCardSvg` / `dataCardAsset` — the card itself: the exact figures as written in the script, in narration
 *     order, in large deterministic typography, with the claim underneath. No model, no provider, no network.
 *
 * T44 (independent review of PR #137, findings A and B):
 *  - A card is bound to ONE claim and to the narration window of that claim (word timestamps when the voice has them,
 *    proportional otherwise). A scene with two claims ("En 2019, el 30 % …; en 2020, el 70 % …") gets two cards and
 *    the Director plans each as its own segment, so the "30 %" card can never stay on screen while "70 %" is said.
 *    A clause that packs several values and cannot be split is refused BEFORE spend (no representation is invented).
 *  - A card transcribes the script; it never attests the figure. The SVG and the inventory asset say so
 *    ("dato del guion, sin fuente verificada") and nothing in the plan may read it as documentary evidence.
 */
import type { GeneratedScript } from "@/lib/providers/types";
import { simulateStoryboard } from "@/lib/video/storyboard/simulate";
import { DirectorInputSchema, type DirectorInput, type DirectorInputRaw, type InventoryAsset } from "./contract";
import { inputFromReel } from "./from-reel";
import { topicsOf, treatmentAllowed, unitPolicy, words } from "./policy";
import { unitsFor } from "./propose";

export const DATA_CARD_RECIPE_ID = "reel-data-card";
/** What a card is and is not, in the words shown on screen and recorded in director.json. */
export const DATA_CARD_PROVENANCE_TEXT = "Dato del guion · sin fuente verificada · tarjeta determinista";

export type Figure = { display: string; kind: "percent" | "times" | "year" | "quantity" | "number" };
type FigureAt = Figure & { index: number; end: number };

const NUM = "(\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d+)?)";
const NUM_G = new RegExp(`(?<![\\w,.])${NUM}(?![\\w])`, "g");
const UNIT = /^\s*(millones|millón|millon|mil|metros|kilómetros|kilometros|km|horas|minutos|segundos|días|dias|años|anos|semanas|meses|euros|dólares|dolares|personas|toneladas|kilos|litros|grados)\b/i;
const PERCENT = /^\s*(%|por ciento|porciento)/i;
const TIMES = /^\s*veces\b/i;

/** Every figure of a text, in narration order, exactly as written (never computed, never rounded). */
export function extractFigures(text: string): Figure[] {
  return figuresAt(text).map(({ display, kind }) => ({ display, kind }));
}
function figuresAt(text: string): FigureAt[] {
  const out: FigureAt[] = [];
  for (const m of text.matchAll(NUM_G)) {
    const raw = m[1], index = m.index!, rest = text.slice(index + raw.length);
    let kind: Figure["kind"], display = raw, end = index + raw.length;
    const p = rest.match(PERCENT), t = rest.match(TIMES), u = rest.match(UNIT);
    if (p) { kind = "percent"; display = `${raw} %`; end += p[0].length; }
    else if (t) { kind = "times"; display = `${raw} veces`; end += t[0].length; }
    else if (u) { kind = "quantity"; display = `${raw} ${u[1].toLowerCase()}`; end += u[0].length; }
    else if (/^(1\d{3}|20\d{2})$/.test(raw)) kind = "year";
    else kind = "number";
    out.push({ kind, display, index, end });
  }
  return out;
}
/** The first figure of a sentence in narration order, or null. */
export function extractFigure(text: string): Figure | null {
  return extractFigures(text)[0] ?? null;
}
const isValue = (f: Figure) => f.kind !== "year";
/** The hero line of a card: the claim's figures in narration order (a year next to its value stays with it). */
export function heroOf(figures: Figure[]): string | null {
  return figures.length ? figures.slice(0, 3).map(f => f.display).join(" · ") : null;
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
 * Deterministic 9:16 card: the claim's figures (when there are any) in large type, the claim as written, and the
 * provenance line that says it is a transcription of the script, not verified evidence. Same input → byte-identical
 * SVG. Everything is escaped; nothing external is loaded (no href, no url(), no script).
 */
export function dataCardSvg(a: { text: string; figure: Figure | null; figures?: Figure[]; accent?: string }): string {
  const accent = /^#[0-9a-f]{6}$/i.test(a.accent ?? "") ? a.accent! : "#f2b705";
  const hero = a.figures ? heroOf(a.figures) : a.figure?.display ?? null;
  const figureSize = !hero ? 0 : hero.length <= 5 ? 240 : hero.length <= 9 ? 170 : hero.length <= 14 ? 120 : 84;
  const lines = wrap(a.text.trim(), 26, 5);
  const lineH = 72;
  const textTop = hero ? 1010 : 760;
  const textLines = lines.map((l, i) => `<text x="540" y="${textTop + i * lineH}" font-size="56" fill="#f4f4f4" text-anchor="middle" font-family="sans-serif">${esc(l)}</text>`).join("");
  const figureEl = hero
    ? `<text x="540" y="860" font-size="${figureSize}" font-weight="700" fill="${accent}" text-anchor="middle" font-family="sans-serif">${esc(hero)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DATA_CARD_WIDTH}" height="${DATA_CARD_HEIGHT}" viewBox="0 0 ${DATA_CARD_WIDTH} ${DATA_CARD_HEIGHT}">`
    + `<rect width="100%" height="100%" fill="#101418"/>`
    + `<text x="540" y="470" font-size="36" fill="#9aa3ad" text-anchor="middle" font-family="sans-serif" letter-spacing="6">DATO DEL GUION</text>`
    + `<rect x="120" y="${hero ? 560 : 640}" width="60" height="10" fill="${accent}"/>`
    + figureEl + textLines
    + `<text x="540" y="1700" font-size="34" fill="#9aa3ad" text-anchor="middle" font-family="sans-serif">${esc(DATA_CARD_PROVENANCE_TEXT)}</text>`
    + `</svg>`;
}

/**
 * The card as a Director inventory asset: a deterministic graphic planned for the whole (sub)segment it belongs to.
 * `diagram` (not `text`) on purpose: only the data-card recipe dresses diagrams in a Reel, so a title recipe with a
 * 3 s limit never takes the shot and rotation cannot swap it out. The policy accepts any `data_graphic` for
 * measurable data. The intent and the tag say what the card is: a transcription of the script, never evidence.
 */
export function dataCardAsset(seg: { id: string; text: string }, id = `${seg.id}:card`, card?: { windowText: string; figures: Figure[] }): InventoryAsset {
  const figures = card?.figures ?? extractFigures(seg.text);
  const hero = heroOf(figures);
  const context = card?.windowText ?? seg.text;
  return {
    id, kind: "graphic", provenance: "data_graphic", motion: "still", license: "CLEARED",
    tags: [`segment:${seg.id}`, "tarjeta", "dato", "sin-fuente-verificada", ...words(context)],
    content: {
      visualType: "diagram", topics: topicsOf(context), bibleClass: "DETERMINISTIC",
      visualIntent: hero ? `tarjeta determinista con el dato «${hero}» tal como lo dice el guion; sin fuente verificada: no acredita la cifra` : "tarjeta determinista con la frase del guion; sin fuente verificada",
      description: seg.text, window: { segmentId: seg.id, from: 0, to: 1 },
    },
  };
}

/** One statement of a scene, with the figures it carries and its token span inside the scene text. */
export type Claim = { text: string; fromToken: number; toToken: number; figures: Figure[]; representable: boolean };

const STRONG = /[.;:!?…]["»”)]?$/;
const CLAUSE_END = /[,—–)]["»”]?$/;
const CLAUSE_START = /^[—–(]/;

/**
 * Claims of a sentence/scene text: cut at sentence ends (. ; : ! ?); a piece with two or more VALUES (percent, times,
 * quantity, bare number — years are context, not values) is cut again at clause boundaries (, — –), figure-less
 * lead-ins joining the piece that follows. A piece that still holds two values is not representable by one card.
 */
export function claimsOf(text: string): Claim[] {
  const tokens = [...text.matchAll(/\S+/g)];
  if (!tokens.length) return [];
  const figs = figuresAt(text);
  const span = (from: number, to: number) => {
    const first = tokens[from], last = tokens[to - 1];
    const a = first.index!, b = last.index! + last[0].length;
    return { text: text.slice(a, b), fromToken: from, toToken: to, figures: figs.filter(f => f.index >= a && f.end <= b).map(({ display, kind }) => ({ display, kind })) };
  };
  const cut = (from: number, to: number, isEnd: (k: number) => boolean) => {
    const pieces: [number, number][] = []; let a = from;
    for (let k = from + 1; k <= to; k++) if (k === to || isEnd(k)) { pieces.push([a, k]); a = k; }
    return pieces;
  };
  const sentences = cut(0, tokens.length, k => STRONG.test(tokens[k - 1][0]));
  const out: Claim[] = [];
  for (const [a, b] of sentences) {
    const whole = span(a, b);
    if (whole.figures.filter(isValue).length < 2) { out.push({ ...whole, representable: true }); continue; }
    const pieces = cut(a, b, k => CLAUSE_END.test(tokens[k - 1][0]) || CLAUSE_START.test(tokens[k][0]));
    // Lead-ins without a figure ("En 2019," is a figure; "Según el estudio," is not) join the piece that follows.
    const merged: [number, number][] = [];
    for (const p of pieces) {
      const prev = merged[merged.length - 1];
      if (prev && span(prev[0], prev[1]).figures.length === 0) prev[1] = p[1]; else merged.push([...p]);
    }
    if (merged.length > 1 && span(merged[merged.length - 1][0], merged[merged.length - 1][1]).figures.length === 0) { const last = merged.pop()!; merged[merged.length - 1][1] = last[1]; }
    for (const [x, y] of merged) { const c = span(x, y); out.push({ ...c, representable: c.figures.filter(isValue).length < 2 }); }
  }
  return out;
}

export type DataCardPlan = {
  sceneIndex: number; segmentId: string;
  /** Position of this card inside its scene (0-based) and how many cards the scene has. */
  index: number; count: number;
  /** The claim shown on the card and its figures, exactly as written. */
  text: string; figures: Figure[]; figure: Figure | null;
  /** The narration covered by the card (the claim plus any figure-less lead-in), as text and as token span / fraction. */
  windowText: string; fromToken: number; toToken: number; tokenCount: number; from: number; to: number;
};
export type PreflightBlocker = { sceneIndex: number; segmentId: string; sentence: string; policyClass: string; reason: string; hint: string };
export type ReelPreflight = { cards: DataCardPlan[]; blockers: PreflightBlocker[] };

const HINTS: Record<string, string> = {
  human_remains: "la frase habla de restos humanos y un Reel no dispone de evidencia real para mostrarlos: reformula la frase o quítala",
  specific_evidence: "la frase nombra evidencia concreta (pilares, estructuras, relieves u objetos) que el material ilustrativo no puede presentar como vista: reformula la frase sin mostrar esa evidencia",
  several_values: "la frase junta varias cifras en una misma cláusula y una tarjeta no puede mostrar cada una en el momento en que se dice: reparte las cifras en frases separadas (una cifra por frase)",
};

/**
 * Pure, pre-spend: the same storyboard, units and policy the Director will apply at render time, evaluated on the
 * approved script alone. `cards`: one per claim with a figure in every scene the policy classes as measurable data
 * (a measurable scene without any written figure gets one card with its sentence). The cards of a scene partition
 * its narration: boundaries at the start of each claim. `blockers`: sentences the Director cannot honour in a Reel
 * with any material it may use; the caller stops BEFORE reserving or synthesising anything.
 */
export function directorReelPreflight(script: GeneratedScript): ReelPreflight {
  const sb = simulateStoryboard(script);
  const raw = inputFromReel(sb);
  const input: DirectorInput = DirectorInputSchema.parse(raw);
  const cards: DataCardPlan[] = [];
  const blockers: PreflightBlocker[] = [];
  input.segments.forEach((seg, sceneIndex) => {
    if (seg.locked) return;
    const units = unitsFor(seg, input.constraints.minShotSeconds, input.constraints.maxShotSeconds);
    let measurable = false;
    for (const u of units) {
      const pol = unitPolicy(input, seg, u.text);
      if (pol.class === "measurable_data") { measurable = true; continue; }
      if (pol.class !== "human_remains" && pol.class !== "specific_evidence") continue;
      // What the render will really offer this unit: planned illustrative stock (the only free material of a Reel).
      const v = treatmentAllowed(pol, { provenance: "stock_illustrative", visual: "concept", isNew: false, plannedForSegment: true, topicMatch: true, neutral: false }, true);
      if (v.allowed && !v.review) continue;
      if (blockers.some((b) => b.segmentId === seg.id)) continue;
      blockers.push({ sceneIndex, segmentId: seg.id, sentence: u.text, policyClass: pol.class, reason: v.review ?? v.reason, hint: HINTS[pol.class] });
    }
    if (!measurable) return;
    const tokens = [...seg.text.matchAll(/\S+/g)];
    const n = tokens.length || 1;
    const claims = claimsOf(seg.text);
    const bad = claims.find(c => !c.representable);
    if (bad) { blockers.push({ sceneIndex, segmentId: seg.id, sentence: bad.text, policyClass: "measurable_data", reason: "varias cifras en una misma cláusula", hint: HINTS.several_values }); return; }
    const figured = claims.filter(c => c.figures.length);
    const slice = (from: number, to: number) => seg.text.slice(tokens[from].index!, tokens[to - 1].index! + tokens[to - 1][0].length);
    if (!figured.length) {
      cards.push({ sceneIndex, segmentId: seg.id, index: 0, count: 1, text: seg.text.trim(), figures: [], figure: null, windowText: seg.text.trim(), fromToken: 0, toToken: n, tokenCount: n, from: 0, to: 1 });
      return;
    }
    figured.forEach((c, k) => {
      const fromToken = k === 0 ? 0 : c.fromToken, toToken = k === figured.length - 1 ? n : figured[k + 1].fromToken;
      cards.push({ sceneIndex, segmentId: seg.id, index: k, count: figured.length, text: c.text, figures: c.figures, figure: c.figures[0] ?? null,
        windowText: slice(fromToken, toToken), fromToken, toToken, tokenCount: n, from: fromToken / n, to: toToken / n });
    });
  });
  return { cards, blockers };
}

/** Director segment id of card `index` of a scene: the scene id itself when the scene has one card, `id#k` otherwise. */
export function cardSegmentId(segmentId: string, index: number, count: number): string {
  return count > 1 ? `${segmentId}#${index + 1}` : segmentId;
}
/** Inventory asset id of a card. */
export const cardAssetId = (segmentId: string, index: number, count: number) => `${cardSegmentId(segmentId, index, count)}:card`;

/**
 * The Director input with every card scene split into one segment per card (its own narration window and text) and
 * the planned stock of that scene replaced by the cards. `times`: measured window per card (seconds, by scene id)
 * once the narration exists; absent, the windows are proportional to the token span (inspection before generation).
 */
export function withDataCards(raw: DirectorInputRaw, cards: DataCardPlan[], times?: Record<string, { start: number; end: number }[]>): DirectorInputRaw {
  if (!cards.length) return raw;
  const byScene = new Map<string, DataCardPlan[]>();
  for (const c of cards) byScene.set(c.segmentId, [...(byScene.get(c.segmentId) ?? []), c].sort((a, b) => a.index - b.index));
  const segments = raw.segments.flatMap(seg => {
    const list = byScene.get(seg.id);
    if (!list || seg.locked) return [seg];
    const span = seg.end - seg.start;
    return list.map((c, k) => {
      const t = times?.[seg.id]?.[k];
      const start = t ? t.start : seg.start + c.from * span, end = t ? t.end : (k === list.length - 1 ? seg.end : seg.start + list[k + 1].from * span);
      return { ...seg, id: cardSegmentId(seg.id, c.index, c.count), start, end, text: c.windowText };
    });
  });
  const inventory = raw.inventory.flatMap(a => {
    const segId = a.content?.window?.segmentId ?? (a.tags ?? []).find(t => t.startsWith("segment:"))?.slice(8);
    const list = segId ? byScene.get(segId) : undefined;
    if (!list || a.kind === "avatar") return [a];
    // The scene's planned stock is replaced by its cards (added once, with the first planned asset of the scene).
    if (raw.inventory.find(x => (x.content?.window?.segmentId ?? (x.tags ?? []).find(t => t.startsWith("segment:"))?.slice(8)) === segId && x.kind !== "avatar") !== a) return [];
    return list.map(c => { const sid = cardSegmentId(segId!, c.index, c.count); return dataCardAsset({ id: sid, text: c.text }, cardAssetId(segId!, c.index, c.count), { windowText: c.windowText, figures: c.figures }); });
  });
  return { ...raw, segments, inventory };
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

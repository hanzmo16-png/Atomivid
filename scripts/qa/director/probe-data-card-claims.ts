/**
 * T44 probe (ROJO/VERDE, no provider, no spend): a Reel scene with TWO claims ("En 2019, el 30 % …; en 2020, el 70 % …").
 * Prints what the Director plans at the moment "70 %" is narrated: the card shown and the figures it carries.
 * ROJO (614b869): one card per scene → "30 %" stays on screen while "70 %" is said. VERDE: a card per claim.
 *   npx tsx scripts/qa/director/probe-data-card-claims.ts
 */
import type { GeneratedScript } from "@/lib/providers/types";
import { dataCardSvg, directorReelPreflight, type Figure } from "@/lib/video/director/data-card";
import { directReel, type ResolvedBeat } from "@/lib/video/director/reel-render";

const script: GeneratedScript = { title: "Dos afirmaciones en una escena", segments: [
  { text: "En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato.", visualQuery: "people remembering", visualConcepts: ["people remembering"] },
  { text: "Por eso las marcas cuentan historias en vez de listar números.", visualQuery: "shop window", visualConcepts: ["shop window"] },
] };
// Uniform synthetic word clock (like the fixture voice): 0.42 s per word.
const WORD = 0.42;
const times: { start: number; end: number }[] = []; let t = 0;
for (const s of script.segments) { const n = s.text.split(/\s+/).filter(Boolean).length; times.push({ start: t, end: t + n * WORD }); t += n * WORD; }
const pre = directorReelPreflight(script);
const cards = pre.cards.filter(c => c.sceneIndex === 0);
// Beats exactly as generate-video.ts builds them from the preflight cards.
const anyCard = cards as unknown as { fromToken?: number; toToken?: number; text: string; windowText?: string; figures?: { display: string }[]; figure: { display: string } | null }[];
const tokens0 = script.segments[0].text.split(/\s+/).filter(Boolean);
const at = (k: number) => times[0].start + Math.min(tokens0.length, Math.max(0, k)) * WORD;
const beats0: ResolvedBeat[] = anyCard.map((c, k) => ({
  url: `https://fixture.local/card-0-${k}.svg`, mediaType: "image", source: "data_card", license: "CLEARED",
  start: c.fromToken !== undefined ? at(c.fromToken) : times[0].start, end: c.toToken !== undefined ? at(c.toToken) : times[0].end,
  ...(c.windowText !== undefined ? { card: { text: c.text, windowText: c.windowText, figures: c.figures ?? [] } } : {}),
} as ResolvedBeat));
const beats1: ResolvedBeat[] = [{ url: "https://fixture.local/scene-1.svg", mediaType: "image", source: "stock", license: "CLEARED", start: times[1].start, end: times[1].end }];
const r = directReel({ script, sceneTimings: times, beatsBySegment: [beats0, beats1], audioUrl: "https://fixture.local/voice.wav", captions: [], narrationGaps: [], durationSeconds: times[1].end + 0.4 });
const t70 = at(tokens0.findIndex(w => w === "70")) + WORD / 2;
console.log(JSON.stringify({ cards: anyCard.map(c => ({ text: c.text, figures: c.figures?.map(f => f.display) ?? [c.figure?.display], window: [c.fromToken, c.toToken] })), t70: Math.round(t70 * 100) / 100 }, null, 1));
if (!r.ok) { console.log("BLOCKED", r.blockers); process.exit(2); }
const shots = r.applied.map(a => { const shot = r.plan.shots.find(s => s.id === a.shotId)!; const asset = r.input.inventory.find(x => x.id === shot.asset.assetId); return { shot: a.shotId, start: a.applied.startSeconds, end: a.applied.endSeconds, recipe: a.recipeId, intent: asset?.content?.visualIntent ?? null }; });
const active = shots.find(s => s.start <= t70 && t70 < s.end);
console.log(JSON.stringify({ shots, activeAt70: active }, null, 1));
const svg = dataCardSvg({ text: anyCard[0].text, figure: anyCard[0].figure as Figure | null, ...(anyCard[0].figures ? { figures: anyCard[0].figures as Figure[] } : {}) });
console.log("card0 hero line:", (svg.match(/font-weight="700"[^>]*>([^<]*)</) ?? [])[1] ?? "(none)", "| footer:", (svg.match(/Dato[^<]*/) ?? [])[0]);
const verdict = active && /70 %/.test(active.intent ?? "") && !/30 %/.test(active.intent ?? "") ? "VERDE" : "ROJO";
console.log("VERDICT", verdict, "— at", t70, "s the active card says:", active?.intent);
process.exit(verdict === "VERDE" ? 0 : 1);

/**
 * SHOWCASE — Directed Opening V1. ENGINEERING VISUAL BENCHMARK, FIXTURE_ONLY / TEST_ONLY.
 *
 * Cuatro recursos sintéticos, propios y locales (sin personas, marcas,
 * documentos, hechos ni geografía reales). NO son recursos documentales
 * verificados: solo los cura un curador de PRUEBA dentro de código de prueba,
 * y el cargador de producción los rechaza (fixture-only.ts). Accesible solo
 * desde pruebas y scripts de prueba.
 *
 * BEFORE y AFTER usan EXACTAMENTE estos cuatro archivos (mismos bytes).
 */
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import type { ProductionPlanBeatInput } from "./production-plan";
import type { SequenceIntent } from "./sequence-intent";
import type { CuratableAsset } from "./verified-assets";
import { DOCUMENT_REGIONS, DOCUMENT_SIZE, PORTRAIT_SIZE, SCHEMATIC_REVEAL, SCHEMATIC_SIZE, documentSvg, portraitSvg, premiumRegistry, schematicSvg } from "./premium-fixtures";
import { normalizeDeclaredVisuals } from "./visual-intents";

export const SHOWCASE_TOPIC = "Fixture district (synthetic benchmark)";
export const DISTRICT_SIZE = { width: 2400, height: 1600 };

/** CONTEXT sintético nuevo: una calle de fachadas cerradas, sin nombres, letreros ni personas. */
export function districtSvg(): string {
  const { width: W, height: H } = DISTRICT_SIZE;
  const facade = (x: number, w: number, h: number, color: string, floors: number) => {
    const top = 1180 - h;
    const windows = Array.from({ length: floors }, (_, f) =>
      Array.from({ length: Math.max(2, Math.floor(w / 140)) }, (_, c) => {
        const cols = Math.max(2, Math.floor(w / 140));
        const ww = 54;
        const gap = (w - cols * ww) / (cols + 1);
        return `<rect x="${x + gap + c * (ww + gap)}" y="${top + 70 + f * 150}" width="${ww}" height="96" fill="#2c2a28" opacity="0.88"/><rect x="${x + gap + c * (ww + gap) - 6}" y="${top + 166 + f * 150}" width="${ww + 12}" height="8" fill="#d9cdb8"/>`;
      }).join(""),
    ).join("");
    return `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${color}"/><rect x="${x}" y="${top}" width="${w}" height="18" fill="#00000022"/>${windows}`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fb2c2"/><stop offset="1" stop-color="#dfe3e1"/></linearGradient>
<linearGradient id="street" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b665f"/><stop offset="1" stop-color="#3b3834"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${facade(0, 520, 900, "#b8a58a", 5)}${facade(520, 460, 760, "#c9b79a", 4)}${facade(980, 560, 960, "#a8937a", 6)}${facade(1540, 420, 820, "#bfae94", 5)}${facade(1960, 440, 880, "#ad9a80", 5)}
<rect x="1180" y="1000" width="160" height="180" fill="#3a2f26"/><rect x="1192" y="1012" width="136" height="168" fill="#4a3c30"/>
<path d="M0 1180 L${W} 1180 L${W} ${H} L0 ${H} Z" fill="url(#street)"/>
<path d="M0 1240 L${W} 1240" stroke="#8a847a" stroke-width="6"/>
${Array.from({ length: 24 }, (_, i) => `<path d="M${i * 110 - 40} ${H} L${1200 + (i - 12) * 18} 1180" stroke="#55514b" stroke-width="3" opacity="0.6"/>`).join("")}
<text x="${W - 60}" y="${H - 50}" font-family="Arial" font-size="34" text-anchor="end" fill="#f4efe6" opacity="0.75">FIXTURE ONLY · synthetic street, not a real place</text>
</svg>`;
}

/** La región "subject" del retrato ficticio (la cara dibujada), curada como metadato del fixture. */
export const PORTRAIT_SUBJECT = { label: "subject" as const, x: 0.395, y: 0.26, w: 0.21, h: 0.38 };

export const SHOWCASE_FILES = {
  "portrait.png": { svg: portraitSvg, size: PORTRAIT_SIZE },
  "district.png": { svg: districtSvg, size: DISTRICT_SIZE },
  "document.png": { svg: documentSvg, size: DOCUMENT_SIZE },
  "schematic.svg": { svg: schematicSvg, size: SCHEMATIC_SIZE },
} as const;

const OWNED = { kind: "OWNED" as const, rightsReference: "atomivid-fixture-only-owned" };
const CREDIT = "FIXTURE ONLY · material propio de prueba";
const fixtureAsset = (id: string, base: string, file: string, mime: string, size: { width: number; height: number }, extra: Partial<CuratableAsset>): CuratableAsset => ({
  id: `fixture-only:${id}`,
  source: "owned",
  sourceUrl: `${base}/fixture-only/${file}`,
  mediaUrl: `${base}/fixture-only/${file}`,
  mediaType: "image",
  mime,
  width: size.width,
  height: size.height,
  rights: OWNED,
  creator: "Atomivid (fixture)",
  creditText: CREDIT,
  ...extra,
});

// --------------------------------------------------------------------------
// Guion + intención por secuencia (lo que propondría el planner; ver SHOWCASE-BOARD.md)
// --------------------------------------------------------------------------

const PERSON = { name: "Fixture Person", kind: "person" as const };
const V = {
  district: { description: "quiet street of closed stone facades in the old district", quote: "In the spring of 1995 the old district was quiet", subject: "street facades", era: "1990s", beatClass: "PLACE", motion: false },
  portrait: { description: "Fixture Person portrait", quote: "This is the subject of our test story", subject: "Fixture Person", era: "1995", beatClass: "IDENTITY", identity: PERSON, motion: false },
  gazette: { description: "front page of the gazette reporting the event", quote: "Weeks later the gazette printed the story on its front page", subject: "newspaper", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["fixture-src-1"] }, motion: false },
  headline: { description: "the gazette headline", quote: "Its headline put the event in plain words", subject: "newspaper", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["fixture-src-1"] }, motion: false },
  route: { description: "schematic of the route described by the report", quote: "The report traced a single route", subject: "schematic route", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["fixture-src-2"] }, motion: false },
};

export const showcaseBeats: ProductionPlanBeatInput[] = [
  {
    id: "s1",
    type: "hook",
    narration:
      "In the spring of 1995 the old district was quiet, its stone facades closed against the morning and its street still wet from the night. This is the subject of our test story, a person who lived three doors down and who would soon be at the centre of every conversation in the neighbourhood.",
    visuals: [V.district, V.portrait],
  },
  {
    id: "s2",
    type: "setup",
    narration:
      "Weeks later the gazette printed the story on its front page, between the weather and the market prices. Its headline put the event in plain words for every reader in the city, and nobody who read it that morning forgot it. The report traced a single route, from the first point across the open ground to the second, and that one line is all the record shows.",
    visuals: [V.gazette, V.headline, V.route],
  },
];

/** La intención de las DOS secuencias del board, declarada ANTES de que exista ningún recurso. */
export const showcaseSequences: SequenceIntent[] = [
  {
    id: "S1",
    purpose: "Place the story before introducing its subject.",
    viewerTakeaway: "This happened in a quiet, closed place, and this is the person it is about.",
    beatIds: ["s1"],
    slug: { year: "1995", place: "Fixture district" },
    slots: [
      { role: "CONTEXT", scale: "WIDE", scaleReason: "establish the place: a held wide frame says 'here' without inventing action", beatId: "s1", visual: V.district },
      { role: "ANCHOR", scale: "MEDIUM", scaleReason: "introduce the person: the cut from the wide place to the medium face is the move from place to person", beatId: "s1", visual: V.portrait },
    ],
  },
  {
    id: "S2",
    purpose: "Show the record, make its claim legible, then show the route it describes.",
    viewerTakeaway: "There is a written record, this is what it says, and it describes a route from A to B.",
    beatIds: ["s2"],
    slots: [
      { role: "EVIDENCE", scale: "WIDE", scaleReason: "the viewer must first see that it is a whole document", beatId: "s2", visual: V.gazette },
      { role: "DETAIL", scale: "DETAIL", scaleReason: "the narration names the headline: the curated headline region becomes the shot", beatId: "s2", visual: V.headline, detail: { of: 0, region: "headline" } },
      { role: "GEOGRAPHY", scale: "WIDE", scaleReason: "the narration names the route: draw only the line that exists in the curated schematic", beatId: "s2", visual: V.route },
    ],
  },
];

const visual = (v: Record<string, unknown>) => normalizeDeclaredVisuals([v], { identity: true })[0];

/** Assets SHOWCASE (mismos archivos para BEFORE y AFTER) y su registro de PRUEBA (curador de prueba, solo en pruebas). */
export function showcaseAssets(base: string) {
  return {
    portrait: fixtureAsset("portrait", base, "portrait.png", "image/png", PORTRAIT_SIZE, { description: "Fixture portrait (fictional person)", regions: [PORTRAIT_SUBJECT] }),
    gazette: fixtureAsset("gazette", base, "document.png", "image/png", DOCUMENT_SIZE, { description: "Fixture gazette front page", regions: DOCUMENT_REGIONS }),
    schematic: fixtureAsset("schematic", base, "schematic.svg", "image/svg+xml", SCHEMATIC_SIZE, { description: "Fixture schematic", svgReveal: SCHEMATIC_REVEAL }),
  };
}

export function showcaseRegistry(base: string) {
  const a = showcaseAssets(base);
  return premiumRegistry([
    { asset: a.portrait, visual: visual(V.portrait) },
    { asset: a.gazette, visual: visual(V.gazette) },
    { asset: a.schematic, visual: visual(V.route) },
  ]);
}

/** CONTEXT legal de contexto: el ÚNICO candidato de stock del benchmark (lo valida el selector como cualquier otro). */
export function showcaseFootageProvider(base: string, download: (url: string) => Promise<Buffer>): FootageProvider {
  const district: FootageCandidate = {
    url: `${base}/fixture-only/district.png`,
    sourceId: "fixture-only:district",
    description: "quiet street of closed stone facades in an old district (synthetic fixture)",
    mediaType: "image",
    mimeType: "image/png",
    extension: "png",
    width: DISTRICT_SIZE.width,
    height: DISTRICT_SIZE.height,
    pageUrl: `${base}/fixture-only/district.png`,
    photographer: "Atomivid (fixture)",
  };
  return {
    name: "fixture-only-showcase",
    async fetchFootage() {
      throw new Error("SHOWCASE: solo búsqueda de candidatos");
    },
    async searchImageCandidates(query) {
      return /street|facade|district/i.test(query) ? [{ ...district }] : [];
    },
    async searchVideoCandidates() {
      return [];
    },
    downloadFootage: download,
  };
}

/**
 * Soporte de PRUEBAS y de la prueba visual local (scripts/premium-composition-proof.ts).
 * Todo el material es PROPIO y está marcado "FIXTURE": no representa a ninguna
 * persona real, ningún periódico real ni ninguna geografía real. Pasa por la
 * MISMA curaduría y rehidratación que producción.
 */
import { normalizeDeclaredVisuals, type BeatVisual } from "./visual-intents";
import { contractForVisual, contractKey, VerifiedAssetRegistry, type CuratableAsset } from "./verified-assets";
import { decideLink, emptyCurationFile, proposeAsset, requestedContracts } from "./asset-curation";
import { assetFingerprint } from "./verified-assets";

export const PREMIUM_REQUEST_ID = "req-premium-composition";
export const PREMIUM_CURATOR = "curator@atomivid.test";

const visual = (v: Record<string, unknown>) => normalizeDeclaredVisuals([{ motion: false, ...v } as never], { identity: true })[0];

export const FIXTURE_PERSON_VISUAL: BeatVisual = visual({ description: "Fixture Person portrait", subject: "Fixture Person", era: "1995", beatClass: "IDENTITY", identity: { name: "Fixture Person", kind: "person" } });
export const FIXTURE_DOCUMENT_VISUAL: BeatVisual = visual({ description: "front page reporting the fixture event", quote: "The fixture gazette reported the event on its front page", subject: "newspaper", era: "1995", beatClass: "EVIDENCE", evidence: { sourceIds: ["fixture-src-1"] } });
export const FIXTURE_SCHEMATIC_VISUAL: BeatVisual = visual({ description: "schematic of the route described by the source", quote: "The route ran from point A to point B", subject: "schematic route", era: "480 BC", beatClass: "EVIDENCE", evidence: { sourceIds: ["fixture-src-2"] } });

const OWNED = { kind: "OWNED" as const, rightsReference: "atomivid-fixture-owned-2026-10" };
const CREDIT = "Fixture · material propio de prueba (Atomivid)";

/** Página de periódico FICTICIA (1800×2400). Las regiones curadas coinciden con los bloques dibujados. */
export const DOCUMENT_SIZE = { width: 1800, height: 2400 };
export const DOCUMENT_REGIONS = [
  { label: "headline" as const, x: 0.06, y: 0.15, w: 0.88, h: 0.14 },
  { label: "date" as const, x: 0.12, y: 0.105, w: 0.76, h: 0.035 },
  { label: "detail" as const, x: 0.06, y: 0.62, w: 0.42, h: 0.2 },
];

export function documentSvg(): string {
  const { width: W, height: H } = DOCUMENT_SIZE;
  const px = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H });
  const [headline, date, detail] = DOCUMENT_REGIONS.map(px);
  const lines = (x: number, y: number, w: number, n: number, gap = 34) =>
    Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * gap}" width="${w * (i % 5 === 4 ? 0.6 : 1)}" height="14" rx="3" fill="#8d8473"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#efe7d6"/>
<rect x="60" y="60" width="${W - 120}" height="${H - 120}" fill="none" stroke="#2b261d" stroke-width="4"/>
<text x="${W / 2}" y="200" font-family="Georgia, serif" font-size="120" font-weight="700" text-anchor="middle" fill="#1d1a14">THE FIXTURE GAZETTE</text>
<line x1="100" y1="240" x2="${W - 100}" y2="240" stroke="#2b261d" stroke-width="3"/>
<text x="${date.x + date.w / 2}" y="${date.y + date.h * 0.72}" font-family="Georgia, serif" font-size="46" text-anchor="middle" fill="#2b261d">TUESDAY · 28 MARCH 1995 · FIXTURE EDITION</text>
<line x1="100" y1="${date.y + date.h + 14}" x2="${W - 100}" y2="${date.y + date.h + 14}" stroke="#2b261d" stroke-width="2"/>
<text x="${headline.x + headline.w / 2}" y="${headline.y + headline.h * 0.42}" font-family="Georgia, serif" font-size="110" font-weight="700" text-anchor="middle" fill="#14110c">FIXTURE HEADLINE:</text>
<text x="${headline.x + headline.w / 2}" y="${headline.y + headline.h * 0.86}" font-family="Georgia, serif" font-size="74" font-weight="700" text-anchor="middle" fill="#14110c">TEST PAGE FOR REGION MOTION</text>
<rect x="${headline.x}" y="${headline.y + headline.h + 40}" width="${W * 0.5}" height="${H * 0.2}" fill="#b9b09c"/>
<text x="${headline.x + W * 0.25}" y="${headline.y + headline.h + 40 + H * 0.1}" font-family="Arial" font-size="40" text-anchor="middle" fill="#5d5546">[ photo area · fixture ]</text>
${lines(headline.x + W * 0.53, headline.y + headline.h + 50, W * 0.35, 14)}
${lines(headline.x, headline.y + headline.h + 80 + H * 0.2, W * 0.88, 5)}
<rect x="${detail.x}" y="${detail.y}" width="${detail.w}" height="${detail.h}" fill="none" stroke="#2b261d" stroke-width="3"/>
<text x="${detail.x + 30}" y="${detail.y + 70}" font-family="Georgia, serif" font-size="50" font-weight="700" fill="#1d1a14">Detail block (fixture)</text>
${lines(detail.x + 30, detail.y + 110, detail.w - 60, 9, 36)}
${lines(detail.x + detail.w + 50, detail.y, W * 0.4, 14)}
<text x="${W / 2}" y="${H - 90}" font-family="Arial" font-size="34" text-anchor="middle" fill="#6b6253">FIXTURE — synthetic test document, not a real newspaper</text>
</svg>`;
}

/** Retrato FICTICIO a color (2400×1600): silueta con luz de estudio. Representa a "Fixture Person", nadie real. */
export const PORTRAIT_SIZE = { width: 2400, height: 1600 };
export function portraitSvg(): string {
  const { width: W, height: H } = PORTRAIT_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="bg" cx="0.42" cy="0.38" r="0.9"><stop offset="0" stop-color="#d9a35c"/><stop offset="0.45" stop-color="#8a4f2b"/><stop offset="1" stop-color="#1f2a3d"/></radialGradient>
<linearGradient id="coat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f4f7a"/><stop offset="1" stop-color="#16243a"/></linearGradient>
<radialGradient id="skin" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="#f0c9a0"/><stop offset="1" stop-color="#a86e4a"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="1500" y="180" width="620" height="900" fill="#c2463a" opacity="0.55"/>
<rect x="1560" y="240" width="500" height="780" fill="#e7d38a" opacity="0.35"/>
<path d="M760 1600 C 780 1180, 980 1060, 1200 1050 C 1420 1060, 1620 1180, 1640 1600 Z" fill="url(#coat)"/>
<path d="M1110 1060 L1200 1260 L1290 1060 Z" fill="#e9e4da"/>
<path d="M1185 1110 L1200 1330 L1215 1110 Z" fill="#8c1f2a"/>
<rect x="1135" y="900" width="130" height="180" rx="40" fill="url(#skin)"/>
<ellipse cx="1200" cy="720" rx="230" ry="285" fill="url(#skin)"/>
<path d="M975 690 C 980 450, 1420 430, 1430 690 C 1400 560, 1010 560, 975 690 Z" fill="#2a1d14"/>
<text x="${W - 60}" y="${H - 50}" font-family="Arial" font-size="34" text-anchor="end" fill="#f4efe6" opacity="0.8">FIXTURE PORTRAIT · fictional "Fixture Person"</text>
</svg>`;
}

/** Esquema CURADO (1920×1080): zonas abstractas, UN trazo id="route" y UNA etiqueta id="route-label". No es geografía real. */
export const SCHEMATIC_SIZE = { width: 1920, height: 1080 };
export const SCHEMATIC_REVEAL = { pathId: "route", labelId: "route-label" };
export function schematicSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="1920" height="1080" fill="#14202c"/>
<g stroke="#22364a" stroke-width="2">${Array.from({ length: 13 }, (_, i) => `<line x1="${i * 160}" y1="0" x2="${i * 160}" y2="1080"/>`).join("")}${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="${i * 160}" x2="1920" y2="${i * 160}"/>`).join("")}</g>
<rect x="180" y="520" width="520" height="360" rx="24" fill="#1f7a72" opacity="0.85"/>
<rect x="1220" y="200" width="520" height="360" rx="24" fill="#c98a2b" opacity="0.85"/>
<circle cx="440" cy="700" r="22" fill="#f2efe8"/>
<circle cx="1480" cy="380" r="22" fill="#f2efe8"/>
<text x="440" y="790" font-family="Arial" font-size="44" font-weight="700" text-anchor="middle" fill="#f2efe8">A</text>
<text x="1480" y="300" font-family="Arial" font-size="44" font-weight="700" text-anchor="middle" fill="#f2efe8">B</text>
<path id="route" d="M440 700 C 760 660, 860 420, 1100 430 S 1380 400, 1480 380" fill="none" stroke="#e5484d" stroke-width="10"/>
<text id="route-label" x="900" y="380" font-size="48" fill="#ffffff">Route (fixture)</text>
<text x="1840" y="1000" font-family="Arial" font-size="40" font-weight="700" text-anchor="end" fill="#f2efe8">SCHEMATIC — FIXTURE</text>
<text x="80" y="1000" font-family="Arial" font-size="30" fill="#9fb3c4">Abstract test schematic: not real geography, no troop positions</text>
</svg>`;
}

const asset = (id: string, baseUrl: string, file: string, mime: string, size: { width: number; height: number }, extra: Partial<CuratableAsset> = {}): CuratableAsset => ({
  id,
  source: "owned",
  sourceUrl: `${baseUrl}/${file}`,
  mediaUrl: `${baseUrl}/${file}`,
  mediaType: "image",
  mime,
  width: size.width,
  height: size.height,
  rights: OWNED,
  creator: "Atomivid (fixture)",
  creditText: CREDIT,
  ...extra,
});

export function premiumAssets(baseUrl: string) {
  return {
    portrait: asset("fixture-portrait", baseUrl, "portrait.png", "image/png", PORTRAIT_SIZE, { description: "Fixture portrait (fictional person)" }),
    document: asset("fixture-document", baseUrl, "document.png", "image/png", DOCUMENT_SIZE, { description: "Fixture gazette front page", regions: DOCUMENT_REGIONS }),
    documentNoRegions: asset("fixture-document-plain", baseUrl, "document.png", "image/png", DOCUMENT_SIZE, { description: "Fixture gazette front page (no curated regions)" }),
    schematic: asset("fixture-schematic", baseUrl, "schematic.svg", "image/svg+xml", SCHEMATIC_SIZE, { description: "Fixture schematic", svgReveal: SCHEMATIC_REVEAL }),
  };
}

/** Un curador aprueba cada par EXACTO, uno a uno; se persiste como JSON y el servidor lo rehidrata. */
export function premiumRegistry(pairs: { asset: CuratableAsset; visual: BeatVisual }[]): VerifiedAssetRegistry {
  const requested = requestedContracts(pairs.map((p, i) => ({ id: `v${i}`, startSec: 0, endSec: 5, type: "ken_burns_image", anchoredVisual: p.visual })));
  let file = emptyCurationFile(PREMIUM_REQUEST_ID);
  for (const { asset: a, visual: v } of pairs) {
    const key = contractKey(contractForVisual(v)!);
    const proposed = proposeAsset(file, { asset: a, contractKey: key, origin: "manual", now: "2026-10-07T00:00:00Z" }, requested);
    if ("error" in proposed) throw new Error(`${a.id}: ${proposed.error}`);
    file = proposed.file;
    const proposal = file.proposals.find((p) => p.assetId === a.id && contractKey(p.contract) === key)!;
    const decided = decideLink(file, { proposalId: proposal.id, verdict: "APPROVED", curator: PREMIUM_CURATOR, now: "2026-10-07T00:00:00Z", expectedFingerprint: assetFingerprint(file.assets.find((x) => x.id === a.id)!) }, requested);
    if ("error" in decided) throw new Error(`${a.id}: ${decided.error}`);
    file = decided.file;
  }
  return VerifiedAssetRegistry.rehydrate(JSON.parse(JSON.stringify(file)), { requestId: PREMIUM_REQUEST_ID, isAuthorizedCurator: (e) => e === PREMIUM_CURATOR });
}

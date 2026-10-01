/** Video #004 internal graphics (free): 16 SVG cards rendered to 2304x1296 PNG (20% headroom for the
 * push-in). Regional maps use Natural Earth 50 m coastlines fetched once per run (public domain); the
 * pass itself is a schematic (the 480 BC shoreline is not in any modern coastline file). If the fetch
 * fails the map is drawn without coastlines and the omission is reported in the QA notes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {GraphicKind} from './plan';
import {TITLE, CHANNEL, CREDITS} from './plan';

const W = 2304, H = 1296;
const BG = '#121212', INK = '#e6ddd0', DIM = '#9a9185', ACCENT = '#d9a441', WATER = '#2f5b73', LAND = '#2a2621', RED = '#b5452f', BRONZE = '#b98b45', PERSIAN = '#8c4a8a';
const FONT = 'DejaVu Sans';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x: number, y: number, s: string, size = 40, fill = INK, anchor: 'start' | 'middle' | 'end' = 'start', weight = 'normal') => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;
const frame = (inner: string, caption?: string) => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${BG}"/>${inner}${caption ? text(W / 2, H - 70, caption, 34, DIM, 'middle') : ''}</svg>`;

type LonLat = [number, number];
type Geo = {countries: {name: string; rings: LonLat[][]}[]} | null;
let geoCache: Geo | undefined;
export const graphicsNotes: string[] = [];

async function geo(cacheDir: string): Promise<Geo> {
  if (geoCache !== undefined) return geoCache;
  const get = async (name: string) => {
    const f = path.join(cacheDir, name); try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { /* fetch */ }
    const r = await fetch(`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${name}`, {signal: AbortSignal.timeout(60000)});
    if (!r.ok) throw Error(`Natural Earth ${name} HTTP ${r.status}`);
    const j = await r.json(); await fs.mkdir(cacheDir, {recursive: true}); await fs.writeFile(f, JSON.stringify(j)); return j;
  };
  try {
    const rings = (g: {type: string; coordinates: unknown}): LonLat[][] => g.type === 'Polygon' ? (g.coordinates as LonLat[][]).map((r) => r) : g.type === 'MultiPolygon' ? (g.coordinates as LonLat[][][]).map((p) => p[0]) : [];
    const c = await get('ne_50m_admin_0_countries.geojson');
    geoCache = {countries: c.features.map((f: {properties: Record<string, string>; geometry: {type: string; coordinates: unknown}}) => ({name: f.properties.NAME || f.properties.ADMIN || '', rings: rings(f.geometry)}))};
  } catch (e) { graphicsNotes.push('Natural Earth coastlines unavailable: ' + (e instanceof Error ? e.message : String(e))); geoCache = null; }
  return geoCache;
}

type Label = {at: LonLat; s: string; size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'};
function mapSvg(g: Geo, bbox: [number, number, number, number], inner: (proj: (p: number[]) => [number, number]) => string, caption: string, labels: Label[] = []) {
  const [w, s, e, n] = bbox; const pad = 110; const cy0 = (s + n) / 2; const kx = Math.cos((cy0 * Math.PI) / 180);
  const sx = (W - 2 * pad) / ((e - w) * kx), sy = (H - 2 * pad) / (n - s); const k = Math.min(sx, sy);
  const cx = (w + e) / 2;
  const proj = (p: number[]): [number, number] => [W / 2 + (p[0] - cx) * kx * k, H / 2 - (p[1] - cy0) * k];
  const poly = (rings: LonLat[][], fill: string, stroke: string) => rings.map((r) => `<path d="${r.map((p, i) => (i ? 'L' : 'M') + proj(p).map((v) => v.toFixed(1)).join(' ')).join(' ')} Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>`).join('');
  const inView = (rings: LonLat[][]) => rings.some((r) => r.some((p) => p[0] > w - 5 && p[0] < e + 5 && p[1] > s - 5 && p[1] < n + 5));
  let body = `<rect width="100%" height="100%" fill="${WATER}" opacity="0.35"/>`;
  if (g) for (const c of g.countries) if (inView(c.rings)) body += poly(c.rings, LAND, '#7a7064');
  body += inner(proj);
  for (const l of labels) { const [x, y] = proj(l.at); body += text(x, y, l.s, l.size ?? 36, l.fill ?? INK, l.anchor ?? 'start'); }
  return frame(body, caption);
}
const marker = (p: [number, number], r = 14, fill = ACCENT) => `<circle cx="${p[0]}" cy="${p[1]}" r="${r + 10}" fill="${fill}" opacity="0.25"/><circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="${fill}" stroke="#000" stroke-width="2"/>`;
const curve = (pts: [number, number][], stroke = ACCENT, width = 8, dash?: string) => `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p.map((v) => v.toFixed(1)).join(' ')).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const arrowHead = (from: [number, number], to: [number, number], fill = ACCENT, size = 26) => { const a = Math.atan2(to[1] - from[1], to[0] - from[0]); const p = (d: number, s: number) => [to[0] - size * Math.cos(a - d) * s, to[1] - size * Math.sin(a - d) * s]; return `<path d="M ${to.join(' ')} L ${p(0.5, 1).join(' ')} L ${p(-0.5, 1).join(' ')} Z" fill="${fill}"/>`; };

// Places (lon, lat).
const HELLESPONT: LonLat = [26.4, 40.2], ATHOS: LonLat = [23.95, 40.37], DORISCUS: LonLat = [26.1, 40.85], THERMA: LonLat = [22.95, 40.63], THERMOPYLAE: LonLat = [22.54, 38.80], ARTEMISIUM: LonLat = [23.2, 39.05];
const ATHENS: LonLat = [23.73, 37.98], SALAMIS: LonLat = [23.5, 37.95], PLATAEA: LonLat = [23.27, 38.22], CORINTH: LonLat = [22.93, 37.94], SPARTA: LonLat = [22.43, 37.07], SARDIS: LonLat = [28.0, 38.49];
const TEGEA: LonLat = [22.42, 37.45], MANTINEA: LonLat = [22.39, 37.6], PHLIUS: LonLat = [22.65, 37.85], MYCENAE: LonLat = [22.76, 37.73], THESPIAE: LonLat = [23.15, 38.3], THEBES: LonLat = [23.32, 38.32], DELPHI: LonLat = [22.5, 38.48], OPUS: LonLat = [23.0, 38.63], MARATHON: LonLat = [23.96, 38.15];
const ROUTE: LonLat[] = [SARDIS, [27.0, 39.6], HELLESPONT, DORISCUS, [25.0, 40.9], [24.3, 40.75], ATHOS, THERMA, [22.4, 39.9], [22.5, 39.3], THERMOPYLAE];

// ---- schematic pass (not geographic): x = west→east along the shore, y = sea (top) → mountain (bottom)
function passSchematic(opts: {anopaea?: boolean; modern?: boolean; dayThree?: boolean; phocians?: boolean}) {
  const seaY = 420, cliffY = 760;
  let b = `<rect x="0" y="0" width="${W}" height="${seaY}" fill="${WATER}" opacity="0.8"/>`;
  b += `<path d="M 0 ${seaY} C 400 ${seaY - 20}, 700 ${seaY + 60}, 1000 ${seaY + 90} C 1250 ${seaY + 110}, 1500 ${seaY + 20}, 1800 ${seaY + 70} C 2000 ${seaY + 100}, 2200 ${seaY + 40}, ${W} ${seaY}" fill="${LAND}"/>`; // shore
  b += `<rect x="0" y="${seaY}" width="${W}" height="${H - seaY}" fill="${LAND}" opacity="0"/>`;
  b += `<path d="M 0 ${cliffY - 60} C 300 ${cliffY - 80}, 600 ${cliffY - 120}, 950 ${cliffY - 190} C 1200 ${cliffY - 230}, 1450 ${cliffY - 150}, 1750 ${cliffY - 140} C 2000 ${cliffY - 130}, 2200 ${cliffY - 60}, ${W} ${cliffY - 40} L ${W} ${H} L 0 ${H} Z" fill="#3a332c"/>`; // mountain
  b += text(1150, 300, 'Malian Gulf (480 BC shoreline)', 40, '#bfe0ee', 'middle') + text(1150, 1180, 'Mount Kallidromo', 44, '#cdb89c', 'middle');
  b += text(300, 600, 'west gate', 34, DIM, 'middle') + text(1180, 540, 'middle gate', 34, DIM, 'middle') + text(1980, 580, 'east gate', 34, DIM, 'middle');
  b += `<line x1="1150" y1="520" x2="1150" y2="${cliffY - 215}" stroke="${BRONZE}" stroke-width="16"/>` + text(1050, 500, 'Phocian wall', 36, BRONZE, 'end');
  b += `<rect x="1230" y="470" width="40" height="40" rx="8" fill="${BRONZE}"/>` + text(1290, 500, 'the hill', 32, INK);
  b += marker([200, 520], 10, RED) + text(230, 530, 'hot springs', 32, RED);
  b += text(60, 470, '← Persian camp (Trachis plain)', 34, PERSIAN) + text(W - 60, 470, 'Greece →', 34, INK, 'end');
  if (opts.anopaea || opts.dayThree) {
    b += curve([[150, 900], [450, 1050], [800, 1130], [1200, 1120], [1600, 1040], [1950, 860], [2050, 640]], opts.dayThree ? RED : ACCENT, 9, '28 18');
    b += text(1150, 1080, 'Anopaea path (night march over the ridge)', 36, opts.dayThree ? RED : ACCENT, 'middle');
    if (opts.phocians) b += marker([1380, 1105], 12, INK) + text(1420, 1095, '1,000 Phocians', 32, INK);
    if (opts.dayThree) { b += arrowHead([1950, 860], [2050, 640], RED, 34); b += curve([[300, 560], [1080, 560]], RED, 10); b += arrowHead([300, 560], [1080, 560], RED, 34); b += text(600, 530, 'frontal assault', 34, RED, 'middle'); b += `<rect x="1120" y="440" width="140" height="90" fill="none" stroke="${INK}" stroke-width="4" stroke-dasharray="10 8"/>` + text(1190, 420, 'Greeks', 32, INK, 'middle'); }
  }
  if (opts.modern) {
    b += `<path d="M 0 150 C 600 120, 1500 110, ${W} 140" fill="none" stroke="#bfe0ee" stroke-width="5" stroke-dasharray="18 14"/>` + text(1150, 120, 'today’s shoreline, several km north', 34, '#bfe0ee', 'middle');
    b += `<path d="M 0 ${seaY + 20} C 600 ${seaY + 30}, 1500 ${seaY + 60}, ${W} ${seaY + 30}" fill="none" stroke="${INK}" stroke-width="6"/>` + text(W - 60, seaY + 10, 'modern highway on the old shore', 32, INK, 'end');
  }
  return b;
}

const shield = (x: number, y: number, r: number, fill = BRONZE) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="#2a1e10" stroke-width="3"/>`;
const spear = (x: number, y: number, len: number, up = true) => `<line x1="${x}" y1="${y}" x2="${x}" y2="${up ? y - len : y + len}" stroke="#d8c9a5" stroke-width="4"/><path d="M ${x - 7} ${up ? y - len + 22 : y + len - 22} L ${x} ${up ? y - len : y + len} L ${x + 7} ${up ? y - len + 22 : y + len - 22} Z" fill="#cfd4d8"/>`;

export async function graphicSvg(kind: GraphicKind, cacheDir: string): Promise<string> {
  switch (kind) {
    case 'map-route': return mapSvg(await geo(cacheDir), [20.5, 36.3, 29.5, 41.8], (proj) => curve(ROUTE.map(proj), PERSIAN, 9) + arrowHead(proj([22.5, 39.3]), proj(THERMOPYLAE), PERSIAN, 32) + [DORISCUS, THERMA].map((p) => marker(proj(p), 10, ACCENT)).join('') + `<line x1="${proj([23.8, 40.3])[0]}" y1="${proj([23.8, 40.3])[1]}" x2="${proj([24.0, 40.45])[0]}" y2="${proj([24.0, 40.45])[1]}" stroke="${ACCENT}" stroke-width="10"/>` + marker(proj(HELLESPONT), 12, ACCENT) + marker(proj(THERMOPYLAE), 14, RED), 'The Persian route, spring–summer 480 BC (schematic)', [{at: [26.55, 40.05], s: 'Hellespont bridges', fill: ACCENT}, {at: [24.1, 40.55], s: 'Athos canal', fill: ACCENT}, {at: [26.25, 41.0], s: 'Doriscus · supply depot', fill: ACCENT, size: 32}, {at: [22.3, 40.75], s: 'Therma', fill: ACCENT, size: 32, anchor: 'end'}, {at: [22.4, 38.62], s: 'Thermopylae', fill: RED, size: 42, anchor: 'end'}, {at: [27.6, 38.3], s: 'Sardis', fill: DIM, size: 32}, {at: [24.3, 37.2], s: 'AEGEAN SEA', fill: '#9fc3d3', size: 40}]);
    case 'numbers': { const bar = (x: number, y: number, w: number, label: string, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="90" rx="12" fill="${fill}"/>${text(x + w + 24, y + 60, label, 38, INK)}`; return frame(`${text(200, 220, 'Fighting men', 44, DIM)}${bar(200, 260, 1500, 'Herodotus: 2,641,610', PERSIAN)}${bar(200, 380, 170, 'modern estimates: 100,000 – 300,000', ACCENT)}${text(200, 640, 'Warships', 44, DIM)}${bar(200, 680, 1207, 'Herodotus: 1,207', PERSIAN)}${bar(200, 800, 600, 'modern estimates: several hundred', ACCENT)}`, 'Herodotus 7.89, 7.185 against modern estimates (bars to scale within each pair)'); }
    case 'map-league': return mapSvg(await geo(cacheDir), [20.6, 36.4, 25.2, 40.0], (proj) => [ATHENS, SPARTA, TEGEA, MANTINEA, PHLIUS, MYCENAE, THESPIAE, PLATAEA, DELPHI, OPUS].map((p) => marker(proj(p), 9, ACCENT)).join('') + marker(proj(CORINTH), 15, RED) + [THEBES, [22.4, 39.6] as LonLat, [21.7, 39.7] as LonLat, [22.8, 39.3] as LonLat].map((p) => marker(proj(p), 9, PERSIAN)).join(''), 'The cities that met at Corinth (481 BC) · submitted or neutral in purple', [{at: [22.98, 37.85], s: 'Corinth', fill: RED, size: 42}, {at: [23.8, 38.0], s: 'Athens', fill: ACCENT}, {at: [22.5, 36.95], s: 'Sparta', fill: ACCENT}, {at: [22.3, 39.75], s: 'Thessaly (submitted)', fill: PERSIAN, size: 32}, {at: [23.4, 38.4], s: 'Thebes', fill: PERSIAN, size: 32}]);
    case 'map-plan': return mapSvg(await geo(cacheDir), [21.6, 37.9, 24.4, 39.6], (proj) => curve([[22.4, 39.4], [22.5, 39.15], THERMOPYLAE].map(proj), PERSIAN, 9) + arrowHead(proj([22.5, 39.15]), proj(THERMOPYLAE), PERSIAN, 32) + curve([[23.6, 39.5], [23.4, 39.25], ARTEMISIUM].map(proj), PERSIAN, 9, '24 16') + arrowHead(proj([23.4, 39.25]), proj(ARTEMISIUM), PERSIAN, 32) + `<line x1="${proj([22.45, 38.78])[0]}" y1="${proj([22.45, 38.78])[1]}" x2="${proj([22.62, 38.82])[0]}" y2="${proj([22.62, 38.82])[1]}" stroke="${BRONZE}" stroke-width="18"/>` + `<line x1="${proj([23.05, 39.0])[0]}" y1="${proj([23.05, 39.0])[1]}" x2="${proj([23.35, 39.1])[0]}" y2="${proj([23.35, 39.1])[1]}" stroke="${BRONZE}" stroke-width="18"/>`, 'The plan: hold the land road and the sea channel, about 60 km apart', [{at: [22.2, 38.65], s: 'Thermopylae · the army', fill: BRONZE, size: 38}, {at: [23.2, 39.2], s: 'Artemisium · the fleet', fill: BRONZE, size: 38}, {at: [22.6, 39.45], s: 'Persian army', fill: PERSIAN, size: 32}, {at: [23.7, 39.5], s: 'Persian fleet', fill: PERSIAN, size: 32}, {at: [23.9, 38.05], s: 'Athens', fill: DIM, size: 32}]);
    case 'map-allies': return mapSvg(await geo(cacheDir), [21.3, 36.6, 24.4, 39.1], (proj) => ([[SPARTA, 300], [TEGEA, 500], [MANTINEA, 500], [CORINTH, 400], [PHLIUS, 200], [MYCENAE, 80], [THESPIAE, 700], [THEBES, 400], [DELPHI, 1000], [OPUS, 0]] as [LonLat, number][]).map(([p, n]) => marker(proj(p), 8 + Math.sqrt(n) / 2, ACCENT)).join('') + marker(proj(THERMOPYLAE), 14, RED) + curve([SPARTA, TEGEA, MANTINEA, CORINTH, THEBES, THERMOPYLAE].map(proj), ACCENT, 5, '18 14'), 'Contingents named by Herodotus 7.202–203 (marker size ≈ men)', [{at: [22.5, 36.95], s: 'Sparta 300', size: 32}, {at: [22.5, 37.4], s: 'Tegea 500', size: 30}, {at: [22.45, 37.68], s: 'Mantinea 500', size: 30}, {at: [23.0, 37.85], s: 'Corinth 400', size: 30}, {at: [22.6, 37.95], s: 'Phlius 200', size: 28, anchor: 'end'}, {at: [22.85, 37.65], s: 'Mycenae 80', size: 28}, {at: [23.0, 38.22], s: 'Thespiae 700', size: 30, anchor: 'end'}, {at: [23.4, 38.3], s: 'Thebes 400', size: 30}, {at: [22.2, 38.5], s: 'Phocis 1,000', size: 30, anchor: 'end'}, {at: [23.08, 38.6], s: 'Opuntian Locrians', size: 28}, {at: [22.65, 38.9], s: 'Thermopylae', fill: RED, size: 36}]);
    case 'map-pass': return frame(passSchematic({anopaea: true, modern: true}), 'The pass in 480 BC: sea against the mountain, three narrows, the Phocian wall · schematic, not to scale');
    case 'hoplite-kit': { const cx = 700, cy = 650; return frame(`${shield(cx, cy, 240)}<circle cx="${cx}" cy="${cy}" r="200" fill="none" stroke="#8a6a35" stroke-width="3"/>${text(cx, 960, 'aspis · about 90 cm, wood faced with bronze', 34, INK, 'middle')}${spear(1250, 1050, 820)}${text(1300, 420, 'dory · 2–2.5 m', 34, INK)}${text(1300, 470, 'iron head, bronze butt-spike', 30, DIM)}<rect x="1480" y="560" width="26" height="300" rx="6" fill="#cfd4d8"/><rect x="1440" y="560" width="106" height="26" rx="6" fill="#8a6a35"/>${text(1560, 720, 'xiphos · short sword', 34, INK)}<path d="M 1850 420 C 1850 300, 2110 300, 2110 420 L 2110 560 L 2070 560 L 2070 480 L 2020 540 L 1940 540 L 1890 480 L 1890 560 L 1850 560 Z" fill="${BRONZE}" stroke="#2a1e10" stroke-width="3"/>${text(1980, 620, 'bronze helmet', 34, INK, 'middle')}<path d="M 1900 720 C 1860 800, 1860 920, 1900 1000 L 2060 1000 C 2100 920, 2100 800, 2060 720 Z" fill="${BRONZE}" opacity="0.85"/>${text(1980, 1060, 'cuirass · bronze or layered linen', 32, INK, 'middle')}<path d="M 1300 820 C 1280 900, 1280 1000, 1300 1060 L 1380 1060 C 1400 1000, 1400 900, 1380 820 Z" fill="${BRONZE}" opacity="0.85"/>${text(1340, 1110, 'greaves', 32, INK, 'middle')}`, 'Hoplite equipment, early 5th century BC (Snodgrass; Sekunda)'); }
    case 'phalanx': { let b = ''; for (let r = 0; r < 8; r++) for (let c = 0; c < 12; c++) { const x = 420 + c * 125, y = 320 + r * 92; b += shield(x, y, 42, r ? '#7d6236' : BRONZE); if (r < 2) b += spear(x + 28, y - 30, 120 - r * 30); } b += `<path d="M 300 240 L 1900 240" stroke="${PERSIAN}" stroke-width="10"/>` + text(1100, 210, 'enemy', 36, PERSIAN, 'middle') + text(2000, 360, 'front rank', 32, INK) + text(2000, 1010, 'eighth rank', 32, INK) + `<path d="M 230 320 L 230 970" stroke="${DIM}" stroke-width="4"/>` + text(200, 660, 'depth', 32, DIM, 'end') + text(1100, 1140, 'each shield covers its bearer’s left and his neighbour’s right · spears levelled over the rims', 34, DIM, 'middle'); return frame(b, 'The phalanx seen from above (Thucydides 5.71) · schematic'); }
    case 'no-flank': { const block = (x0: number, y0: number) => { let b = ''; for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) b += shield(x0 + c * 70, y0 + r * 60, 24, r ? '#7d6236' : BRONZE); return b; }; const foes = (x0: number, y0: number, cols: number, rows: number) => { let b = ''; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) b += `<circle cx="${x0 + c * 55}" cy="${y0 + r * 50}" r="16" fill="${PERSIAN}"/>`; return b; }; return frame(`${text(560, 220, 'open ground', 40, INK, 'middle')}${foes(130, 300, 16, 4)}${block(410, 640)}${curve([[200, 520], [120, 700], [300, 820]], RED, 7, '16 12')}${arrowHead([120, 700], [300, 820], RED, 28)}${curve([[930, 520], [1010, 700], [830, 820]], RED, 7, '16 12')}${arrowHead([1010, 700], [830, 820], RED, 28)}${text(560, 960, 'numbers wrap around the flanks', 34, RED, 'middle')}${text(1740, 220, 'the pass', 40, INK, 'middle')}<rect x="1300" y="260" width="140" height="800" fill="${WATER}" opacity="0.7"/><rect x="2040" y="260" width="140" height="800" fill="#3a332c"/>${text(1370, 1100, 'sea', 30, '#bfe0ee', 'middle')}${text(2110, 1100, 'cliff', 30, '#cdb89c', 'middle')}${foes(1480, 300, 10, 5)}${block(1580, 640)}${text(1740, 960, 'no flank to turn', 34, ACCENT, 'middle')}`, 'Why the narrows mattered'); }
    case 'map-anopaea': return frame(passSchematic({anopaea: true, phocians: true}), 'The Anopaea path: from the Asopus gorge over the ridge to the east gate · schematic');
    case 'map-road-south': return mapSvg(await geo(cacheDir), [21.6, 37.6, 24.4, 39.5], (proj) => curve([THERMOPYLAE, [22.75, 38.6], [23.0, 38.45], THEBES, [23.5, 38.2], ATHENS].map(proj), ACCENT, 9, '24 16') + arrowHead(proj([23.5, 38.2]), proj(ATHENS), ACCENT, 32) + curve([ARTEMISIUM, [23.6, 38.7], [24.0, 38.3], SALAMIS].map(proj), '#9fc3d3', 9, '24 16') + arrowHead(proj([24.0, 38.3]), proj(SALAMIS), '#9fc3d3', 32) + marker(proj(THERMOPYLAE), 14, RED) + marker(proj(ARTEMISIUM), 12, BRONZE), 'A rearguard buys hours: the army’s road south and the fleet’s way to Salamis', [{at: [22.2, 38.62], s: 'Thermopylae', fill: RED, size: 38, anchor: 'end'}, {at: [23.3, 39.15], s: 'Artemisium · the fleet', fill: BRONZE, size: 32}, {at: [23.8, 37.9], s: 'Athens', fill: ACCENT, size: 34}, {at: [23.15, 37.85], s: 'Salamis', fill: '#9fc3d3', size: 32, anchor: 'end'}, {at: [23.4, 38.38], s: 'Thebes', fill: DIM, size: 30}]);
    case 'arrowheads': { const head = (x: number, y: number, s: number) => `<path d="M ${x} ${y - 70 * s} L ${x + 22 * s} ${y + 10 * s} L ${x + 8 * s} ${y + 10 * s} L ${x + 8 * s} ${y + 60 * s} L ${x - 8 * s} ${y + 60 * s} L ${x - 8 * s} ${y + 10 * s} L ${x - 22 * s} ${y + 10 * s} Z" fill="#6f7f5a" stroke="#c9d1b8" stroke-width="3"/><line x1="${x}" y1="${y - 70 * s}" x2="${x}" y2="${y + 10 * s}" stroke="#c9d1b8" stroke-width="2"/>`; return frame(`${[0, 1, 2, 3, 4, 5].map((i) => head(520 + i * 260, 560, 1.6 + (i % 3) * 0.2)).join('')}${text(1150, 820, 'three-bladed (trilobate) socketed bronze arrowheads of Persian type', 40, INK, 'middle')}${text(1150, 880, 'found in quantity on the hill in 1939 · Spyridon Marinatos', 36, DIM, 'middle')}`, 'Drawn outlines, not photographs of the finds'); }
    case 'map-artemisium': return mapSvg(await geo(cacheDir), [22.0, 38.4, 24.2, 39.6], (proj) => `<line x1="${proj([23.0, 39.02])[0]}" y1="${proj([23.0, 39.02])[1]}" x2="${proj([23.4, 39.1])[0]}" y2="${proj([23.4, 39.1])[1]}" stroke="${BRONZE}" stroke-width="18"/>` + `<line x1="${proj([23.1, 39.28])[0]}" y1="${proj([23.1, 39.28])[1]}" x2="${proj([23.5, 39.35])[0]}" y2="${proj([23.5, 39.35])[1]}" stroke="${PERSIAN}" stroke-width="18"/>` + marker(proj(THERMOPYLAE), 14, RED) + curve([THERMOPYLAE, [22.9, 38.95], ARTEMISIUM].map(proj), DIM, 4, '12 10'), 'Artemisium and Thermopylae: the same three days, within sight across the gulf', [{at: [22.25, 38.65], s: 'Thermopylae', fill: RED, size: 38}, {at: [23.0, 38.9], s: 'Greek fleet · 271 triremes', fill: BRONZE, size: 32}, {at: [23.0, 39.48], s: 'Persian fleet', fill: PERSIAN, size: 32}, {at: [23.7, 38.6], s: 'Euboea', fill: DIM, size: 34}]);
    case 'map-plataea': return mapSvg(await geo(cacheDir), [21.6, 37.4, 27.0, 41.2], (proj) => curve([ATHENS, [23.0, 39.0], THERMA, [25.0, 40.9], HELLESPONT].map(proj), PERSIAN, 8, '22 14') + arrowHead(proj([25.0, 40.9]), proj(HELLESPONT), PERSIAN, 30) + marker(proj(PLATAEA), 14, ACCENT) + marker(proj(SALAMIS), 12, '#9fc3d3') + marker(proj([22.4, 39.6]), 12, PERSIAN), 'Xerxes returns to Asia; Mardonius winters in Thessaly; Plataea, summer 479 BC', [{at: [23.4, 38.1], s: 'Plataea 479', fill: ACCENT, size: 38}, {at: [22.9, 37.8], s: 'Salamis 480', fill: '#9fc3d3', size: 32, anchor: 'end'}, {at: [21.9, 39.65], s: 'Mardonius', fill: PERSIAN, size: 32, anchor: 'end'}, {at: [26.5, 40.4], s: 'Hellespont', fill: PERSIAN, size: 32}]);
    case 'epitaph': return frame(`<rect x="312" y="300" width="1680" height="700" rx="10" fill="#4a4036" stroke="#7a6a58" stroke-width="6"/>${text(1152, 470, 'Ὦ ξεῖν’, ἀγγέλλειν Λακεδαιμονίοις ὅτι τῇδε', 54, INK, 'middle')}${text(1152, 550, 'κείμεθα τοῖς κείνων ῥήμασι πειθόμενοι.', 54, INK, 'middle')}${text(1152, 720, 'Stranger, go tell the Spartans that here,', 50, ACCENT, 'middle')}${text(1152, 800, 'obedient to their laws, we lie.', 50, ACCENT, 'middle')}${text(1152, 930, 'Simonides · Herodotus 7.228', 34, DIM, 'middle')}`, '');
    case 'end-card': { const [c1, c2] = CREDITS.split(' · Plutarch'); return frame(`${text(W / 2, 540, TITLE, 96, INK, 'middle', 'bold')}${text(W / 2, 640, CHANNEL, 44, ACCENT, 'middle')}${text(W / 2, 1060, c1, 26, DIM, 'middle')}${text(W / 2, 1110, 'Plutarch' + c2, 26, DIM, 'middle')}`, ''); }
  }
}

export async function renderGraphicPng(kind: GraphicKind, file: string, cacheDir: string) {
  const sharp = (await import('sharp')).default;
  const svg = await graphicSvg(kind, cacheDir);
  await sharp(Buffer.from(svg), {density: 96}).png().toFile(file);
}

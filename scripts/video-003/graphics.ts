/** Video #003 internal graphics (free): 16 SVG cards rendered to 2304x1296 PNG (20% headroom for the
 * push-in). Maps use Natural Earth 50 m coastlines fetched once per run (public domain); if the fetch
 * fails the map is drawn without coastlines and the omission is reported in the QA notes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {GraphicKind} from './plan';
import {TITLE, CHANNEL, CREDITS} from './plan';

const W = 2304, H = 1296;
const BG = '#0d1417', INK = '#d9e2e4', DIM = '#8ea3a8', ACCENT = '#f0b24a', WATER = '#2b5f7a', LAND = '#1c2a2f', RED = '#b8432f';
const FONT = 'DejaVu Sans';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x: number, y: number, s: string, size = 40, fill = INK, anchor: 'start' | 'middle' | 'end' = 'start', weight = 'normal') => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;
const frame = (inner: string, caption?: string) => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${BG}"/>${inner}${caption ? text(W / 2, H - 70, caption, 34, DIM, 'middle') : ''}</svg>`;

type LonLat = [number, number];
type Geo = {countries: {name: string; rings: LonLat[][]}[]; lakes: {name: string; rings: LonLat[][]}[]} | null;
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
    const rings = (g: {type: string; coordinates: unknown}): LonLat[][] => g.type === 'Polygon' ? (g.coordinates as LonLat[][]) .map((r) => r) : g.type === 'MultiPolygon' ? (g.coordinates as LonLat[][][]).map((p) => p[0]) : [];
    const c = await get('ne_50m_admin_0_countries.geojson'); const l = await get('ne_50m_lakes.geojson');
    geoCache = {countries: c.features.map((f: {properties: Record<string, string>; geometry: {type: string; coordinates: unknown}}) => ({name: f.properties.NAME || f.properties.ADMIN || '', rings: rings(f.geometry)})), lakes: l.features.map((f: {properties: Record<string, string>; geometry: {type: string; coordinates: unknown}}) => ({name: f.properties.name || f.properties.name_alt || '', rings: rings(f.geometry)}))};
  } catch (e) { graphicsNotes.push('Natural Earth coastlines unavailable: ' + (e instanceof Error ? e.message : String(e))); geoCache = null; }
  return geoCache;
}

function mapSvg(g: Geo, bbox: [number, number, number, number], inner: (proj: (p: LonLat) => [number, number]) => string, caption: string, labels: {at: LonLat; s: string; size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'}[] = []) {
  const [w, s, e, n] = bbox; const pad = 120; const sx = (W - 2 * pad) / (e - w), sy = (H - 2 * pad) / (n - s); const k = Math.min(sx, sy);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const proj = (p: LonLat): [number, number] => [W / 2 + (p[0] - cx) * k, H / 2 - (p[1] - cy) * k];
  const poly = (rings: LonLat[][], fill: string, stroke: string) => rings.map((r) => `<path d="${r.map((p, i) => (i ? 'L' : 'M') + proj(p).map((v) => v.toFixed(1)).join(' ')).join(' ')} Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>`).join('');
  const inView = (rings: LonLat[][]) => rings.some((r) => r.some((p) => p[0] > w - 5 && p[0] < e + 5 && p[1] > s - 5 && p[1] < n + 5));
  let body = `<rect width="100%" height="100%" fill="${WATER}" opacity="0.35"/>`;
  if (g) { for (const c of g.countries) if (inView(c.rings)) body += poly(c.rings, LAND, '#6f8a90'); for (const l of g.lakes) if (inView(l.rings)) body += poly(l.rings, WATER, '#5f8ea3'); }
  body += inner(proj);
  for (const l of labels) { const [x, y] = proj(l.at); body += text(x, y, l.s, l.size ?? 36, l.fill ?? INK, l.anchor ?? 'start'); }
  body += `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#000" stroke-width="0"/>`;
  return frame(body, caption);
}
const marker = (p: [number, number], r = 14, fill = ACCENT) => `<circle cx="${p[0]}" cy="${p[1]}" r="${r + 10}" fill="${fill}" opacity="0.25"/><circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="${fill}" stroke="#000" stroke-width="2"/>`;

const NYOS: LonLat = [10.30, 6.44], MONOUN: LonLat = [10.59, 5.58], KIVU: LonLat = [29.0, -2.0], GOMA: LonLat = [29.22, -1.68];
const CVL: LonLat[] = [[5.63, -1.43], [6.6, 0.3], [7.4, 1.6], [8.7, 3.5], [9.17, 4.2], [9.83, 5.03], [10.07, 5.6], [10.5, 6.2], [11.5, 6.9], [13.5, 7.3]];

const curve = (pts: [number, number][], stroke = ACCENT, width = 8) => `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p.join(' ')).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const axes = (x0: number, y0: number, x1: number, y1: number, xl: string, yl: string) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${DIM}" stroke-width="3"/><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="${DIM}" stroke-width="3"/>${text(x1, y0 + 56, xl, 34, DIM, 'end')}${text(x0 - 20, y1 - 20, yl, 34, DIM, 'start')}`;
const bubbles = (cx: number, y0: number, y1: number, n: number, seed: number, spread = 160) => Array.from({length: n}, (_, i) => { const t = ((i * 7919 + seed * 104729) % 1000) / 1000; const y = y1 + (y0 - y1) * (i / n); const r = 6 + 10 * ((i * 31 + seed) % 7) / 7; return `<circle cx="${cx + (t - 0.5) * spread * (1 + (y0 - y) / (y0 - y1))}" cy="${y}" r="${r}" fill="none" stroke="${INK}" stroke-width="2.5" opacity="0.8"/>`; }).join('');

function lakeSection(waterTop: number, label = true) {
  // crater bowl: walls + flat deep plain, north dam on the right
  const d = `M 300 ${waterTop - 220} L 560 ${waterTop - 40} L 760 ${waterTop + 520} L 1540 ${waterTop + 520} L 1740 ${waterTop - 20} L 1800 ${waterTop - 60} L 2000 ${waterTop - 220}`;
  return `<path d="${d} L 2000 ${H} L 300 ${H} Z" fill="${LAND}"/><path d="M 560 ${waterTop} L 1760 ${waterTop} L 1740 ${waterTop - 20} L 1540 ${waterTop + 520} L 760 ${waterTop + 520} Z" fill="${WATER}" opacity="0.9"/><path d="${d}" fill="none" stroke="#6f8a90" stroke-width="4"/>${label ? text(1150, waterTop - 30, 'Lake Nyos', 36, DIM, 'middle') : ''}`;
}

export async function graphicSvg(kind: GraphicKind, cacheDir: string): Promise<string> {
  switch (kind) {
    case 'map-cvl': return mapSvg(await geo(cacheDir), [2, -2, 16, 10], (proj) => curve(CVL.map(proj), ACCENT, 7).replace('stroke-width="7"', 'stroke-width="7" stroke-dasharray="26 18"') + marker(proj(NYOS)), 'The Cameroon Volcanic Line (schematic) and Lake Nyos', [{at: [11.8, 5.2], s: 'CAMEROON', size: 44, fill: DIM}, {at: [7.0, 9.3], s: 'NIGERIA', size: 44, fill: DIM}, {at: [3.2, 1.6], s: 'Gulf of Guinea', size: 36, fill: '#9fc3d3'}, {at: [10.05, 6.75], s: 'Lake Nyos', size: 44, fill: ACCENT, anchor: 'end'}, {at: [12.0, 7.95], s: 'Cameroon Volcanic Line', size: 36, fill: ACCENT}]);
    case 'cross-section': return frame(`${lakeSection(560)}<line x1="2060" y1="560" x2="2060" y2="1080" stroke="${ACCENT}" stroke-width="5"/><line x1="2030" y1="560" x2="2090" y2="560" stroke="${ACCENT}" stroke-width="5"/><line x1="2030" y1="1080" x2="2090" y2="1080" stroke="${ACCENT}" stroke-width="5"/>${text(2110, 835, '≈ 200 m', 44, ACCENT)}<path d="M 1740 540 L 1800 500 L 1990 340" fill="none" stroke="${RED}" stroke-width="6"/>${text(1560, 300, 'natural dam of loose volcanic rock', 36, RED, 'start')}`, 'Cross-section, not to scale · about 1.9 km long, 1.2 km wide, 208 m deep');
    case 'map-monoun': return mapSvg(await geo(cacheDir), [8.9, 4.3, 12.3, 7.7], (proj) => `<line x1="${proj(NYOS)[0]}" y1="${proj(NYOS)[1]}" x2="${proj(MONOUN)[0]}" y2="${proj(MONOUN)[1]}" stroke="${ACCENT}" stroke-width="5" stroke-dasharray="22 16"/>${marker(proj(NYOS))}${marker(proj(MONOUN), 14, RED)}`, 'Two crater lakes, about 100 km apart', [{at: [10.42, 6.52], s: 'Lake Nyos · 1986', size: 44, fill: ACCENT}, {at: [10.7, 5.5], s: 'Lake Monoun · 1984', size: 44, fill: RED}, {at: [10.62, 6.08], s: '≈ 100 km', size: 38, fill: INK}]);
    case 'co2-source': return frame(`${lakeSection(420, true)}<ellipse cx="1150" cy="1180" rx="420" ry="110" fill="${RED}" opacity="0.8"/>${text(1150, 1195, 'magma', 40, INK, 'middle')}${[900, 1050, 1200, 1350].map((x) => `<path d="M ${x} 1070 L ${x + 20} 1000 L ${x - 10} 960 L ${x + 15} 940" fill="none" stroke="${ACCENT}" stroke-width="5" stroke-dasharray="14 12"/>`).join('')}${bubbles(1150, 940, 500, 14, 3)}${text(1600, 1000, 'CO₂ seeps up through fractured rock', 36, ACCENT)}${text(1600, 1050, 'into the deepest water', 36, ACCENT)}`, 'Volcanic carbon dioxide beneath the crater');
    case 'stratification': return frame(`${lakeSection(420, false)}<path d="M 700 760 L 1600 760" stroke="${INK}" stroke-width="4" stroke-dasharray="20 14"/>${text(1150, 600, 'surface layer · warmer, lighter', 40, INK, 'middle')}${text(1150, 900, 'deep layer · cold, dense, rich in CO₂', 40, ACCENT, 'middle')}${text(1150, 790, 'the two layers almost never mix', 34, DIM, 'middle')}`, 'A stratified lake');
    case 'lift': return frame(`${lakeSection(420, false)}<rect x="1080" y="900" width="140" height="140" rx="20" fill="${ACCENT}" opacity="0.85"/><path d="M 1150 880 L 1150 600" stroke="${ACCENT}" stroke-width="8"/><path d="M 1110 650 L 1150 600 L 1190 650" fill="none" stroke="${ACCENT}" stroke-width="8"/>${text(1290, 980, 'gas-rich water lifted', 40, ACCENT)}${text(1290, 1030, 'pressure drops → bubbles form', 40, ACCENT)}`, 'Any disturbance can lift deep water');
    case 'curve-rising': return frame(`${axes(300, 1000, 2000, 300, 'time', 'dissolved CO₂')}${curve([[300, 940], [600, 880], [900, 820], [1200, 700], [1500, 560], [1800, 420]])}<line x1="300" y1="380" x2="2000" y2="380" stroke="${RED}" stroke-width="4" stroke-dasharray="20 14"/>${text(1980, 360, 'danger', 36, RED, 'end')}${text(600, 1056, '1986', 34, DIM, 'middle')}${text(1800, 1056, '2001', 34, DIM, 'middle')}`, 'The gas was building up again');
    case 'siphon': return frame(`${lakeSection(360, false)}<rect x="1120" y="200" width="60" height="820" fill="none" stroke="${INK}" stroke-width="6"/><rect x="1060" y="200" width="180" height="30" fill="${INK}"/>${bubbles(1150, 1000, 240, 22, 5, 20)}<path d="M 1150 200 C 1150 60, 1000 40, 980 120 M 1150 200 C 1150 60, 1300 40, 1320 120 M 1150 200 L 1150 30" fill="none" stroke="#9fd3e8" stroke-width="7" stroke-linecap="round"/>${text(1400, 820, 'rising water fizzes', 40, ACCENT)}${text(1400, 870, 'bubbles lift the column', 40, ACCENT)}${text(1400, 920, 'no pump needed', 40, ACCENT)}`, 'The self-sustaining degassing pipe');
    case 'curve-steady': return frame(`${axes(300, 1000, 2000, 300, 'time', 'dissolved CO₂')}${curve([[300, 420], [600, 520], [900, 640], [1200, 740], [1500, 790], [1800, 800], [2000, 800]])}${text(600, 1056, '2001', 34, DIM, 'middle')}${text(1800, 1056, '2019', 34, DIM, 'middle')}${text(1250, 760, 'gas in = gas out', 44, ACCENT, 'middle')}`, 'Steady state reached');
    case 'map-flood': return mapSvg(await geo(cacheDir), [8.3, 5.3, 12.3, 8.9], (proj) => curve(([NYOS, [10.25, 6.7], [10.0, 6.95], [9.75, 7.1], [9.45, 7.25]] as LonLat[]).map(proj), RED, 7).replace('stroke-width="7"', 'stroke-width="7" stroke-dasharray="24 16"') + marker(proj(NYOS)), 'Modelled flood path if the dam failed (approximate)', [{at: [10.42, 6.5], s: 'Lake Nyos', size: 44, fill: ACCENT}, {at: [9.1, 7.6], s: 'NIGERIA', size: 44, fill: DIM}, {at: [11.0, 6.0], s: 'CAMEROON', size: 44, fill: DIM}, {at: [9.9, 7.55], s: '≈ 100 km downstream', size: 36, fill: RED}]);
    case 'map-kivu': return mapSvg(await geo(cacheDir), [27.4, -3.6, 31.2, 0.2], (proj) => marker(proj(GOMA), 12), 'Lake Kivu, between Rwanda and the Democratic Republic of the Congo', [{at: [28.95, -1.9], s: 'Lake Kivu', size: 48, fill: '#bfe3f2', anchor: 'middle'}, {at: [29.3, -1.72], s: 'Goma · Gisenyi', size: 36, fill: ACCENT}, {at: [29.85, -1.9], s: 'RWANDA', size: 44, fill: DIM}, {at: [27.7, -1.2], s: 'D.R. CONGO', size: 44, fill: DIM}]);
    case 'volumes': return frame(`<rect x="500" y="300" width="800" height="700" rx="18" fill="${WATER}" stroke="${INK}" stroke-width="4"/>${text(900, 640, '≈ 300 km³', 72, INK, 'middle', 'bold')}${text(900, 720, 'dissolved carbon dioxide', 40, INK, 'middle')}<rect x="1450" y="860" width="380" height="140" rx="18" fill="${ACCENT}" stroke="${INK}" stroke-width="4"/>${text(1640, 920, '≈ 60 km³', 52, '#1b1b1b', 'middle', 'bold')}${text(1640, 965, 'methane', 34, '#1b1b1b', 'middle')}`, 'Gas dissolved in the deep water of Lake Kivu');
    case 'curve-flat': return frame(`${axes(300, 1000, 2000, 300, 'time', 'dissolved gas')}${curve([[300, 620], [700, 612], [1100, 618], [1500, 610], [2000, 614]])}${text(500, 1056, '1974', 34, DIM, 'middle')}${text(1900, 1056, '2020', 34, DIM, 'middle')}${text(1150, 560, 'close to steady state', 44, ACCENT, 'middle')}`, 'Measurements show no increasing risk (Bärenbold et al. 2020)');
    case 'fraction': return frame(`<rect x="500" y="300" width="900" height="700" rx="18" fill="${WATER}" stroke="${INK}" stroke-width="4"/><rect x="1400" y="940" width="40" height="60" fill="${ACCENT}"/><path d="M 1440 970 L 1620 970" stroke="${ACCENT}" stroke-width="5"/>${text(1640, 985, 'extracted so far', 40, ACCENT)}${text(950, 670, 'gas in the deep water', 44, INK, 'middle')}`, 'Only a small fraction has been removed (illustrative)');
    case 'same-physics': return frame(`<path d="M 200 1100 L 1050 1100 L 1050 500 L 200 500 Z" fill="${WATER}" opacity="0.7"/>${bubbles(625, 1080, 520, 30, 7)}<path d="M 625 500 C 625 380, 520 360, 500 430 M 625 500 C 625 380, 730 360, 750 430" fill="none" stroke="#9fd3e8" stroke-width="7"/>${text(625, 300, 'the eruption', 44, RED, 'middle')}<path d="M 1250 1100 L 2100 1100 L 2100 500 L 1250 500 Z" fill="${WATER}" opacity="0.7"/><rect x="1645" y="520" width="60" height="560" fill="none" stroke="${INK}" stroke-width="6"/>${bubbles(1675, 1060, 540, 18, 9, 20)}<path d="M 1675 500 C 1675 380, 1570 360, 1550 430 M 1675 500 C 1675 380, 1780 360, 1800 430" fill="none" stroke="#9fd3e8" stroke-width="7"/>${text(1675, 300, 'the pipe', 44, ACCENT, 'middle')}${text(1150, 1220, 'the same physics, controlled', 44, INK, 'middle')}`, '');
    case 'end-card': return frame(`${text(W / 2, 540, TITLE, 96, INK, 'middle', 'bold')}${text(W / 2, 640, CHANNEL, 44, ACCENT, 'middle')}${text(W / 2, 1100, CREDITS, 26, DIM, 'middle')}`, '');
  }
}

export async function renderGraphicPng(kind: GraphicKind, file: string, cacheDir: string) {
  const sharp = (await import('sharp')).default;
  const svg = await graphicSvg(kind, cacheDir);
  await sharp(Buffer.from(svg), {density: 96}).png().toFile(file);
}

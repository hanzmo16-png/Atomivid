// Genera remotion/map-land.json: costas reales (Natural Earth 4.1.0, dominio público, vía
// world-atlas@2, ISC) y el contorno de Rhode Island (U.S. Census Bureau, dominio público,
// vía us-atlas@3, ISC), recortadas y simplificadas para los mapas del documental del océano.
// Uso (en una carpeta aparte, sin añadir dependencias al proyecto):
//   npm install world-atlas@2 us-atlas@3 topojson-client@3
//   node <repo>/content/long-form/ocean-deep-001/build_map_land.mjs <node_modules> <repo>/remotion/map-land.json
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";

const [nm, out] = process.argv.slice(2);
const load = (p) => JSON.parse(readFileSync(path.join(nm, p), "utf8"));

// Proporción real en una caja 2:1 (equirectangular local): lonSpan = 2·latSpan / cos(latMedia).
const around = (lat, lon, latSpan) => {
  const lonSpan = (2 * latSpan) / Math.cos((lat * Math.PI) / 180);
  const r = (n) => Math.round(n * 1000) / 1000;
  return { minLat: r(lat - latSpan / 2), maxLat: r(lat + latSpan / 2), minLon: r(lon - lonSpan / 2), maxLon: r(lon + lonSpan / 2) };
};
const REGIONS = {
  // Pacífico centrado en el antimeridiano: longitudes 0–360 (−150° se escribe 210°).
  pacific: { res: "50m", bounds: { minLat: -50, maxLat: 50, minLon: 100, maxLon: 300 } },
  "rhode-island": { res: "10m", bounds: around(41.6, -71.5, 1.8), highlightState: "44" },
  monterey: { res: "10m", bounds: around(36.8, -121.9, 1.8) },
  // Contexto: Filipinas, Taiwán, el sur de Japón y el arco de las Marianas.
  mariana: { res: "10m", bounds: around(18, 138, 34) },
};

// Natural Earth parte casi todos los anillos en ±180°: se desplaza el anillo
// ENTERO (−360, 0 o +360) al tramo que más solapa la región. Desplazar punto a punto lo partiría.
function shiftRing(input, b) {
  // Algunos anillos (islas en ±180°, p. ej. Fiyi) no vienen partidos: se "desenrollan" para que
  // cada punto quede a menos de 180° del anterior y el anillo sea continuo.
  const ring = [];
  for (const [lon, lat] of input) {
    let x = lon;
    if (ring.length) { const prev = ring[ring.length - 1][0]; while (x - prev > 180) x -= 360; while (prev - x > 180) x += 360; }
    ring.push([x, lat]);
  }
  let lo = Infinity, hi = -Infinity;
  for (const [lon] of ring) { if (lon < lo) lo = lon; if (lon > hi) hi = lon; }
  let best = 0, bestOverlap = -Infinity;
  for (const k of [-360, 0, 360]) {
    const overlap = Math.min(hi + k, b.maxLon) - Math.max(lo + k, b.minLon);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = k; }
  }
  return ring.map(([lon, lat]) => [lon + best, lat]);
}

// Recorte Sutherland–Hodgman contra el rectángulo (con margen) — el SVG recorta el resto.
function clipRing(ring, b) {
  const edges = [
    [(p) => p[0] >= b.minLon, (a, c) => lerpX(a, c, b.minLon)],
    [(p) => p[0] <= b.maxLon, (a, c) => lerpX(a, c, b.maxLon)],
    [(p) => p[1] >= b.minLat, (a, c) => lerpY(a, c, b.minLat)],
    [(p) => p[1] <= b.maxLat, (a, c) => lerpY(a, c, b.maxLat)],
  ];
  let pts = ring;
  for (const [inside, cut] of edges) {
    if (pts.length === 0) break;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      if (inside(cur)) { if (!inside(prev)) next.push(cut(prev, cur)); next.push(cur); }
      else if (inside(prev)) next.push(cut(prev, cur));
    }
    pts = next;
  }
  return pts;
}
const lerpX = (a, c, x) => [x, a[1] + ((c[1] - a[1]) * (x - a[0])) / (c[0] - a[0])];
const lerpY = (a, c, y) => [a[0] + ((c[0] - a[0]) * (y - a[1])) / (c[1] - a[1]), y];

// Douglas–Peucker con tolerancia de ~0,6 px en un lienzo de 1600 px de ancho.
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  // Anillo cerrado (o casi): la base inicio→fin es degenerada; se parte en el punto más lejano al inicio.
  const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
  if (Math.hypot(ex - sx, ey - sy) < tol) {
    let far = 1, best = -1;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - sx, pts[i][1] - sy); if (d > best) { best = d; far = i; } }
    return [...simplifyOpen(pts.slice(0, far + 1), tol).slice(0, -1), ...simplifyOpen(pts.slice(far), tol)];
  }
  return simplifyOpen(pts, tol);
}
function simplifyOpen(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let max = 0, idx = -1;
    const [x1, y1] = pts[s], [x2, y2] = pts[e]; const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = s + 1; i < e; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len; if (d > max) { max = d; idx = i; } }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function polygonsOf(geojson) {
  const polys = [];
  for (const f of geojson.type === "FeatureCollection" ? geojson.features : [geojson]) {
    const g = f.geometry;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  return polys;
}

function prepare(polys, b) {
  const lonSpan = b.maxLon - b.minLon, latSpan = b.maxLat - b.minLat;
  const m = { minLon: b.minLon - lonSpan * 0.02, maxLon: b.maxLon + lonSpan * 0.02, minLat: b.minLat - latSpan * 0.02, maxLat: b.maxLat + latSpan * 0.02 };
  const tol = (lonSpan / 1600) * 0.6;
  const digits = lonSpan > 50 ? 2 : 3, f = 10 ** digits;
  const out = [];
  for (const poly of polys) {
    const rings = [];
    for (const ring of poly) {
      const shifted = shiftRing(ring, b);
      const clipped = clipRing(shifted, m);
      if (clipped.length < 3) continue;
      const simple = simplify(clipped, tol).map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f]);
      if (simple.length >= 3) rings.push(simple);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

const regions = {};
for (const [key, r] of Object.entries(REGIONS)) {
  const land = load(`world-atlas/land-${r.res}.json`);
  const entry = { bounds: r.bounds, land: prepare(polygonsOf(feature(land, land.objects.land)), r.bounds) };
  if (r.highlightState) {
    const states = load("us-atlas/states-10m.json");
    const all = feature(states, states.objects.states);
    const st = { type: "FeatureCollection", features: all.features.filter((x) => x.id === r.highlightState) };
    entry.highlight = prepare(polygonsOf(st), r.bounds);
  }
  regions[key] = entry;
}
writeFileSync(out, JSON.stringify({
  source: "Coastlines: Natural Earth 4.1.0 (public domain) via world-atlas@2 (ISC). Rhode Island outline: U.S. Census Bureau cartographic boundaries (public domain) via us-atlas@3 (ISC).",
  generatedBy: "content/long-form/ocean-deep-001/build_map_land.mjs",
  regions,
}) + "\n");
console.log(Object.fromEntries(Object.entries(regions).map(([k, v]) => [k, { polygons: v.land.length, points: v.land.flat(2).length, highlight: v.highlight?.flat(2).length ?? 0 }])));

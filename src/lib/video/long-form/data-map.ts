/**
 * Mapa de DATOS (calidad M2): geografía real (Natural Earth, dominio
 * público) en lugar de mapas generados por IA, cuya geografía es
 * inventada. Puro: construye un SVG 1920×1080; el rasterizado (sharp) lo
 * hace quien lo usa.
 *
 * La cifra que se rotula se CALCULA sobre el trazado (haversine) y se
 * compara con la narrada: si no concuerda dentro de la tolerancia, no se
 * rotula (nunca se "decora" con un dato que el mapa contradice).
 */
export type LonLat = [number, number];

export type DataMapInput = {
  bbox: [number, number, number, number]; // [W, S, E, N]
  land: LonLat[][];
  lakes?: LonLat[][];
  route?: { points: LonLat[]; label?: string; approximate?: boolean };
  markers?: { at: LonLat; label: string; anchor?: "start" | "end" | "middle"; dx?: number; dy?: number }[];
  waterLabels?: { at: LonLat; label: string }[];
  /** Cifra narrada para el trazado (km): se rotula solo si el trazado medido concuerda. */
  narratedKm?: number;
  toleranceKm?: number;
  source: string;
};

export const MAP_W = 1920;
export const MAP_H = 1080;

export function haversineKm(a: LonLat, b: LonLat): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function routeLengthKm(points: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Proyección equirrectangular con corrección de latitud media, centrada y con el aspecto del lienzo. */
export function projector(bbox: DataMapInput["bbox"]) {
  const [w, s, e, n] = bbox;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const spanX = (e - w) * k;
  const spanY = n - s;
  const scale = Math.max(MAP_W / spanX, MAP_H / spanY); // cubre el lienzo (sin bordes)
  const offX = (MAP_W - spanX * scale) / 2;
  const offY = (MAP_H - spanY * scale) / 2;
  return ([lon, lat]: LonLat): [number, number] => [offX + (lon - w) * k * scale, offY + (n - lat) * scale];
}

export function buildDataMapSvg(input: DataMapInput): { svg: string; measuredKm: number | null; labeledKm: boolean } {
  const p = projector(input.bbox);
  const path = (ring: LonLat[]) => `M${ring.map((pt) => p(pt).map((v) => v.toFixed(1)).join(",")).join("L")}Z`;
  const measuredKm = input.route ? routeLengthKm(input.route.points) : null;
  const labeledKm =
    measuredKm !== null && input.narratedKm !== undefined && Math.abs(measuredKm - input.narratedKm) <= (input.toleranceKm ?? 8);
  const font = `font-family="DejaVu Sans, Arial, sans-serif"`;
  const parts: string[] = [];
  parts.push(`<rect width="${MAP_W}" height="${MAP_H}" fill="#0f2a44"/>`);
  for (const ring of input.land) parts.push(`<path d="${path(ring)}" fill="#c9b98f" stroke="#8a7a55" stroke-width="2"/>`);
  for (const ring of input.lakes ?? []) parts.push(`<path d="${path(ring)}" fill="#2f6f9f" stroke="#1f4f75" stroke-width="1.5"/>`);
  for (const w of input.waterLabels ?? []) {
    const [x, y] = p(w.at);
    parts.push(`<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" ${font} font-size="44" font-style="italic" fill="#cfe3f5" text-anchor="middle">${esc(w.label)}</text>`);
  }
  if (input.route) {
    const d = input.route.points.map((pt, i) => `${i === 0 ? "M" : "L"}${p(pt).map((v) => v.toFixed(1)).join(",")}`).join("");
    parts.push(`<path d="${d}" fill="none" stroke="#10141c" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="#ffd34d" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"${input.route.approximate ? ' stroke-dasharray="26 14"' : ""}/>`);
  }
  for (const m of input.markers ?? []) {
    const [x, y] = p(m.at);
    parts.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="13" fill="#e24b4b" stroke="white" stroke-width="4"/>`);
    parts.push(
      `<text x="${(x + (m.dx ?? 22)).toFixed(0)}" y="${(y + (m.dy ?? 12)).toFixed(0)}" ${font} font-size="46" font-weight="bold" fill="white" stroke="#10141c" stroke-width="6" paint-order="stroke" text-anchor="${m.anchor ?? "start"}">${esc(m.label)}</text>`,
    );
  }
  if (input.route && labeledKm && input.route.label) {
    const mid = input.route.points[Math.floor(input.route.points.length / 2)];
    const [x, y] = p(mid);
    parts.push(
      `<text x="${(x + 40).toFixed(0)}" y="${(y - 30).toFixed(0)}" ${font} font-size="76" font-weight="bold" fill="#ffd34d" stroke="#10141c" stroke-width="8" paint-order="stroke">${esc(input.route.label)}</text>`,
    );
  }
  parts.push(
    `<text x="${MAP_W - 40}" y="60" ${font} font-size="26" fill="#e8eef5" text-anchor="end" stroke="#10141c" stroke-width="4" paint-order="stroke">${esc(input.source)}${input.route?.approximate ? " · trazado aproximado" : ""}</text>`,
  );
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_W}" height="${MAP_H}" viewBox="0 0 ${MAP_W} ${MAP_H}">${parts.join("")}</svg>`,
    measuredKm,
    labeledKm,
  };
}

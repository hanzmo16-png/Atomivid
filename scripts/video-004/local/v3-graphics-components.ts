/** Lists text components (from with/without-<text> diffs) that violate the safe area or the subtitle band, per animated graphic. */
import path from 'node:path';
import {animFrame} from '../render';
import {GRAPHICS} from '../plan';

async function main() {
  const sharp = (await import('sharp')).default; const cacheDir = path.join(process.env.GFX_OUT!, 'geo-cache');
  for (const [id, kind] of Object.entries(GRAPHICS)) {
    const ctx = {t: 299 / 30, dur: 10, cues: [], cacheDir};
    const a = await sharp(await animFrame(kind, ctx, 299, 300)).ensureAlpha().raw().toBuffer({resolveWithObject: true}); const b = await sharp(await animFrame(kind, ctx, 299, 300, true)).ensureAlpha().raw().toBuffer();
    // coarse grid (8 px) mask, then connected components (4-neighbour) on the grid
    const G = 8, gw = 1920 / G, gh = 1080 / G; const m = new Uint8Array(gw * gh);
    for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) { const k = (y * 1920 + x) * 4; const d = Math.abs(a.data[k] - b[k]) + Math.abs(a.data[k + 1] - b[k + 1]) + Math.abs(a.data[k + 2] - b[k + 2]); if (d > 60) m[((y / G) | 0) * gw + ((x / G) | 0)] = 1; }
    const seen = new Uint8Array(gw * gh); const comps: number[][] = [];
    for (let i = 0; i < gw * gh; i++) { if (!m[i] || seen[i]) continue; const st = [i]; seen[i] = 1; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; while (st.length) { const j = st.pop()!; const x = j % gw, y = (j / gw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const n = ny * gw + nx; if (m[n] && !seen[n]) { seen[n] = 1; st.push(n); } } } comps.push([x0 * G, y0 * G, (x1 + 1) * G, (y1 + 1) * G]); }
    const bad = comps.filter(([x0, y0, x1, y1]) => x0 < 96 || x1 > 1824 || y0 < 54 || y1 > 1026 || (kind !== 'end-card' && y1 > 880));
    console.log(id, kind, 'components', comps.length, 'violations', JSON.stringify(bad));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

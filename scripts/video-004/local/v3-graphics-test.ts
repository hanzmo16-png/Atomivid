/** Local, zero-spend check of the V3 animated-graphics geometry: renders last frames through the master pipeline and measures text bboxes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {animFrame, calloutFrame} from '../render';
import type {GraphicKind} from '../plan';

async function main() {
  const outDir = process.env.GFX_OUT!; await fs.mkdir(outDir, {recursive: true});
  const sharp = (await import('sharp')).default;
  const cacheDir = path.join(outDir, 'geo-cache');
  const {GRAPHICS} = await import('../plan');
  const cases: [string, GraphicKind, string[]][] = Object.entries(GRAPHICS).map(([id, kind]) => [id, kind, []]);
  for (const [id, kind, cueWords] of cases) {
    const frames = 300; const ctx = {t: 299 / 30, dur: 10, cues: cueWords.map((w, i) => ({text: w, t: 2 + i})), cacheDir};
    const withText = await animFrame(kind, ctx, 299, frames); const noText = await animFrame(kind, ctx, 299, frames, true);
    const a = await sharp(withText).ensureAlpha().raw().toBuffer({resolveWithObject: true}); const b = await sharp(noText).ensureAlpha().raw().toBuffer();
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) { const k = (y * 1920 + x) * 4; const d = Math.abs(a.data[k] - b[k]) + Math.abs(a.data[k + 1] - b[k + 1]) + Math.abs(a.data[k + 2] - b[k + 2]); if (d > 60) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    const meta = await sharp(withText).metadata();
    console.log(JSON.stringify({id, kind, frame: [meta.width, meta.height], textBox: x1 >= 0 ? [x0, y0, x1, y1] : null, safe: x0 >= 96 && x1 <= 1824 && y0 >= 54 && y1 <= 1026, clearOfSubtitles: y1 < 880}));
    await fs.writeFile(path.join(outDir, `${id}-${kind}.png`), withText);
  }
  const ov = await sharp(await calloutFrame(null, {t: 16, dur: 16.7, cues: ['felt', 'sleeved', 'scale', 'trousers', 'wicker', 'short spears', 'daggers', 'bows'].map((w, i) => ({text: w, t: 1 + i})), cacheDir}, 499, 500)).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) { if (ov.data[(y * 1920 + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  console.log(JSON.stringify({id: 'V4-042', kind: 'still-callouts', box: [x0, y0, x1, y1], safe: x0 >= 96 && x1 <= 1824 && y0 >= 54 && y1 <= 1026}));
}
main().catch((e) => { console.error(e); process.exit(1); });

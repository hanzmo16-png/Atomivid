// Review delivery, stage "fetch" (free): rebuilds the approved Thermopylae V3 master from its Storage
// parts (refuses on a checksum mismatch) and downloads the existing, approved sources the closing
// edits reuse. Nothing is generated and no paid provider is called.
import fs from 'node:fs/promises';
import path from 'node:path';
import {list, download, sha256} from './storage.mjs';

const OUT = process.env.DELIVERY_OUT || '/tmp/delivery';
const P = 'video-004-thermopylae';
const V3_SHA = '86c128870dfeb2e56ec54129da9a3b694e6715b5464b4da1ddb14c04fd7dfc46';
const STOCK = ['V4-003', 'V4-008', 'V4-011', 'V4-012', 'V4-032', 'V4-035', 'V4-092', 'V4-093', 'V4-095', 'V4-096', 'V4-097'];
const CLIPS = ['V4-001-v1', 'V4-002-v1', 'V4-009-v1', 'V4-078-v1'];
const STILLS = ['V4-098-v2', 'V4-010-v1', 'V4-007-v1'];
const MUSIC = ['elevenlabs-inspirational-2'];

const dir = path.join(OUT, 'fetch'); await fs.mkdir(path.join(dir, 'src'), {recursive: true});
const report = {master: null, sources: [], missing: []};
const WHAT = (process.env.FETCH_WHAT || 'thermopylae').split(',');

if (WHAT.includes('dulce')) {
  // DULCE Part I: the V1 clip under the two Castello notices, and the listing of the approved final.
  const clip = 'long-form/dulce-001-full-v1/ai-video/D07-03-v3-D07-03-v3.mp4';
  const b = await download('videos', clip, path.join(dir, 'src', 'D07-03-v3.mp4'));
  report.sources.push({path: clip, bytes: b.length, sha256: sha256(b)});
  report.dulceFinalListing = await list('videos', 'dulce-part1/final/');
  report.dulceWatchListing = await list('videos', 'dulce-part1/watch/');
  await fs.writeFile(path.join(dir, 'fetch-report.json'), JSON.stringify(report, null, 2));
  if (!WHAT.includes('thermopylae')) { console.log(JSON.stringify(report.sources)); process.exit(0); }
}

// 1) Master V3 from parts + manifest.
const items = await list('videos', `${P}/final-v3/`);
report.finalV3Listing = items.map((i) => ({name: i.name, size: i.metadata?.size ?? null}));
const manifestItem = items.find((i) => i.name.endsWith('.json'));
let order = items.filter((i) => !i.name.endsWith('.json')).map((i) => i.name).sort();
if (manifestItem) {
  const m = JSON.parse((await download('videos', `${P}/final-v3/${manifestItem.name}`)).toString());
  report.manifest = m;
  const parts = m.parts || m.files || m.chunks;
  if (Array.isArray(parts)) order = parts.map((p) => (typeof p === 'string' ? p : p.name || p.file || p.path)).map((n) => n.split('/').pop());
}
const bufs = [];
for (const n of order) bufs.push(await download('videos', `${P}/final-v3/${n}`));
const master = Buffer.concat(bufs);
const got = sha256(master);
if (got !== V3_SHA) throw Error(`V3 master checksum mismatch: ${got}`);
await fs.writeFile(path.join(dir, 'VIDEO-004-v3-master.mp4'), master);
report.master = {bytes: master.length, sha256: got, parts: order};

// 2) Approved sources reused by the closing edits.
const grab = async (bucket, p, name) => {
  try { const b = await download(bucket, p, path.join(dir, 'src', name)); report.sources.push({bucket, path: p, name, bytes: b.length, sha256: sha256(b)}); }
  catch (e) { report.missing.push({bucket, path: p, error: String(e.message || e)}); }
};
for (const id of STOCK) {
  try {
    const rec = JSON.parse((await download('videos', `${P}/stock/${id}.json`)).toString());
    report.sources.push({stockRecord: id, ...rec});
    const file = String(rec.file).replace(/^videos\//, '');
    await grab('videos', file, `${id}${path.extname(file) || '.mp4'}`);
  } catch (e) { report.missing.push({stock: id, error: String(e.message || e)}); }
}
for (const c of CLIPS) { const id = c.split('-v')[0]; await grab('videos', `long-form/${P}/ai-video/${c}-${c}.mp4`, `${c}.mp4`); void id; }
for (const s of STILLS) await grab('videos', `${P}/stills/${s}.png`, `${s}.png`);
for (const m of MUSIC) await grab('music-library', `${m}.mp3`, `${m}.mp3`);

await fs.writeFile(path.join(dir, 'fetch-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({master: report.master && {bytes: report.master.bytes, sha256: report.master.sha256}, sources: report.sources.filter((s) => s.name).length, missing: report.missing}));

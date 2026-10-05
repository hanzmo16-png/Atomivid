// Uploads each review package to Storage (videos/review-delivery/<run>/<video>/) and writes signed
// download links to links.json (never printed). Objects the bucket refuses (size) are reported, not hidden.
import fs from 'node:fs/promises';
import path from 'node:path';
import {upload, sign, sha256} from './storage.mjs';

const OUT = process.env.DELIVERY_OUT || '/tmp/delivery';
const RUN = process.env.GITHUB_RUN_ID || 'local';
const DAYS = 7, SECONDS = DAYS * 86400;
const types = {'.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.srt': 'application/x-subrip', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8'};
const links = {run: RUN, expiresAt: new Date(Date.now() + SECONDS * 1000).toISOString(), videos: {}};
for (const video of ['dulce-part1', 'thermopylae']) {
  const dir = path.join(OUT, 'package', video);
  let files; try { files = (await fs.readdir(dir)).sort(); } catch { continue; }
  links.videos[video] = [];
  for (const f of files) {
    const p = `review-delivery/${RUN}/${video}/${f}`; const file = path.join(dir, f); const st = await fs.stat(file);
    try {
      const up = await upload('videos', p, file, types[path.extname(f)] || 'application/octet-stream');
      links.videos[video].push({file: f, bytes: st.size, sha256: up.sha256, storagePath: `videos/${p}`, download: await sign('videos', p, SECONDS, f), view: await sign('videos', p, SECONDS)});
    } catch (e) {
      links.videos[video].push({file: f, bytes: st.size, sha256: sha256(await fs.readFile(file)), error: String(e.message || e)});
    }
  }
}
await fs.writeFile(path.join(OUT, 'links.json'), JSON.stringify(links, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(links.videos).map(([k, v]) => [k, v.map((x) => ({file: x.file, bytes: x.bytes, ok: !x.error, error: x.error}))]))));

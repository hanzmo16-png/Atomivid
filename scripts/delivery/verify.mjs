// Review delivery, stage "verify" (free): signs a short-lived URL for every published object of a run and
// fetches it WITHOUT credentials (first 1 KB, Range), as the owner's browser would. Prints status only.
import fs from 'node:fs/promises';
import path from 'node:path';
import {list, sign} from './storage.mjs';

const RUN = process.env.VERIFY_RUN; if (!/^\d+$/.test(RUN || '')) throw Error('VERIFY_RUN missing');
const OUT = process.env.DELIVERY_OUT || '/tmp/delivery'; await fs.mkdir(OUT, {recursive: true});
const res = [];
for (const v of ['dulce-part1', 'thermopylae']) {
  for (const it of await list('videos', `review-delivery/${RUN}/${v}/`)) {
    const p = `review-delivery/${RUN}/${v}/${it.name}`;
    const u = await sign('videos', p, 300, it.name);
    const r = await fetch(u, {headers: {Range: 'bytes=0-1023'}});
    const b = Buffer.from(await r.arrayBuffer());
    res.push({video: v, file: it.name, size: it.metadata?.size ?? null, status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), contentRange: r.headers.get('content-range'), bytesRead: b.length, mp4Ftyp: it.name.endsWith('.mp4') ? b.subarray(4, 8).toString() === 'ftyp' : null});
  }
}
await fs.writeFile(path.join(OUT, 'verify-links.json'), JSON.stringify(res, null, 2));
console.log(JSON.stringify(res.map((x) => [x.file, x.status, x.type, x.contentRange, x.mp4Ftyp])));
if (!res.length || res.some((x) => x.status !== 206 && x.status !== 200)) process.exitCode = 1;

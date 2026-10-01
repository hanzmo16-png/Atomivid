/** Video #004 review proxy (free, no provider API): reassembles the existing master from its 45 MB parts in
 * Supabase Storage, encodes a single-object 480p MP4 under the bucket's 50 MB object limit with FFmpeg,
 * uploads it next to the master, signs a 7-day URL and verifies it anonymously (HTTP 200, video/mp4, byte
 * ranges). The 1080p master is never modified. Usage: npx tsx scripts/video-004/review-proxy.ts */
import fs from 'node:fs/promises';
import path from 'node:path';
import {P, out, probe, put, read, readJsonStore, run, sha, sign} from './shared';
import {V2} from './plan';

const NAME = V2 ? 'VIDEO-004-Three-Days-at-the-Hot-Gates-v2-review-480p.mp4' : 'VIDEO-004-Three-Days-at-the-Hot-Gates-review-480p.mp4';
const FINAL = V2 ? 'final-v2' : 'final';
const LIMIT = 50 * 1024 * 1024;

export async function reviewProxy() {
  await fs.mkdir(out, {recursive: true});
  const man = await readJsonStore<{file: string; bytes: number; sha256: string; parts: string[]}>(`${P}/${FINAL}/manifest.json`);
  if (!man) throw Error('No final manifest in storage');
  const master = path.join(out, man.file); const chunks: Buffer[] = [];
  for (const p of man.parts) { const b = await read(p); if (!b) throw Error('Missing part ' + p); chunks.push(b); }
  const bytes = Buffer.concat(chunks); if (bytes.length !== man.bytes || sha(bytes) !== man.sha256) throw Error('Master checksum mismatch after reassembly');
  await fs.writeFile(master, bytes);
  const pr = await probe(master); console.log('master', {seconds: pr.duration, width: pr.width, height: pr.height, bytes: bytes.length});
  // Budget: 49 MB total at the master's duration, audio 96 kbps, the rest video (two-pass for a predictable size).
  const audioK = 96; const totalK = Math.floor((49 * 1024 * 1024 * 8) / pr.duration / 1000); const videoK = totalK - audioK - 12;
  const proxy = path.join(out, NAME); const log = path.join(out, 'x264pass');
  const vf = 'scale=854:480:flags=lanczos,format=yuv420p';
  await run('ffmpeg', ['-y', '-i', master, '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-level', '3.1', '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.4)}k`, '-bufsize', `${videoK * 2}k`, '-pass', '1', '-passlogfile', log, '-an', '-f', 'mp4', '/dev/null']);
  await run('ffmpeg', ['-y', '-i', master, '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-level', '3.1', '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.4)}k`, '-bufsize', `${videoK * 2}k`, '-pass', '2', '-passlogfile', log, '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', proxy]);
  const pb = await fs.readFile(proxy); const pp = await probe(proxy);
  console.log('proxy', {seconds: pp.duration, width: pp.width, height: pp.height, bytes: pb.length, videoK, audioK});
  if (pb.length > LIMIT) throw Error(`Proxy ${pb.length} bytes exceeds the 50 MB object limit`);
  if (Math.abs(pp.duration - pr.duration) > 0.5) throw Error('Proxy duration differs from the master');
  const dest = `${P}/review/${NAME}`; await put(dest, pb, 'video/mp4');
  const url = await sign(dest, 7);
  // Anonymous verification, as a phone browser would fetch it: full GET headers, then a byte range (seeking).
  const head = await fetch(url, {method: 'GET', headers: {Range: 'bytes=0-1023'}}); const first = Buffer.from(await head.arrayBuffer());
  const tail = await fetch(url, {headers: {Range: `bytes=${pb.length - 1024}-${pb.length - 1}`}});
  const full = await fetch(url); const got = Buffer.from(await full.arrayBuffer());
  const check = {status: full.status, contentType: full.headers.get('content-type'), bytes: got.length, sha256Matches: sha(got) === sha(pb), rangeStatus: head.status, rangeTailStatus: tail.status, acceptRanges: head.headers.get('accept-ranges') ?? full.headers.get('accept-ranges'), ftypAtStart: first.subarray(4, 8).toString() === 'ftyp'};
  console.log('verify', check);
  if (full.status !== 200 || !check.sha256Matches || !/video\/mp4/.test(String(check.contentType))) throw Error('Anonymous verification failed');
  await fs.writeFile(path.join(out, 'review-link.json'), JSON.stringify({url, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), proxy: {file: NAME, bytes: pb.length, seconds: pp.duration, width: pp.width, height: pp.height, sha256: sha(pb)}, master: {file: man.file, bytes: man.bytes, sha256: man.sha256, untouched: true}, check}, null, 2));
  console.log('@@V4_REVIEW_LINK ' + JSON.stringify({url, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), bytes: pb.length, seconds: pp.duration, width: pp.width, height: pp.height}));
  await fs.rm(master, {force: true}); await fs.rm(proxy, {force: true});
}
if (process.argv[1] && /review-proxy/.test(process.argv[1])) reviewProxy().catch((e) => { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; });

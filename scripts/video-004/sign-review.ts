/** Signs a NEW 8-day URL for the EXISTING review proxy object and verifies it anonymously exactly as a
 * phone browser would: plain GET with no headers (200, video/mp4), a Range GET (206), and a HEAD.
 * Nothing is encoded, uploaded or generated. Usage: npx tsx scripts/video-004/sign-review.ts */
import fs from 'node:fs/promises';
import path from 'node:path';
import {P, bucket, out, sha} from './shared';

const OBJECT = `${P}/review/VIDEO-004-Three-Days-at-the-Hot-Gates-review-480p.mp4`;
const DAYS = 8;

async function main() {
  await fs.mkdir(out, {recursive: true});
  const {data: listing} = await bucket.list(`${P}/review`, {limit: 10});
  const obj = (listing || []).find((o) => OBJECT.endsWith(o.name)); if (!obj) throw Error('Review object missing in storage');
  const {data, error} = await bucket.createSignedUrl(OBJECT, DAYS * 86400); if (error || !data) throw Error('Sign failed: ' + error?.message);
  const url = data.signedUrl; const expiresAt = new Date(Date.now() + DAYS * 86400000).toISOString();
  // Round-trip through JSON and URL parsing so the delivered string is byte-for-byte what is tested.
  const delivered = JSON.parse(JSON.stringify({url})).url as string; const parsed = new URL(delivered);
  const anon = async (init?: RequestInit) => fetch(parsed.toString(), {...init, redirect: 'follow'});
  const head = await anon({method: 'HEAD'});
  const get = await anon(); const body = Buffer.from(await get.arrayBuffer());
  const range = await anon({headers: {Range: 'bytes=1000000-1000999'}}); const rb = Buffer.from(await range.arrayBuffer());
  const check = {
    objectBytes: obj.metadata?.size ?? null, head: head.status, get: get.status, contentType: get.headers.get('content-type'), bytes: body.length, acceptRanges: get.headers.get('accept-ranges'),
    range: range.status, rangeBytes: rb.length, contentRange: range.headers.get('content-range'), ftyp: body.subarray(4, 8).toString() === 'ftyp', sha256: sha(body), tokenChars: parsed.searchParams.get('token')?.length ?? 0,
  };
  console.log('verify', JSON.stringify(check));
  const ok = check.get === 200 && /video\/mp4/.test(String(check.contentType)) && check.range === 206 && check.rangeBytes === 1000 && check.ftyp && (check.objectBytes === null || check.bytes === check.objectBytes);
  await fs.writeFile(path.join(out, 'review-link.json'), JSON.stringify({url: delivered, expiresAt, object: OBJECT, check, ok}, null, 2));
  if (!ok) throw Error('Anonymous verification failed: ' + JSON.stringify(check));
  console.log('@@V4_SIGNED_OK ' + JSON.stringify({expiresAt, get: check.get, range: check.range, contentType: check.contentType, bytes: check.bytes}));
}
main().catch((e) => { console.error(e instanceof Error ? e.stack || e.message : String(e)); process.exitCode = 1; });

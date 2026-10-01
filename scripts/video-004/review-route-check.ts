/**
 * Zero-spend check of the app-controlled review route's upstream path (incident
 * REVIEW_DELIVERY_ANDROID_INVALID_JWT). Uses the same module as /r/<slug> to fetch the private
 * object through the authenticated endpoint with the service key (never printed), full GET and a
 * Range GET, and reports status / content-type / content-range / bytes / sha256. Nothing is written.
 */
import {createHash} from 'node:crypto';
import {forwardableRange, resolveReviewObject, responseHeaders, upstreamRequest} from '../../src/lib/delivery/review-stream';

const slug = process.env.REVIEW_SLUG || 'video-004-pron-gate';
const base = process.env.NEXT_PUBLIC_SUPABASE_URL || '', key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!base || !key) throw Error('missing Supabase env');
const obj = resolveReviewObject(slug); if (!obj) throw Error('unknown slug');

async function probe(label: string, range: string | null) {
  const up = upstreamRequest(base, key, obj!, forwardableRange(range));
  const r = await fetch(up.url, {headers: up.headers});
  const body = Buffer.from(await r.arrayBuffer());
  const h = responseHeaders(r.headers, obj!);
  console.log(`@@ROUTE_CHECK ${label} ${JSON.stringify({status: r.status, upstreamContentType: r.headers.get('content-type'), clientContentType: h['Content-Type'], contentRange: h['Content-Range'] ?? null, acceptRanges: h['Accept-Ranges'], cacheControl: h['Cache-Control'], bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), id3: body.subarray(0, 3).toString() === 'ID3'})}`);
}
async function main() {
  await probe('full-get', null);
  await probe('range-0-999', 'bytes=0-999');
  await probe('range-open', 'bytes=100000-');
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

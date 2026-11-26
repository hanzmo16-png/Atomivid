import { createHash } from 'node:crypto';
import { allowedRequest, ORIGIN } from './final-readonly-policy.mjs';

/** Full GET digest, incremental memory use, explicit redirect policy, no persisted media. */
export async function digestDelivery(raw, storageOrigin, cookieHeader, fetcher = fetch) {
  let url = new URL(raw, ORIGIN);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedRequest(url.href, 'GET', true, storageOrigin)) throw Error('unsafe delivery');
    const response = await fetcher(url.href, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(180000),
      headers: url.origin === ORIGIN && cookieHeader ? {cookie: cookieHeader} : {},
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw Error('delivery redirect unavailable');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) throw Error('delivery unavailable');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.byteLength; hash.update(chunk); }
    if (!bytes) throw Error('empty delivery');
    return {bytes, sha256: hash.digest('hex')};
  }
  throw Error('delivery redirects exceeded');
}

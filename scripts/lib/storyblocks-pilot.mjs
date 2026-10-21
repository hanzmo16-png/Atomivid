import { createHmac } from 'node:crypto';

// Internal catalogue evaluation only. Deliberately has no licensing/download API.
export const PILOT_SEARCHES = [
  { style: 'Grecorromano', media: 'videos', query: 'roman legionary shield sword', required: 'roman', excluded: 'modern,office,gym' },
  { style: 'Grecorromano', media: 'images', query: 'ancient greek philosopher marble statue', required: 'statue', excluded: 'office,gym' },
  { style: 'Medieval', media: 'videos', query: 'medieval knight armor sword', required: 'medieval', excluded: 'modern,office' },
  { style: 'Épico', media: 'videos', query: 'warrior meditating before battle', required: 'warrior', excluded: 'office,gym' },
  { style: 'Épico', media: 'videos', query: 'warrior dramatic landscape sunset', required: 'warrior', excluded: 'office,gym' },
  { style: 'Música solemne', media: 'audio', query: 'cinematic solemn orchestral' },
];

export function readPilotConfig(env = process.env) {
  if (env.STORYBLOCKS_KEY_MODE !== 'test') throw new Error('STORYBLOCKS_KEY_MODE must be test; production credentials are not authorized by this pilot.');
  const names = ['STORYBLOCKS_API_KEY', 'STORYBLOCKS_API_SECRET', 'STORYBLOCKS_PILOT_USER_ID', 'STORYBLOCKS_PILOT_PROJECT_ID'];
  const values = names.map(name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  });
  return { apiKey: values[0], apiSecret: values[1], userId: values[2], projectId: values[3] };
}

export function signedSearchUrl(config, search, nowMs = Date.now()) {
  if (!['videos', 'images', 'audio'].includes(search.media)) throw new Error('Unsupported media type');
  if (typeof search.query !== 'string' || !search.query.trim()) throw new Error('Empty search');
  const path = `/api/v2/${search.media}/search`;
  const expires = String(Math.floor(nowMs / 1000) + 300);
  const url = new URL(path, 'https://api.storyblocks.com');
  const params = {
    APIKEY: config.apiKey, EXPIRES: expires,
    HMAC: createHmac('sha256', config.apiSecret + expires).update(path).digest('hex'),
    user_id: config.userId, project_id: config.projectId,
    keywords: search.query, page: '1', results_per_page: '5',
    content_type: search.media === 'videos' ? 'footage' : search.media === 'audio' ? 'music' : 'all',
    extended: 'description,isEditorial',
  };
  if (search.media !== 'audio') {
    params.is_editorial = 'false';
    params.safe_search = 'true';
    params.orientation = 'all'; // Horizontal options remain visibly marked for crop review.
    if (search.required) params.required_keywords = search.required;
    if (search.excluded) params.filtered_keywords = search.excluded;
  }
  if (search.media === 'videos') params.min_duration = '5';
  if (search.media === 'audio') params.has_vocals = 'false';
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

function previewUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!['storyblocks.com', 'cloudfront.net'].some(domain => url.hostname.endsWith(`.${domain}`))) return null;
    if ([...url.searchParams.keys()].some(key => /^(apikey|hmac|secret)$/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

export function parseSearch(payload, search) {
  if (!payload || !Array.isArray(payload.results)) throw new Error('Storyblocks returned an unexpected search schema');
  const seen = new Set();
  const candidates = [];
  let excluded = 0;
  for (const item of payload.results.slice(0, 5)) {
    if (!item || !['number', 'string'].includes(typeof item.id) || !String(item.id).trim()) { excluded++; continue; }
    const id = String(item.id);
    const editorial = item.is_editorial ?? item.isEditorial;
    // Unknown commercial status is not silently cleared for visual assets.
    if (seen.has(id) || editorial === true || (search.media !== 'audio' && editorial !== false)) { excluded++; continue; }
    seen.add(id);
    const preview = search.media === 'videos'
      ? ['_720p', '_480p', '_360p', '_180p'].map(size => previewUrl(item.preview_urls?.[size])).find(Boolean)
      : previewUrl(item.preview_url);
    if (!preview) { excluded++; continue; }
    candidates.push({
      id, title: typeof item.title === 'string' ? item.title : id,
      media: search.media, previewUrl: preview, thumbnailUrl: previewUrl(item.thumbnail_url),
      durationSeconds: Number.isFinite(item.duration) ? item.duration : null,
      orientation: ['vertical', 'horizontal'].includes(item.orientation) ? item.orientation : 'unknown',
      license: 'PREVIEW_ONLY_NOT_LICENSED', visualReview: 'PENDING',
    });
  }
  return { ...search, excluded, candidates };
}

export async function searchPilot(config, search, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(signedSearchUrl(config, search), {
      signal: AbortSignal.timeout(15000), redirect: 'error', cache: 'no-store',
    });
  } catch {
    // Fetch errors can contain the signed URL: never propagate their message/cause.
    throw new Error('Storyblocks search failed (network, timeout or redirect); credentials were not logged.');
  }
  if (!response.ok) throw new Error(`Storyblocks search HTTP ${response.status}; no download was requested.`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Storyblocks returned invalid JSON'); }
  return parseSearch(payload, search);
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function pilotHtml(report) {
  const sections = report.searches.map(search => `<section><h2>${escape(search.style)}</h2><p>${escape(search.query)} · ${search.excluded} candidatos excluidos</p><div class="grid">${search.candidates.map(item => {
    const src = previewUrl(item.previewUrl);
    const media = !src ? '<p>Vista previa no disponible</p>' : item.media === 'videos'
      ? `<video controls preload="none" src="${escape(src)}"></video>`
      : item.media === 'audio' ? `<audio controls preload="none" src="${escape(src)}"></audio>`
        : `<img loading="lazy" src="${escape(src)}" alt="${escape(item.title)}">`;
    return `<article>${media}<h3>${escape(item.title)}</h3><p>ID ${escape(item.id)} · ${escape(item.orientation)} · ${escape(item.durationSeconds ?? '?')} s</p><p>Revisar: época, acción, emoción y recorte 9:16. Música: tono y progresión.</p><p>Vista previa; revisión pendiente; sin licencia de producción.</p></article>`;
  }).join('') || '<p>Sin candidatos: revisar consulta o cobertura; no sustituir automáticamente por otro estilo.</p>'}</div></section>`).join('');
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Atomicvid — piloto Storyblocks</title><style>body{font:16px system-ui;background:#10101a;color:#eee;max-width:1200px;margin:auto;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}article{background:#242434;padding:16px;border-radius:12px}video,img,audio{width:100%;max-height:320px;object-fit:contain}p{line-height:1.5}</style><h1>Atomicvid — evaluación Storyblocks</h1><p>Solo uso interno. Estas vistas previas no autorizan publicar ni renderizar para clientes. Ninguna escena ha sido aprobada automáticamente.</p>${sections}</html>`;
}

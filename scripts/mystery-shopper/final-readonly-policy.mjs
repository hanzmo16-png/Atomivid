export const ORIGIN = 'https://atomivid.vercel.app';
export function allowedRequest(raw, method, authenticated, storageOrigin) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.protocol !== 'https:') return false;
  if (u.origin === storageOrigin) return method === 'GET' && /^\/storage\/v1\/object\/(sign|authenticated)\//.test(u.pathname);
  if (u.origin !== ORIGIN) return false;
  if (/^\/api\//.test(u.pathname) && !/^\/api\/audio-studio\/projects\/[\da-f-]+\/audio$/.test(u.pathname)) return false;
  if (method === 'GET') return true;
  return !authenticated && method === 'POST' && u.pathname === '/login';
}
export function ownedCompleted(rows, owner, ids) {
  return rows?.length === ids.length && ids.every(id => rows.some(row => row.id === id && row.user_id === owner && row.status === 'completed'));
}

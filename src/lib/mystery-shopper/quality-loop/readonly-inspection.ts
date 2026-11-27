/** Opting out of housekeeping is not an authorization grant. Pages still authenticate and enforce ownership. */
export const READ_ONLY_INSPECTION_VERSION = 1;
export const readOnlyInspectionLoginPath = () => '/login?redirectedFrom=' + encodeURIComponent('/dashboard?inspection=read-only');
export function isReadOnlyInspection(value: unknown): boolean { return value === 'read-only'; }
export async function runPageMaintenance<T>(inspection: unknown, maintain: () => Promise<T>): Promise<T | undefined> {
  if (isReadOnlyInspection(inspection)) return undefined;
  return maintain();
}
/** Rewrite only the two audited same-origin GET pages, including RSC/prefetch and login redirects. */
export function readOnlyInspectionUrl(raw: string, origin: string, method: string): string | null {
  if (method !== 'GET') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.origin !== origin || u.username || u.password || !(u.pathname === '/dashboard' || /^\/dashboard\/videos\/[^/]+\/?$/.test(u.pathname))) return null;
  u.searchParams.set('inspection', 'read-only');
  return u.href;
}
/** A legacy backend may silently ignore the query parameter: refuse before login or dashboard navigation. */
export function supportsReadOnlyInspection(status: number, data: unknown): boolean {
  if (status !== 200 || !data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.readOnlyInspectionVersion === READ_ONLY_INSPECTION_VERSION && typeof d.sha === 'string' && /^[a-f0-9]{40}$/.test(d.sha);
}

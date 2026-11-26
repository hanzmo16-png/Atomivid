/** Default-deny boundary: no generation, no checkout, no data mutations. */
export function targetOrigin(value: string, fixture = false): string {
  const u=new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (!fixture && (u.protocol!=='https:' || !/^(atomivid(-[a-z0-9-]+)?\.vercel\.app|atomicvid\.app)$/.test(u.hostname)))) throw new Error('TARGET_NOT_ALLOWED');
  if(fixture && !['127.0.0.1','localhost'].includes(u.hostname))throw new Error('FIXTURE_MUST_BE_LOCAL');
  return u.origin;
}
export function allowBrowserRequest(input: { url: string; method: string; origin: string; authenticated: boolean; resourceType: string }): boolean {
  const u=new URL(input.url);
  if(u.origin!==input.origin)return false;
  if(!['GET','HEAD','OPTIONS'].includes(input.method)) return !input.authenticated && input.method === 'POST' && u.pathname === '/login';
  // Never let a navigation replay a render/retry/delete through a mutating GET.
  if(/^\/api\//.test(u.pathname))return /^\/api\/(build-info|audio-studio\/voices|command-center\/resource-sentinel)$/.test(u.pathname);
  if(/\/auth\/|\/logout|\/signout|\/retry|\/render|\/generate|\/checkout/.test(u.pathname))return false;
  return !['media','websocket','eventsource'].includes(input.resourceType);
}
export function sentinelStatus(status: number, data: unknown): 'READ' | 'BLOCKED' {
  if(status!==200 || !data || typeof data!=='object')return 'BLOCKED';
  const d=data as Record<string,unknown>;
  // Versioned Resource Sentinel backend contract; unknown remains unknown.
  const sentinel = d.sentinel as { accounts?: unknown[]; accountingScope?: string } | undefined;
  return sentinel?.accountingScope === 'READ_ONLY_NOT_ATOMIC_ADMISSION' && Array.isArray(sentinel.accounts) && Array.isArray(d.admission) && typeof d.observedAt === 'string' && Number.isFinite(Date.parse(d.observedAt)) && Date.now()-Date.parse(d.observedAt)<600000 && Date.parse(d.observedAt)<=Date.now()+60000 ? 'READ' : 'BLOCKED';
}
export const PRODUCT_PROVIDER_IMPACT = {
  youtube:['openai','pexels','elevenlabs','fal','runpod'], reels:['openai','pexels','elevenlabs','fal'],
  'audio-podcast':['elevenlabs','openai','ffmpeg-worker'], 'video-podcast':['elevenlabs','heygen','runpod'],
} as const;

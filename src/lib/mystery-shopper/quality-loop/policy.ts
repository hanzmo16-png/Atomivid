/** Default-deny boundary: no generation, no checkout, no data mutations. */
export function targetOrigin(value: string, fixture = false): string {
  const u=new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['http:','https:'].includes(u.protocol) || (!fixture && !['https://atomivid.vercel.app','https://atomicvid.app'].includes(u.origin))) throw new Error('TARGET_NOT_ALLOWED');
  if(fixture && !['127.0.0.1','localhost'].includes(u.hostname))throw new Error('FIXTURE_MUST_BE_LOCAL');
  return u.origin;
}
export function allowBrowserRequest(input: { url: string; method: string; origin: string; authenticated: boolean; resourceType: string; adminReadback?: boolean }): boolean {
  const u=new URL(input.url);
  if(u.origin!==input.origin)return false;
  if(!['GET','HEAD','OPTIONS'].includes(input.method)) return !input.authenticated && input.method === 'POST' && u.pathname === '/login';
  // Never let a navigation replay a render/retry/delete through a mutating GET.
  if(u.pathname==='/api/command-center/quality-loop')return input.adminReadback===true&&input.authenticated&&input.method==='GET';
  if(/^\/api\//.test(u.pathname))return /^\/api\/(build-info|audio-studio\/voices|podcast\/v3|command-center\/resource-sentinel)$/.test(u.pathname);
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
  youtube:['openai','pexels','elevenlabs','recraft','flux','runpod'], reels:['openai','pexels','elevenlabs','recraft','flux'],
  'audio-podcast':['elevenlabs','openai','ffmpeg-worker'], 'video-podcast':['elevenlabs','heygen','runpod'],
} as const;

/** A partial green account list never establishes whole-product readiness. No balances leave this function. */
export function providerReadiness(product: keyof typeof PRODUCT_PROVIDER_IMPACT, data: unknown): boolean {
 if(!data || typeof data!=='object')return false;
 const d=data as {sentinel?:{accounts?:{providers?:string[];operationalLevel?:string;balanceStatus?:string;free?:number|null}[];resources?:{resource?:string;state?:string;used?:number|null;limit?:number|null}[]}};
 const accounts=d.sentinel?.accounts||[];
 const providers=PRODUCT_PROVIDER_IMPACT[product];
 if(!providers.every(p=>accounts.some(a=>a.providers?.includes(p)&&a.operationalLevel==='GREEN'&&a.balanceStatus==='REAL'&&typeof a.free==='number'&&Number.isFinite(a.free)&&a.free>0)))return false;
 return !!d.sentinel?.resources?.some(r=>r.resource==='workers'&&r.state==='VERIFIED'&&typeof r.used==='number'&&typeof r.limit==='number'&&r.used<r.limit);
}

/** No recurring storage payload reads without verified free egress; explicit manual QA stays bounded. */
export function allowMediaProbe(trigger: string, localFixture: boolean): boolean { return localFixture || trigger === 'workflow_dispatch'; }

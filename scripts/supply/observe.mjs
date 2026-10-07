import { pathToFileURL } from 'node:url';

// Billing reads only. Never accepts a caller-controlled URL or logs response bodies.
const providers = [
  { name: 'elevenlabs', key: 'ELEVENLABS_API_KEY', url: 'https://api.elevenlabs.io/v1/user/subscription', unit: 'character' },
  { name: 'runway', key: 'RUNWAY_API_KEY', url: 'https://api.dev.runwayml.com/v1/organization', unit: 'credit' },
  { name: 'heygen', key: 'HEYGEN_API_KEY', url: 'https://api.heygen.com/v3/users/me', unit: 'usd' },
];
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export function parseBalance(provider, value) {
  if (provider === 'elevenlabs') {
    if (!finite(value.character_limit) || !finite(value.character_count)) return null;
    const reset = value.next_character_count_reset_unix;
    const renewal = finite(reset) && reset > 0 && reset * 1000 < 8.64e15 ? new Date(reset * 1000).toISOString() : null;
    return { available: Math.max(0, value.character_limit - value.character_count), unit: 'character', baseline: value.character_limit,
      renewal_date: renewal?.slice(0, 10) ?? null, details: { renewalAt: renewal } };
  }
  if (provider === 'runway') return finite(value.creditBalance) ? { available: value.creditBalance, unit: 'credit', baseline: null, renewal_date: null, details: {} } : null;
  const d = value.data, w = d?.wallet;
  if (d?.billing_type !== 'wallet' || !['usd', 'credits'].includes(w?.currency) || !finite(w?.remaining_balance)) return null;
  return { available: w.remaining_balance, unit: w.currency === 'usd' ? 'usd' : 'credit', baseline: null, renewal_date: null,
    details: { autoReload: typeof w.auto_reload?.enabled === 'boolean' ? w.auto_reload.enabled : null } };
}

export async function observe(env, request = fetch, now = () => new Date().toISOString()) {
  const base = env.SUPABASE_URL;
  if (base !== 'https://msyxczcdjhbednmfzxqq.supabase.co' || !env.SUPABASE_SERVICE_ROLE_KEY) throw Error('MONITOR_DATABASE_NOT_CONFIGURED');
  async function db(path, method = 'GET', body, prefer) {
    const r = await request(`${base}/rest/v1/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw Error('MONITOR_DATABASE_WRITE_OR_READ_FAILED');
    return method === 'GET' ? r.json() : null;
  }
  const policies = await db('pi_supply_policies?select=provider,unit,baseline,enabled');
  if (!Array.isArray(policies)) throw Error('MONITOR_POLICIES_UNAVAILABLE');
  const results = [];
  for (const p of providers) {
    const checked_at = now(); // Capture before billing GET; do not erase concurrent consumption.
    let balance = null, health = 'UNCHECKED', failure = 'credential_missing';
    if (env[p.key]) {
      try {
        const headers = p.name === 'elevenlabs' ? { 'xi-api-key': env[p.key] } : p.name === 'heygen' ? { 'X-Api-Key': env[p.key] } : { Authorization: `Bearer ${env[p.key]}`, 'X-Runway-Version': '2024-11-06' };
        const r = await request(p.url, { method: 'GET', headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        health = r.ok ? 'OK' : r.status >= 500 ? 'DEGRADED' : 'DOWN';
        failure = r.ok ? 'balance_not_supported_or_invalid' : `http_${r.status}`;
        if (r.ok) balance = parseBalance(p.name, await r.json());
      } catch { health = 'DEGRADED'; failure = 'read_failed'; }
    }
    const policy = policies.find(x => x.provider === p.name);
    const baseline = balance?.baseline ?? (policy?.unit === balance?.unit && Number(policy?.baseline) > 0 ? Number(policy.baseline) : null);
    const ratio = balance && baseline > 0 ? balance.available / baseline : null;
    // This observes a wallet, not job admission. It cannot certify unreserved capacity.
    const level = !balance ? 'UNKNOWN' : balance.available === 0 || (ratio !== null && ratio <= .15) ? 'RED' : ratio !== null && ratio <= .3 ? 'YELLOW' : 'UNKNOWN';
    await db('pi_capacity_snapshots', 'POST', { provider: p.name, unit: balance?.unit ?? p.unit, available: balance?.available ?? null,
      reserved: 0, pending: 0, renewal_date: balance?.renewal_date ?? null, health, reliability: balance ? 'provider_api' : 'none',
      status: level, checked_at }, 'return=minimal');
    const existing = await db(`pi_provider_accounts?provider=eq.${p.name}&select=notes`);
    const prefix = '[ATOMIVID_MONITOR]';
    const oldNotes = String(existing?.[0]?.notes ?? '').split(prefix)[0].trim();
    const evidence = { checkedAt: checked_at, source: 'github-render-worker-secret', secretReference: p.key,
      balanceVerified: !!balance, unit: balance?.unit ?? null, baseline, ...balance?.details, failure: balance ? null : failure };
    await db(`pi_provider_accounts?provider=eq.${p.name}`, 'PATCH', {
      balance_source: balance ? 'provider_api' : 'none', status: balance ? 'active' : 'unknown',
      secret_reference_name: p.key, renewal_date: balance?.renewal_date ?? null,
      notes: `${oldNotes}\n${prefix}${JSON.stringify(evidence)}`, updated_at: now(),
    }, 'return=minimal');
    // Internal persistent notices only. No email/webhook, generation, refill or dispatch.
    if (level === 'RED' || level === 'YELLOW' || !balance) {
      const bucket = Math.floor(Date.parse(checked_at) / 3_600_000);
      await db('pi_supply_alerts?on_conflict=id', 'POST', {
        id: `observe:${p.name}:${level}:${bucket}`, provider: p.name, level,
        payload: { provider: p.name, level, reason: balance ? 'reported_wallet_low' : failure, balance: balance?.available ?? null, unit: balance?.unit ?? null,
          remainingRatio: ratio, checkedAt: checked_at, scope: 'wallet_observation_only', destination: 'internal_outbox' },
      }, 'resolution=ignore-duplicates,return=minimal');
    }
    results.push({ provider: p.name, verified: !!balance, health, notice: level === 'YELLOW' || level === 'RED' || !balance });
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  observe(process.env).then(results => console.log(JSON.stringify({ ok: true, providers: results }))).catch(() => {
    console.error('Atomivid balance observation incomplete; inspect private monitoring records.'); process.exitCode = 1;
  });
}

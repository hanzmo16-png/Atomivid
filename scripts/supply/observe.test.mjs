import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, observe } from './observe.mjs';
const now = () => '2026-10-05T20:25:00Z';
const env = { SUPABASE_URL: 'https://msyxczcdjhbednmfzxqq.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-db', ELEVENLABS_API_KEY: 'fixture-voice', RUNWAY_API_KEY: 'fixture-video', HEYGEN_API_KEY: 'fixture-avatar' };

test('parses only nonnegative numeric balances and never treats a spending cap as prepaid funds', () => {
  assert.equal(parseBalance('elevenlabs', { character_limit: 63002, character_count: 45546 }).available, 17456);
  assert.equal(parseBalance('runway', { creditBalance: 250 }).available, 250);
  for (const v of [-1, null, '250', Infinity, NaN]) assert.equal(parseBalance('runway', { creditBalance: v }), null);
  assert.equal(parseBalance('heygen', { data: { billing_type: 'usage_based', usage_based: { spending_cap_usd: 999 } } }), null);
  const result = parseBalance('heygen', { data: { email: 'private@example.test', billing_type: 'wallet', wallet: { currency: 'usd', remaining_balance: 1.5, auto_reload: { enabled: false } } } });
  assert.equal(result.unit, 'usd'); assert.equal(result.details.autoReload, false); assert.ok(!JSON.stringify(result).includes('private'));
});

function fixture(failRunway = false, dbError = false) {
  const writes = [], gets = [];
  const request = async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (!url.startsWith(env.SUPABASE_URL)) {
      assert.equal(init.method, 'GET', 'provider mutation forbidden'); gets.push(url);
      if (url.includes('runwayml')) return failRunway ? new Response(null, { status: 403 }) : Response.json({ creditBalance: 250 });
      if (url.includes('elevenlabs')) return Response.json({ character_limit: 63002, character_count: 45546 });
      if (url.includes('heygen')) return Response.json({ data: { email: 'private@example.test', billing_type: 'wallet', wallet: { currency: 'usd', remaining_balance: 1.5 } } });
      assert.fail('unexpected destination');
    }
    if (dbError) return new Response(null, { status: 503 });
    if (init.method === 'GET') return Response.json(url.includes('pi_supply_policies') ? [{ provider: 'runway', unit: 'credit', baseline: 250, enabled: false }, { provider: 'heygen', unit: 'usd', baseline: 5, enabled: false }] : [{ notes: 'Owner note' }]);
    const body = JSON.parse(init.body);writes.push({ url, method: init.method, body });
    assert.ok(!JSON.stringify(body).includes('fixture-'));assert.ok(!JSON.stringify(body).includes('private@'));
    assert.ok(!url.includes('pi_paid_operations') && !url.includes('video_requests') && !url.includes('pi_supply_policies'));
    return new Response(null, { status: 204 });
  };
  return { writes, gets, request };
}

test('live observation persists private balances and low-balance notices without granting spending or sending notifications', async () => {
  const f = fixture(); const result = await observe(env, f.request, now);
  assert.equal(f.gets.length, 3); assert.equal(result.filter(r => r.verified).length, 3);
  const snapshots = f.writes.filter(w => w.url.endsWith('pi_capacity_snapshots')).map(w => w.body);
  assert.deepEqual(snapshots.map(s => s.status), ['YELLOW', 'UNKNOWN', 'YELLOW']);
  assert.ok(snapshots.every(s => s.checked_at === now() && s.reliability === 'provider_api'));
  const alerts = f.writes.filter(w => w.url.includes('pi_supply_alerts'));
  assert.equal(alerts.length, 2); assert.ok(alerts.every(a => a.body.payload.destination === 'internal_outbox'));
});

test('an unsuccessful provider read writes UNKNOWN and does not prevent the other suppliers being checked', async () => {
  const f = fixture(true); const result = await observe(env, f.request, now);
  assert.equal(result.find(r => r.provider === 'runway').verified, false);
  const snapshot = f.writes.find(w => w.url.endsWith('pi_capacity_snapshots') && w.body.provider === 'runway').body;
  assert.equal(snapshot.available, null); assert.equal(snapshot.reliability, 'none'); assert.equal(snapshot.status, 'UNKNOWN');
  assert.equal(result.find(r => r.provider === 'heygen').verified, true);
});

test('missing credentials never trigger a provider call and a database failure aborts before any provider read', async () => {
  const f = fixture(); await observe({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY }, f.request, now);
  assert.equal(f.gets.length, 0);
  const failed = fixture(false, true); await assert.rejects(observe(env, failed.request, now), /MONITOR_DATABASE/);assert.equal(failed.gets.length, 0);
  await assert.rejects(observe({ ...env, SUPABASE_URL: 'https://wrong.example' }, f.request, now), /NOT_CONFIGURED/);
});

/** Read-only ElevenLabs check for Dulce Part I (English). GET requests only: no synthesis, no
 * characters consumed, no account changes. Writes voice-check.json (plan, quota, reset date,
 * current narrator and free preview URLs of candidate narrators) for the run artifact.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const BRIAN = 'nPczCjzI2devNBz1zQrb';
const out = process.env.VOICE_OUT || '/tmp/voice-check';
const key = process.env.ELEVENLABS_API_KEY || '';
async function get<T>(p: string): Promise<T> {
  const r = await fetch('https://api.elevenlabs.io' + p, {headers: {'xi-api-key': key}});
  if (!r.ok) throw Error(`GET ${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T>;
}
type Voice = {voice_id: string; name: string; category?: string; description?: string | null; labels?: Record<string, string>; preview_url?: string | null};
type Shared = {voice_id: string; public_owner_id: string; name: string; accent?: string; gender?: string; age?: string; descriptive?: string; description?: string; use_case?: string; category?: string; preview_url?: string; cloned_by_count?: number; usage_character_count_1y?: number; credit_multiplier?: number | null; free_users_allowed?: boolean; notice_period?: number | null; language?: string; verified_languages?: unknown};

async function main() {
  await fs.mkdir(out, {recursive: true});
  const result: Record<string, unknown> = {checkedAt: new Date().toISOString()};
  const safe = async (name: string, fn: () => Promise<unknown>) => { try { result[name] = await fn(); } catch (e) { result[name] = {error: e instanceof Error ? e.message : String(e)}; } };

  await safe('subscription', async () => {
    const s = await get<Record<string, unknown>>('/v1/user/subscription');
    const pick = ['tier', 'status', 'character_count', 'character_limit', 'next_character_count_reset_unix', 'can_extend_character_limit', 'allowed_to_extend_character_limit', 'max_character_limit_extension', 'max_credit_limit_extension', 'billing_period', 'character_refresh_period', 'currency', 'can_use_instant_voice_cloning', 'voice_limit', 'voice_slots_used'];
    const o: Record<string, unknown> = {}; for (const k of pick) if (k in s) o[k] = s[k];
    if (typeof s.next_character_count_reset_unix === 'number') o.nextResetIso = new Date(s.next_character_count_reset_unix * 1000).toISOString();
    if (typeof s.character_limit === 'number' && typeof s.character_count === 'number') o.remaining = s.character_limit - s.character_count;
    return o;
  });
  await safe('currentVoice', async () => {
    const v = await get<Voice & {settings?: unknown; fine_tuning?: unknown}>(`/v1/voices/${BRIAN}`);
    return {voice_id: v.voice_id, name: v.name, category: v.category, description: v.description, labels: v.labels, preview_url: v.preview_url};
  });
  await safe('accountVoices', async () => {
    const r = await get<{voices: Voice[]}>('/v1/voices');
    return r.voices.map(v => ({voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels, preview_url: v.preview_url}));
  });
  await safe('models', async () => {
    const r = await get<{model_id: string; name?: string; character_cost_multiplier?: number; token_cost_factor?: number; can_do_text_to_speech?: boolean}[]>('/v1/models');
    return r.filter(m => m.can_do_text_to_speech !== false).map(m => ({model_id: m.model_id, name: m.name, token_cost_factor: m.token_cost_factor ?? m.character_cost_multiplier ?? null}));
  });
  // Library candidates: American male narrators suited to documentary / mystery narration.
  await safe('libraryCandidates', async () => {
    const seen = new Map<string, Shared>();
    for (const q of ['search=documentary', 'search=narrator&use_cases=narrative_story', 'search=deep%20narration', 'use_cases=informative_educational']) {
      const r = await get<{voices: Shared[]}>(`/v1/shared-voices?page_size=100&language=en&gender=male&accent=american&sort=cloned_by_count&${q}`);
      for (const v of r.voices) seen.set(v.voice_id, v);
    }
    return [...seen.values()].sort((a, b) => (b.cloned_by_count ?? 0) - (a.cloned_by_count ?? 0)).slice(0, 25)
      .map(v => ({voice_id: v.voice_id, public_owner_id: v.public_owner_id, name: v.name, accent: v.accent, age: v.age, descriptive: v.descriptive, use_case: v.use_case, category: v.category, description: (v.description || '').slice(0, 240), preview_url: v.preview_url, cloned_by_count: v.cloned_by_count, usage_character_count_1y: v.usage_character_count_1y, credit_multiplier: v.credit_multiplier ?? null, free_users_allowed: v.free_users_allowed, notice_period: v.notice_period ?? null}));
  });
  // Free listening copies: download each shortlisted voice's own ElevenLabs preview (no synthesis)
  // and sign a 7-day Storage URL, since preview links can expire or need the ElevenLabs site.
  await safe('listen', async () => {
    const lib = (result.libraryCandidates as {voice_id: string; preview_url?: string}[] | undefined) || [];
    const acct = (result.accountVoices as {voice_id: string; preview_url?: string}[] | undefined) || [];
    const shortlist: [string, string][] = [['brian', BRIAN], ['david-documentary', 'cCYjmrGZaI86GUJ7F2Nn'], ['bill', 'pqHfZKP75CvOlQylNhV4']];
    const {createServiceClient} = await import('../src/lib/supabase/service');
    const bucket = createServiceClient().storage.from('videos');
    const links: Record<string, unknown> = {};
    for (const [label, id] of shortlist) {
      const src = [...acct, ...lib].find(v => v.voice_id === id)?.preview_url;
      if (!src) { links[label] = {error: 'no preview_url'}; continue; }
      const r = await fetch(src); if (!r.ok) { links[label] = {error: 'preview HTTP ' + r.status}; continue; }
      const bytes = Buffer.from(await r.arrayBuffer());
      const p = `dulce-part1/voice-previews/${label}.mp3`;
      const up = await bucket.upload(p, bytes, {contentType: 'audio/mpeg', upsert: true});
      if (up.error) { links[label] = {error: up.error.message}; continue; }
      const s = await bucket.createSignedUrl(p, 7 * 24 * 3600);
      links[label] = {voice_id: id, bytes: bytes.length, url: s.data?.signedUrl ?? s.error?.message};
    }
    return links;
  });
  await fs.writeFile(path.join(out, 'voice-check.json'), JSON.stringify(result, null, 2));
  const sub = result.subscription as {tier?: string; remaining?: number; nextResetIso?: string} | undefined;
  console.log('@@VOICE_CHECK ' + JSON.stringify({tier: sub?.tier, remaining: sub?.remaining, nextReset: sub?.nextResetIso, candidates: (result.libraryCandidates as unknown[] | undefined)?.length}));
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'voice check failed'); process.exitCode = 1; });

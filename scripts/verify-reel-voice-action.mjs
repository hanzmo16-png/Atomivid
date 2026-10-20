// Executes the actual server action and catalogue route with synthetic auth/DB and read-only provider HTTP fixtures.
// No secrets, external network, provider generation or remote DB.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.ELEVENLABS_API_KEY = 'unit-test-not-a-key';
process.env.REEL_VOICE_SELECTION_ENABLED = 'true';
let user = { id: 'user-a' }, inserts = [], reads = 0, catalogueCalls = 0;
const chain = { eq: () => chain, select: () => chain, in: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
globalThis.__voiceTestAuth = { auth: { getUser: async () => ({ data: { user } }) } };
globalThis.__voiceTestService = { from: table => {
  assert.equal(table, 'video_requests'); reads++;
  return { ...chain, insert: async row => { inserts.push(row); return { error: null }; } };
} };
const stubs = { 'next/navigation': `export function redirect(url) { const e = new Error('redirect'); e.url = url; throw e; }`,
  '@/lib/supabase/server': `export async function createClient() { return globalThis.__voiceTestAuth; }`,
  '@/lib/supabase/service': `export function createServiceClient() { return globalThis.__voiceTestService; }` };
const plugin = { name: 'synthetic-auth-db', setup(builder) {
  builder.onResolve({ filter: /^(next\/navigation|@\/lib\/supabase\/(server|service))$/ }, args => ({ path: args.path, namespace: 'stub' }));
  builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
} };
const directory = await mkdtemp(path.resolve('node_modules/.reel-voice-action-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://api.elevenlabs.io/v1/voices');
  assert.ok(!init?.method || init.method === 'GET'); catalogueCalls++;
  return Response.json({ voices: ['voiceEsp01','voiceEsp02','voiceEng01'].map(voice_id => ({ voice_id, name: voice_id,
    category: 'premade', labels: { language: voice_id.includes('Esp') ? 'es' : 'en' }, preview_url: `https://example.test/${voice_id}.mp3` })) });
};
const compile = async (entry, name) => {
  const file = path.join(directory, `${name}.cjs`);
  await build({ entryPoints: [entry], outfile: file, bundle: true, format: 'cjs', platform: 'node', packages: 'external', plugins: [plugin], logLevel: 'silent' });
  return require(file);
};
try {
  const { createVideoRequest } = await compile('src/app/dashboard/new/actions.ts', 'action');
  const { GET } = await compile('src/app/api/reel/voices/route.ts', 'route');
  const form = voice => { const f = new FormData(); for (const [k,v] of Object.entries({ topic: 'Hábitos', style: 'Motivacional', duration_seconds: '30', language: 'es', mode: 'visual', script_choice: 'generated' })) f.set(k,v); if (voice != null) f.set('reel_voice_id',voice); return f; };
  const submit = async voice => { try { await createVideoRequest(form(voice)); assert.fail('expected redirect'); } catch(e) { assert.ok(e.url, e.stack); return e.url; } };
  assert.match(await submit('voiceEsp01'), /created=1/);
  assert.equal(inserts[0].reel_voice_id, 'voiceEsp01'); assert.equal(catalogueCalls, 1);
  const selectedId = inserts[0].id;
  assert.match(await submit('voiceEsp01'), /created=1/); assert.equal(inserts[1].id, selectedId);
  assert.match(await submit(), /created=1/); assert.equal('reel_voice_id' in inserts[2], false);
  assert.notEqual(inserts[2].id, selectedId); assert.equal(catalogueCalls, 1, 'default needs no catalogue');
  for (const voice of ['unknown01', 'invalid/id']) assert.match(await submit(voice), /error=/);
  assert.equal(inserts.length, 3, 'invalid choices never insert');
  process.env.REEL_VOICE_SELECTION_ENABLED = 'false';
  assert.match(await submit('voiceEsp02'), /error=/); assert.equal(inserts.length, 3);
  const disabled = await GET(new Request('http://localhost/api/reel/voices?language=es'));
  assert.equal((await disabled.json()).enabled, false);
  assert.match(await submit(), /created=1/); assert.equal(inserts.length, 4);
  process.env.REEL_VOICE_SELECTION_ENABLED = 'true';
  const response = await GET(new Request('http://localhost/api/reel/voices?language=es'));
  assert.equal(response.status, 200); assert.equal((await response.json()).voices.length, 3);
  assert.equal((await GET(new Request('http://localhost/api/reel/voices?language=xx'))).status, 400);
  user = null;
  const readsBefore = reads, callsBefore = catalogueCalls;
  assert.equal(await submit('voiceEsp01'), '/login');
  assert.equal((await GET(new Request('http://localhost/api/reel/voices?language=es'))).status, 401);
  assert.equal(reads, readsBefore); assert.equal(catalogueCalls, callsBefore);
  console.log('PASS: actual createVideoRequest and GET route — validated voice persisted, stable resend id, unchanged default, unknown/malformed/disabled choice rejected before insert, authenticated access and language validation. Synthetic auth/DB/provider GET; no paid calls.');
} finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }

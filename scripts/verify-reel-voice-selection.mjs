// Development-only: PostgreSQL WASM, synthetic rows, never a remote database.
// npm install --prefix /tmp/voice-qa --save-exact @electric-sql/pglite
// PGLITE_MODULE=/tmp/voice-qa/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-reel-voice-selection.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.video_requests(id text primary key, mode text, script_json jsonb, status text);
    grant select on public.video_requests to authenticated;
    grant all on public.video_requests to service_role;
    insert into public.video_requests values ('legacy','visual','{}','pending');`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261020200444_reel_voice_selection.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query(`select reel_voice_id from video_requests where id='legacy'`)).rows[0].reel_voice_id, null);
  await db.exec(`set role service_role; insert into video_requests values ('chosen','visual','{}','pending','voiceEsp01');
    update video_requests set script_json='{"title":"Edited"}',status='script_ready' where id='chosen';`);
  assert.equal((await db.query(`select reel_voice_id from video_requests where id='chosen'`)).rows[0].reel_voice_id, 'voiceEsp01');
  await assert.rejects(db.exec(`update video_requests set reel_voice_id='voiceEsp02' where id='chosen'`), /immutable/);
  await assert.rejects(db.exec(`update video_requests set reel_voice_id=null where id='chosen'`), /immutable/);
  await assert.rejects(db.exec(`update video_requests set reel_voice_id='voiceEsp01' where id='legacy'`), /immutable/);
  for (const [id,mode,voice] of [['bad','visual','bad/id'],['wrong','avatar','voiceEsp01'],['nullmode',null,'voiceEsp01']]) {
    await assert.rejects(db.query(`insert into video_requests (id,mode,reel_voice_id) values($1,$2,$3)`,[id,mode,voice]), /check constraint/);
  }
  await db.exec(`insert into video_requests values ('avatar','avatar','{}','pending',null); reset role; set role authenticated;`);
  await assert.rejects(db.exec(`update video_requests set reel_voice_id='voiceEsp02' where id='chosen'`), /permission denied/);
  await assert.rejects(db.exec(`insert into video_requests(id,mode,reel_voice_id) values('client','visual','voiceEsp01')`), /permission denied/);
  await assert.rejects(db.exec(`select public.reel_voice_immutable()`), /permission denied/);
  console.log('PASS: 12 SQL checks — legacy NULL, selected voice retained after script edit, immutable voice, valid mode/id, server-owned writes and trigger permissions. Isolated PostgreSQL WASM; production not tested.');
} finally { await db.close(); }

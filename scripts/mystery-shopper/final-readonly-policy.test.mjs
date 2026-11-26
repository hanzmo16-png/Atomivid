import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequest, ownedCompleted, ORIGIN } from './final-readonly-policy.mjs';
test('only login POST before auth; GET only after auth, with explicit origin/media allowlist', () => {
  const check = (url, method = 'GET', auth = true) => allowedRequest(url, method, auth, 'https://qa.supabase.co');
  assert.equal(check(`${ORIGIN}/login`, 'POST', false), true);
  for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) assert.equal(check(`${ORIGIN}/login`, method), false);
  for (const url of [`${ORIGIN}/api/video/generate`, `${ORIGIN}/api/render`, 'https://api.openai.com/v1', 'https://atomivid.vercel.app.evil.test/dashboard', 'http://atomivid.vercel.app/dashboard', 'https://qa.supabase.co/rest/v1/video_requests']) assert.equal(check(url), false);
  assert.equal(check(`${ORIGIN}/dashboard/videos/abc`), true);
  assert.equal(check('https://qa.supabase.co/storage/v1/object/sign/videos/a?token=private'), true);
});
test('ownership and completed state are mandatory for every exact requested row', () => {
  const rows = [{id:'a',user_id:'qa',status:'completed'}];
  assert.equal(ownedCompleted(rows,'qa',['a']), true);
  assert.equal(ownedCompleted(rows,'other',['a']), false);
  assert.equal(ownedCompleted(rows,'qa',['b']), false);
  assert.equal(ownedCompleted([{...rows[0],status:'rendering'}],'qa',['a']), false);
});

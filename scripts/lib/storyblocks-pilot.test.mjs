import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readPilotConfig, signedSearchUrl, parseSearch, searchPilot, pilotHtml, PILOT_SEARCHES } from './storyblocks-pilot.mjs';

const config = { apiKey: 'test-public', apiSecret: 'test-secret', userId: 'pilot-owner', projectId: 'pilot-project' };
const search = PILOT_SEARCHES[0];
const item = { id: 11851, title: 'Roman soldier', is_editorial: false, orientation: 'horizontal', duration: 21, preview_urls: { _720p: 'https://example.cloudfront.net/preview.mp4' } };

test('pilot refuses missing keys and production mode before requests', () => {
  assert.throws(() => readPilotConfig({}), /must be test/);
  assert.throws(() => readPilotConfig({ STORYBLOCKS_KEY_MODE: 'production' }), /must be test/);
  assert.throws(() => readPilotConfig({ STORYBLOCKS_KEY_MODE: 'test' }), /Missing STORYBLOCKS_API_KEY/);
});

test('official HMAC recipe, bounded search, account attribution and style constraints', () => {
  const url = signedSearchUrl(config, search, 1000000);
  assert.equal(url.origin, 'https://api.storyblocks.com');
  assert.equal(url.pathname, '/api/v2/videos/search');
  assert.equal(url.searchParams.get('EXPIRES'), '1300');
  assert.equal(url.searchParams.get('HMAC'), createHmac('sha256', 'test-secret1300').update('/api/v2/videos/search').digest('hex'));
  assert.equal(url.searchParams.get('user_id'), 'pilot-owner');
  assert.equal(url.searchParams.get('project_id'), 'pilot-project');
  assert.equal(url.searchParams.get('required_keywords'), 'roman');
  assert.equal(url.searchParams.get('is_editorial'), 'false');
  assert.equal(url.searchParams.get('results_per_page'), '5');
  assert.throws(() => signedSearchUrl(config, { ...search, media: '../download' }), /Unsupported/);
});

test('editorial, unverified rights, duplicate and unsafe previews are excluded', () => {
  const result = parseSearch({ results: [item, item, { ...item, id: 2, is_editorial: true }, { ...item, id: 3, is_editorial: undefined }, { ...item, id: 4, preview_urls: { _720p: 'https://attacker.test/clip' } }] }, search);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.excluded, 4);
  assert.equal(result.candidates[0].license, 'PREVIEW_ONLY_NOT_LICENSED');
  assert.equal(result.candidates[0].orientation, 'horizontal');
  assert.equal(result.candidates[0].visualReview, 'PENDING');
  assert.throws(() => parseSearch({ error: 'bad' }, search), /schema/);
});

test('HTTP failures and signed network errors do not leak secrets or retry', async () => {
  let calls = 0;
  await assert.rejects(searchPilot(config, search, async url => { calls++; throw new Error(String(url)); }), error => {
    assert.doesNotMatch(error.message, /test-public|test-secret|HMAC|APIKEY/); return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(searchPilot(config, search, async () => new Response('secret', { status: 401 })), /HTTP 401/);
  await assert.rejects(searchPilot(config, search, async () => new Response('not-json')), /invalid JSON/);
});

test('all pilot calls are search-only, redirect blocked and time bounded', async () => {
  for (const definition of PILOT_SEARCHES) {
    await searchPilot(config, definition, async (url, options) => {
      assert.match(url.pathname, /^\/api\/v2\/(videos|images|audio)\/search$/);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ results: [] });
    });
  }
});

test('HTML renders escaped internal previews and no unsafe URLs', () => {
  const result = parseSearch({ results: [{ ...item, title: '<script>alert(1)</script>' }] }, search);
  const html = pilotHtml({ searches: [result] });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /sin licencia de producción/);
  result.candidates[0].previewUrl = 'javascript:alert(1)';
  assert.doesNotMatch(pilotHtml({ searches: [result] }), /javascript:/);
});

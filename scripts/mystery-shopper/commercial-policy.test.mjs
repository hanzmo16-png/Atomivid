import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGIN, allowedCommercialRequest, commercialVisibility } from './commercial-policy.mjs';

test('commercial browser permits login only, never signup, checkout, portal, generation or provider calls', () => {
  const check = (path, method = 'GET', phase = 'authenticated') => allowedCommercialRequest(path, method, phase, 'https://qa.supabase.co');
  assert.equal(check(`${ORIGIN}/login`, 'POST', 'login'), true);
  for (const phase of ['public', 'authenticated']) assert.equal(check(`${ORIGIN}/login`, 'POST', phase), false);
  for (const path of ['/register', '/dashboard/billing', '/api/billing/checkout', '/api/billing/portal', '/api/video/generate']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(check(`${ORIGIN}${path}`, method, 'login'), false);
  }
  for (const path of ['/api/billing/checkout', '/api/billing/portal', '/api/video/generate']) assert.equal(check(`${ORIGIN}${path}`), false);
  assert.equal(check(`${ORIGIN}/register`), true);
  assert.equal(check(`${ORIGIN}/dashboard/billing`), true);
  assert.equal(check('https://qa.supabase.co/storage/v1/object/sign/videos/existing?token=private'), true);
  for (const url of ['https://qa.supabase.co/rest/v1/subscriptions', 'https://api.stripe.com/v1/customers', 'https://api.openai.com/v1', 'https://atomivid.vercel.app.evil.test/dashboard', 'http://atomivid.vercel.app/dashboard']) assert.equal(check(url), false);
});

test('visible commercial classifications contain booleans only and do not invent credit usage from plan allowances', () => {
  assert.deepEqual(commercialVisibility('Facturación Plan actual Atomicvid Pro Activa 30 Reels al mes'), {
    currentPlanVisible: true, subscriptionStatusVisible: true, planOptionsVisible: false,
    paymentUnavailableVisible: false, creditUsageVisible: false,
  });
  assert.equal(commercialVisibility('Créditos restantes: 4').creditUsageVisible, true);
  assert.equal(commercialVisibility('Starter Pro Business Pagos aún no habilitados').paymentUnavailableVisible, true);
  assert.ok(Object.values(commercialVisibility('private arbitrary account text')).every(value => typeof value === 'boolean'));
});

test('rendered uppercase labels identify the same current plan and plan options', () => {
  assert.equal(commercialVisibility('PLAN ACTUAL Atomicvid Pro Activa').currentPlanVisible, true);
  assert.equal(commercialVisibility('STARTER PRO BUSINESS').planOptionsVisible, true);
});

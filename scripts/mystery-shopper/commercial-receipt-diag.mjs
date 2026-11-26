import { createClient } from '@supabase/supabase-js';

const CHECKPOINTS = new Set(['public-signup', 'existing-qa-login', 'dashboard-commercial-navigation', 'billing-visible-state', 'existing-library-download', 'complete']);
const CHECKS = new Set(['signup-form-public-get', 'signup-browser-required-email-password-validation-no-submit', 'signup-terms-privacy-links', 'single-cosmos2-background-preserved', 'mobile-dock-visible', 'library-link-resolves-existing-projects-anchor', 'library-navigation-is-current-dashboard-anchor', 'existing-library-detail-link-present', 'existing-library-detail-is-same-origin-uuid-route', 'mobile-no-horizontal-overflow', 'billing-renders-plan-state-or-available-plans', 'billing-mobile-dock-stays-available', 'billing-no-horizontal-overflow', 'existing-detail-navigation', 'existing-download-link-safe-and-visible', 'existing-download-get-returns-bytes', 'no-unhandled-browser-errors']);

async function main() {
  // Exact failed receipt authorized for a bounded diagnostic; no arbitrary object path input.
  const prefix = 'mystery-shopper/private-commercial-readonly/47ebed28-9b64-4bf4-8db0-e73e2e36bbfe';
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = await sb.storage.getBucket('videos');
  if (bucket.error || bucket.data.public !== false) throw Error('private storage required');
  const downloaded = await sb.storage.from('videos').download(`${prefix}/receipt.json`);
  if (downloaded.error || !downloaded.data || downloaded.data.size > 65536) throw Error('receipt unavailable');
  const receipt = JSON.parse(await downloaded.data.text());
  const safe = {
    passed: receipt.passed === true,
    checkpoint: CHECKPOINTS.has(receipt.checkpoint) ? receipt.checkpoint : 'unknown',
    screenCount: Array.isArray(receipt.screens) ? receipt.screens.length : 0,
    assertions: (Array.isArray(receipt.checks) ? receipt.checks : []).filter(check => CHECKS.has(check.name)).map(check => ({ name: check.name, passed: check.passed === true, width: [390, 412].includes(check.width) ? check.width : null })),
  };
  // Only fixed enums, booleans and counts are retained in private object metadata.
  const retained = await sb.storage.from('videos').upload(`${prefix}/diagnostic.json`, JSON.stringify({ version: 1, kind: 'bounded-commercial-receipt-diagnostic' }), { contentType: 'application/json', upsert: false, metadata: safe });
  if (retained.error) throw Error('private diagnostic unavailable');
  console.log('PASS: bounded receipt diagnostic retained in private Storage metadata.');
}
main().catch(() => { console.error('FAIL: bounded private receipt diagnostic unavailable.'); process.exitCode = 1; });

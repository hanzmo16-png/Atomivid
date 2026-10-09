import { readFileSync } from 'node:fs';
import { createPublicKey, privateDecrypt, createDecipheriv, constants } from 'node:crypto';

// One-off owner-authorized editor account provisioning. No provider calls.
// Account details enter only in a sealed envelope; no credentials reach logs.
const ROOT = 'ops/editor-account';
const BRANCH = 'codex/editor-account-provision';
const url = process.env.SUPABASE_URL?.trim();
const admin = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const headers = { apikey: admin, Authorization: `Bearer ${admin}` };
const mode = readFileSync(`${ROOT}/mode`, 'utf8').trim();
async function api(path, init = {}) {
  const r = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!r.ok) throw Error(`SUPABASE_REQUEST_FAILED_${r.status}`);
  return r;
}
async function publish(path, content) {
  const target = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/${path}`;
  const gh = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' };
  const previous = await fetch(`${target}?ref=${BRANCH}`, { headers: gh });
  if (previous.status !== 404 && !previous.ok) throw Error('GITHUB_READ_FAILED');
  const body = { branch: BRANCH, message: 'Editor account public provisioning evidence', content: Buffer.from(content).toString('base64') };
  if (previous.ok) body.sha = (await previous.json()).sha;
  const r = await fetch(target, { method: 'PUT', headers: { ...gh, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Error('GITHUB_WRITE_FAILED');
}
async function main() {
  if (!url || !admin || new URL(url).hostname !== 'msyxczcdjhbednmfzxqq.supabase.co') throw Error('PROJECT_MISMATCH');
  const pem = await (await api('/storage/v1/object/authenticated/videos/ops/podcast-episode/runner-key.pem')).text();
  if (mode === 'public-key') {
    await publish(`${ROOT}/runner-public.pem`, createPublicKey(pem).export({ type: 'spki', format: 'pem' }));
    console.log('RUNNER_PUBLIC_KEY_READY');
    return;
  }
  if (mode !== 'provision') throw Error('UNKNOWN_MODE');
  const parts = readFileSync(`${ROOT}/account.sealed`, 'utf8').trim().split('.').map(x => Buffer.from(x, 'base64'));
  if (parts.length !== 4) throw Error('INVALID_ENVELOPE');
  const [ek, iv, tag, ct] = parts;
  const key = privateDecrypt({ key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ek);
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  const cfg = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString());
  if (cfg.purpose !== 'dedicated-podcast-editor-20261009' || typeof cfg.email !== 'string' || !cfg.email.includes('@') || typeof cfg.password !== 'string' || cfg.password.length < 32) throw Error('INVALID_ACCOUNT_REQUEST');
  // Never change an existing account or password; retries confirm only our own exact account.
  let existing;
  for (let page = 1; page <= 100; page++) {
    const data = await (await api(`/auth/v1/admin/users?page=${page}&per_page=100`)).json();
    existing = (data.users ?? []).find(u => u.email?.toLowerCase() === cfg.email.toLowerCase());
    if (existing || (data.users ?? []).length < 100) break;
    if (page === 100) throw Error('ACCOUNT_SEARCH_INCOMPLETE');
  }
  let user;
  if (existing) {
    if (existing.app_metadata?.editor_provision_request !== cfg.requestId) throw Error('ACCOUNT_EXISTS_UNCHANGED');
    user = existing;
  } else {
    user = await (await api('/auth/v1/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: cfg.email.toLowerCase(), password: cfg.password, email_confirm: true, app_metadata: { editor_provision_request: cfg.requestId, purpose: cfg.purpose } }) })).json();
  }
  if (!user.id || user.email?.toLowerCase() !== cfg.email.toLowerCase() || !user.email_confirmed_at) throw Error('ACCOUNT_CONFIRMATION_FAILED');
  await publish(`${ROOT}/result.json`, JSON.stringify({ created_or_confirmed: true, email_confirmed: true, password_changed_on_existing_account: false, owner_privileges_granted: false, assignments_created: false, no_paid_calls: true }, null, 2));
  console.log('DEDICATED_EDITOR_ACCOUNT_READY');
}
main().catch(e => { console.error(/^([A-Z_]+)(_[0-9]{3})?$/.test(e.message) ? e.message : 'EDITOR_ACCOUNT_OPERATION_FAILED'); process.exitCode = 1; });

// One-time recovery requested by the owner via the Grok handoff, 2026-10-09.
// No editor login, media writes, permission changes, or plaintext credential logs.
import { randomBytes, publicEncrypt, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const id = '394ded12-59a2-412a-af30-ea88f47163af';
const email = 'kingduro777@gmail.com';
const expectedUpdate = Date.parse('2026-10-09T21:43:31.223911Z');
async function main() {
  if (process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('rerun_refused');
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url !== 'https://msyxczcdjhbednmfzxqq.supabase.co' || !key) throw new Error('configuration_mismatch');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const before = await client.auth.admin.getUserById(id);
  const user = before.data?.user;
  if (before.error || user?.id !== id || user.email?.toLowerCase() !== email || !user.email_confirmed_at) throw new Error('identity_check_failed');
  if (Date.parse(user.updated_at) !== expectedUpdate) throw new Error('account_changed_reset_refused');
  const password = 'Ed9!' + randomBytes(24).toString('base64url');
  const ciphertext = publicEncrypt({
    key: readFileSync('ops/editor-recovery-public.pem'),
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, Buffer.from(JSON.stringify({ id, email, password }))).toString('base64');
  // Emit encrypted recovery data BEFORE the mutation, so a response failure
  // cannot lose the replacement credential. Only the local operator can decrypt.
  console.log('EDITOR_RECOVERY_SEALED=' + ciphertext);
  const result = await client.auth.admin.updateUserById(id, { password });
  if (result.error || result.data?.user?.id !== id) throw new Error('reset_failed_check_state_before_retry');
  const after = await client.auth.admin.getUserById(id);
  const verified = after.data?.user;
  if (after.error || verified?.id !== id || verified.email?.toLowerCase() !== email || Date.parse(verified.updated_at) <= expectedUpdate) throw new Error('readback_failed');
  console.log(JSON.stringify({ password_reset: true, same_user: true, same_email: true, editor_login_attempted: false, updated_at: verified.updated_at }));
}
main().catch(error => { console.error('Recovery stopped: ' + (/^[a-z_]+$/.test(error.message) ? error.message : 'unexpected_error')); process.exitCode = 1; });

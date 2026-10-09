/**
 * Does the APP consume a real delivery? Runs the app's own modules (contract, checkDelivery, ownerEditorStorage
 * from PR #86, extracted at a pinned commit) against the real private bucket with the ENROLLED OWNER's session —
 * the same permissions the app's pages use. Full sha256 verification of every declared object; signs one
 * playback URL and checks it serves the declared bytes. No writes, no provider call. The temporary owner
 * session is signed out at the end. Logs: states, counts, booleans only.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { connectResolved } from "../lib/supabase-db";
// Copied from the PR head by the workflow before running.
import { checkDelivery } from "../../app-under-test/src/lib/podcast/editor/verify";
import { ownerEditorStorage } from "../../app-under-test/src/lib/podcast/editor/storage";
import { versionFolder } from "../../app-under-test/src/lib/podcast/editor/contract";

const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  const ep = process.env.E2E_EPISODE?.trim() ?? "", version = Number(process.env.E2E_VERSION?.trim());
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised" }); process.exitCode = 1; return; }
  const { client } = await connectResolved();
  const owners = (await client.query("select user_id::text as id from podcast_editor.propietarios")).rows as { id: string }[];
  const marker = (await client.query("select 1 from storage.objects where bucket_id='podcast-editor' and name=$1", [`${versionFolder(ep, version)}/salida/COMPLETO.json`])).rowCount;
  await client.end();
  log("PRECONDITIONS", { owners: owners.length, delivery: `${ep}/v${version}`, markerPresent: Boolean(marker) });
  if (owners.length !== 1 || !marker) { log("BLOCKED", { reason: owners.length !== 1 ? "expected one owner" : "no COMPLETO.json yet" }); process.exitCode = 1; return; }

  const { data: u } = await admin.auth.admin.getUserById(owners[0].id);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: u!.user!.email! });
  const otp = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s } = await otp.auth.verifyOtp({ type: "magiclink", token_hash: link!.properties!.hashed_token });
  const token = s.session?.access_token;
  if (!token) { log("BLOCKED", { reason: "owner session not issued" }); process.exitCode = 1; return; }
  try {
    // A client that acts as the owner (anon-equivalent apikey is not available to the runner; the Authorization
    // header carries the owner's JWT, so Storage evaluates the owner's RLS, not the service role).
    const asOwner = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const storage = ownerEditorStorage(asOwner);
    const versions = await storage.listVersions();
    log("OWNER_LISTING", { versions: versions.length, includesTarget: versions.some((v) => v.episodeId === ep && v.version === version) });
    const quick = await checkDelivery(storage, ep, version, { hashes: false });
    log("APP_STATE_BEFORE_VERIFY", { state: quick.state, reason: quick.state === "entrega_invalida" ? quick.reason : null, objects: "objetos" in quick ? quick.objetos.length : null });
    const full = await checkDelivery(storage, ep, version, { hashes: true, deadline: Date.now() + 270_000 });
    log("APP_STATE_AFTER_VERIFY", { state: full.state, reason: full.state === "entrega_invalida" ? full.reason : null, objects: "objetos" in full ? full.objetos.length : null, primary: full.state === "terminado" ? full.primary?.key ?? null : null });
    if (full.state === "terminado" && full.primary) {
      const r = await fetch(await storage.signedUrl(`${versionFolder(ep, version)}/${full.primary.key}`));
      const buf = Buffer.from(await r.arrayBuffer());
      log("PRIMARY_SIGNED_FETCH", { ok: r.ok, bytesMatch: buf.length === full.primary.size, sha256Match: createHash("sha256").update(buf).digest("hex") === full.primary.sha256 });
    }
    if (full.state !== "terminado") process.exitCode = 1;
  } finally {
    const { error } = await admin.auth.admin.signOut(token, "local");
    log("OWNER_SESSION_LOGOUT", { ok: !error });
  }
}
main().catch(() => { console.error("FAILED: consume check; see the states above"); process.exitCode = 1; });

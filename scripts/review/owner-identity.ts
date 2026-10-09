/**
 * Read-only: which Auth account is INTERNAL_PRODUCTION_OWNER_USER_ID? Public log = booleans and counts only;
 * the account's id, email and dates are encrypted to the operator session key (ops/session-public-key.txt).
 * Enrols nothing (podcast_editor.propietarios is untouched).
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
mkdirSync("sealed-out", { recursive: true });
function seal(name: string, bytes: Buffer) {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const ek = publicEncrypt({ key: readFileSync("ops/session-public-key.txt", "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
  log("SEALED_FILE", { name, bytes: bytes.length });
}

async function main() {
  const id = process.env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim() ?? "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  log("OWNER_ID_CONFIG", { configured: Boolean(id), uuidShape: uuid });
  if (!uuid) return;
  const { data, error } = await db.auth.admin.getUserById(id);
  const u = data?.user;
  log("OWNER_ACCOUNT", { exists: Boolean(u), lookupError: error?.code ?? null, emailConfirmed: Boolean(u?.email_confirmed_at) });
  if (!u) return;
  const { count: requests } = await db.from("video_requests").select("*", { count: "exact", head: true }).eq("user_id", id);
  const { data: doc } = await db.from("video_requests").select("user_id").eq("id", "516b72ae-db4c-48a7-bea1-b08913c70a90").maybeSingle();
  const { count: podcasts } = await db.from("podcast_episodes").select("*", { count: "exact", head: true }).eq("user_id", id);
  log("OWNER_LINKS", { videoRequests: requests, ownsTestDocumentary516b72ae: doc?.user_id === id, podcastEpisodes: podcasts });
  seal("owner-identity.json", Buffer.from(JSON.stringify({ id: u.id, email: u.email, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at, emailConfirmedAt: u.email_confirmed_at })));
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });

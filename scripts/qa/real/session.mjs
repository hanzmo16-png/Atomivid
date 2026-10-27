// Session for the owner account (INTERNAL_PRODUCTION_OWNER_USER_ID) in the PRODUCTION app, authorized by the owner for the
// closure validations. No email is sent: admin.generateLink only returns a one-time token, verified here (verifyOtp).
// The cookies are produced by @supabase/ssr (same library as the app) and written as a Playwright storageState file.
// Nothing sensitive is printed: no email, no token, no id.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, owner = process.env.OWNER_ID, out = process.argv[2];
const APP = new URL(process.env.APP_URL || "https://atomivid.vercel.app");
if (!url || !key || !owner || !out) { console.log("FAIL session: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OWNER_ID / output path"); process.exit(1); }
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: u, error: ue } = await admin.auth.admin.getUserById(owner);
if (ue || !u?.user?.email) { console.log("FAIL session: owner account not found"); process.exit(1); }
if (!u.user.email_confirmed_at) { console.log("FAIL session: owner email not confirmed (the studio pilot requires it)"); process.exit(1); }
const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
if (le || !link?.properties?.hashed_token) { console.log("FAIL session: could not create the one-time token"); process.exit(1); }
const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: v, error: ve } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
if (ve || !v?.session || v.user?.id !== owner) { console.log("FAIL session: token verification failed"); process.exit(1); }
const jar = [];
const ssr = createServerClient(url, key, { cookies: { getAll: () => [], setAll: (cs) => { for (const c of cs) jar.push(c); } } });
await ssr.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = jar.filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, domain: APP.hostname, path: "/", httpOnly: false, secure: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }));
if (!cookies.length) { console.log("FAIL session: no auth cookie produced"); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
console.log(`PASS session: owner session ready (${cookies.length} cookie chunk(s), email confirmed)`);

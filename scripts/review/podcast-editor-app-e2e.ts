/**
 * App-side validation of a REAL editor delivery in the private podcast-editor bucket (no write, no provider
 * call). Runs against E2E_APP (preview first, production later):
 *   owner (the account enrolled in podcast_editor.propietarios — read from the database, never guessed):
 *     list shows the version as delivered → version page → "Verificar integridad y abrir" → "Terminado",
 *     the player plays, every download link returns exactly the declared bytes with the declared sha256;
 *   ordinary account: page 404, verify API 404; anonymous: verify API 401.
 * The owner session comes from a one-time admin sign-in link exchanged inside the runner (no password); it
 * only runs when OWNER_SESSION_AUTHORIZED=yes. Logs carry states, counts and booleans — never URLs or tokens.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { connectResolved } from "../lib/supabase-db";

const APP = (process.env.E2E_APP ?? "").replace(/\/$/, "");
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? "";
const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const results: { check: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Supabase SSR auth cookies for a user, produced by the same library the app uses to read them. */
async function sessionCookies(userId: string) {
  const { data: u } = await admin.auth.admin.getUserById(userId);
  if (!u?.user?.email) throw new Error("account without email");
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
  if (error || !link?.properties?.hashed_token) throw new Error("sign-in link not issued");
  const otp = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e2 } = await otp.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (e2 || !s.session) throw new Error("sign-in link not accepted");
  const jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(URL_, KEY, { cookies: { getAll: () => jar, setAll: (list) => { for (const c of list) { const i = jar.findIndex((x) => x.name === c.name); if (i >= 0) jar.splice(i, 1); if (c.value) jar.push({ name: c.name, value: c.value }); } } } });
  await ssr.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
  return jar;
}

async function main() {
  if (!APP) throw new Error("E2E_APP not set");
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised for this run" }); return; }
  const { client } = await connectResolved();
  const owners = (await client.query("select user_id::text as id from podcast_editor.propietarios order by created_at")).rows as { id: string }[];
  const delivered = (await client.query(`select name from storage.objects where bucket_id = 'podcast-editor' and name ~ '^episodios/[^/]+/v[0-9]+/salida/COMPLETO\\.json$' order by created_at desc limit 1`)).rows[0]?.name as string | undefined;
  const other = (await client.query(`select id::text from auth.users where email_confirmed_at is not null and id not in (select user_id from podcast_editor.propietarios) order by created_at desc limit 1`)).rows[0]?.id as string | undefined;
  await client.end();
  log("PRECONDITIONS", { owners: owners.length, deliveryPresent: Boolean(delivered), ordinaryAccount: Boolean(other) });
  if (owners.length !== 1 || !delivered) { log("BLOCKED", { reason: owners.length !== 1 ? "expected exactly one enrolled owner" : "no COMPLETO.json in the bucket" }); return; }
  const [, ep, vSeg] = delivered.split("/");
  const versionPath = `/dashboard/podcast/editor/${ep}/${vSeg}`;

  const pwPkg = ["play", "wright"].join("");
  const { chromium } = (await import(pwPkg)) as { chromium: { launch: (o?: object) => Promise<any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const host = new URL(APP).hostname;
  try {
    const open = async (cookies: { name: string; value: string }[]) => {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await ctx.newPage();
      if (BYPASS) await page.goto(`${APP}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: "domcontentloaded" });
      await ctx.addCookies(cookies.map((c) => ({ ...c, domain: host, path: "/", secure: true, sameSite: "Lax" as const })));
      return { ctx, page };
    };
    const text = async (page: any) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " "); // eslint-disable-line @typescript-eslint/no-explicit-any

    // Owner.
    const { ctx, page } = await open(await sessionCookies(owners[0].id));
    const listRes = await page.goto(`${APP}/dashboard/podcast/editor`, { waitUntil: "networkidle" });
    const list = await text(page);
    check("owner: delivery list page opens", listRes?.status() === 200, { status: listRes?.status() });
    check("owner: the real delivery is listed as delivered (pending verification)", list.includes(`${ep} · ${vSeg}`) && /falta verificar integridad/.test(list));
    await page.goto(`${APP}${versionPath}`, { waitUntil: "networkidle" });
    const verifyResponse = page.waitForResponse((r: any) => r.url().includes("/verify") && r.request().method() === "POST", { timeout: 300_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.getByRole("button", { name: /Verificar integridad/ }).click();
    const vr = await verifyResponse;
    const body = await vr.json() as { status: { state: string; primary?: string; reason?: string }; files?: { key: string; size: number; download: string; play: string }[] };
    check("owner: server verification returns terminado", body.status.state === "terminado", { state: body.status.state, reason: body.status.reason ?? null });
    if (body.status.state === "terminado") {
      await page.waitForSelector("video, audio", { timeout: 30000 });
      const playback = await page.evaluate(async () => {
        const m = document.querySelector("video, audio") as HTMLMediaElement | null;
        if (!m) return { found: false, played: false };
        m.muted = true; await m.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 4000));
        return { found: true, played: m.currentTime > 1, tag: m.tagName.toLowerCase() };
      });
      check("owner: the primary media plays in the browser (video preferred)", playback.found && playback.played && body.status.primary?.endsWith(".mp4") === (playback.tag === "video"), playback);
      // Every download returns exactly the declared bytes; hashes compared with COMPLETO.json via a second, independent read.
      const { data: markerBlob } = await createClient(URL_, KEY, { auth: { persistSession: false } }).storage.from("podcast-editor").download(delivered);
      const marker = JSON.parse(await markerBlob!.text()) as { objetos: { key: string; size: number; sha256: string }[] };
      const declared = new Map(marker.objetos.map((o) => [o.key.replace(/^episodios\/[^/]+\/v[0-9]+\//, ""), o]));
      let ok = 0;
      for (const f of body.files ?? []) {
        const r = await fetch(f.download);
        const buf = Buffer.from(await r.arrayBuffer());
        const d = declared.get(f.key);
        if (r.ok && d && buf.length === d.size && createHash("sha256").update(buf).digest("hex") === d.sha256 && /attachment/i.test(r.headers.get("content-disposition") ?? "")) ok++;
      }
      check("owner: every download link returns the declared bytes and sha256 as an attachment", ok === (body.files ?? []).length && ok === declared.size, { files: body.files?.length ?? 0, ok, declared: declared.size });
      const signedTtl = (body.files ?? []).every((f) => /[?&]token=/.test(f.play));
      check("owner: links are signed (token-bearing, short-lived)", signedTtl);
    }
    await ctx.close();

    // Ordinary account and anonymous.
    if (other) {
      const o = await open(await sessionCookies(other));
      const r = await o.page.goto(`${APP}${versionPath}`, { waitUntil: "domcontentloaded" });
      check("ordinary account: version page is 404", r?.status() === 404, { status: r?.status() });
      const api = await o.page.evaluate(async (p: string) => (await fetch(p, { method: "POST" })).status, `/api/podcast-editor/${ep}/${vSeg}/verify`);
      check("ordinary account: verify API is 404", api === 404, { status: api });
      await o.ctx.close();
    }
    const anon = await open([]);
    const anonApi = await anon.page.evaluate(async (p: string) => (await fetch(p, { method: "POST" })).status, `/api/podcast-editor/${ep}/${vSeg}/verify`);
    check("anonymous: verify API is 401", anonApi === 401, { status: anonApi });
  } finally {
    log("SUMMARY", { target: APP, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
  }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 300) : "error"); process.exitCode = 1; });

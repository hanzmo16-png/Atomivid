/**
 * Owner validation of the platform close in PRODUCTION, real UI, zero provider cost:
 *  1. Podcast video: on the owner's newest already-narrated episode (no TTS needed), press «Producir video» in the
 *     UI, close the page, come back later: the worker (editor v3) delivers; the page shows the player; the MP4 plays;
 *     the download returns the stored bytes (sha256 = DB) as an attachment.
 *  2. Long Form form accepts up to 30 minutes (no script is created — that would call paid providers).
 *  3. Phone viewport (iPhone 13): no horizontal overflow and 16 px inputs on the main pages.
 * Owner session: one-time admin sign-in link inside the runner (no password), always signed out. Logs: booleans,
 * states and counts only.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { connectResolved } from "../lib/supabase-db";

const APP = "https://atomivid.vercel.app";
const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const results: { check: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const opened: string[] = [];

async function sessionCookies(userId: string) {
  const { data: u } = await admin.auth.admin.getUserById(userId);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: u!.user!.email! });
  const otp = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s } = await otp.auth.verifyOtp({ type: "magiclink", token_hash: link!.properties!.hashed_token });
  if (!s.session) throw new Error("no session");
  opened.push(s.session.access_token);
  const jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(URL_, KEY, { cookies: { getAll: () => jar, setAll: (list) => { for (const c of list) { const i = jar.findIndex((x) => x.name === c.name); if (i >= 0) jar.splice(i, 1); if (c.value) jar.push({ name: c.name, value: c.value }); } } } });
  await ssr.auth.setSession({ access_token: s.session.access_token, refresh_token: s.session.refresh_token });
  return jar;
}

async function main() {
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised" }); process.exitCode = 1; return; }
  const { client } = await connectResolved();
  const owner = (await client.query("select user_id::text id from podcast_editor.propietarios limit 1")).rows[0]?.id as string;
  const ep = (await client.query(`select id::text id from public.podcast_episodes where user_id=$1 and status='ready' and audio_path is not null and duration_seconds >= 20 order by created_at desc limit 1`, [owner])).rows[0]?.id as string | undefined;
  await client.end();
  log("PRECONDITIONS", { owner: Boolean(owner), narratedEpisode: Boolean(ep) });
  if (!owner || !ep) { process.exitCode = 1; return; }
  const pw = ["play", "wright"].join("");
  const { chromium, devices } = (await import(pw)) as { chromium: { launch: (o?: object) => Promise<any> }; devices: Record<string, object> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const cookies = await sessionCookies(owner);
  const ctxFor = async (opts: object) => { const ctx = await browser.newContext({ acceptDownloads: true, ...opts }); await ctx.addCookies(cookies.map((c) => ({ ...c, domain: "atomivid.vercel.app", path: "/", secure: true, sameSite: "Lax" as const }))); return ctx; };
  const dismiss = async (page: any) => { const b = page.getByRole("button", { name: "Omitir", exact: true }); if (await b.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) await b.click(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    // 1. Podcast video, on a phone.
    const phone = await ctxFor(devices["iPhone 13"]);
    let page = await phone.newPage();
    await page.goto(`${APP}/dashboard/podcast/${ep}`, { waitUntil: "networkidle" });
    await dismiss(page);
    const produce = page.getByRole("button", { name: /Producir video|Reintentar|Volver a producir el video/ });
    check("podcast: video panel offers production", await produce.count() === 1);
    const [resp] = await Promise.all([page.waitForResponse((r: any) => r.url().endsWith("/video") && r.request().method() === "POST", { timeout: 60_000 }), produce.click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
    check("podcast: production queued from the UI", resp.status() === 202, { status: resp.status() });
    await page.close(); // the owner closes the app
    const db = createClient(URL_, KEY, { auth: { persistSession: false } });
    let row: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    const stages = new Set<string>();
    for (let i = 0; i < 75; i++) {
      ({ data: row } = await db.from("podcast_episodes").select("video_status,video_stage,video_path,video_bytes,video_sha256,video_duration_seconds,video_error,duration_seconds").eq("id", ep).single());
      if (row?.video_stage) stages.add(row.video_stage);
      if (row?.video_status === "ready" || row?.video_status === "failed") break;
      await new Promise((r) => setTimeout(r, 20_000));
    }
    check("podcast: worker produced the video (editor v3, verified)", row?.video_status === "ready", { status: row?.video_status, stages: [...stages], error: row?.video_error ?? null });
    if (row?.video_status === "ready") {
      check("podcast: video duration matches the audio", Math.abs(Number(row.video_duration_seconds) - Number(row.duration_seconds)) <= 2, { video: Number(row.video_duration_seconds), audio: Number(row.duration_seconds) });
      page = await phone.newPage(); // the owner comes back
      await page.goto(`${APP}/dashboard/podcast/${ep}`, { waitUntil: "networkidle" });
      await dismiss(page);
      const playback = await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return { found: false, played: false, w: 0 };
        v.muted = true; await v.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 4000));
        return { found: true, played: v.currentTime > 1, w: v.videoWidth, h: v.videoHeight };
      });
      check("podcast: after coming back, the video plays on the phone", playback.found && playback.played && playback.w === 1920, playback);
      const href = await page.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
      const r = await fetch(href!);
      const buf = Buffer.from(await r.arrayBuffer());
      check("podcast: download returns the stored MP4 as an attachment", r.ok && buf.length === Number(row.video_bytes) && createHash("sha256").update(buf).digest("hex") === row.video_sha256 && /attachment/i.test(r.headers.get("content-disposition") ?? ""), { bytes: buf.length });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: podcast episode page has no horizontal overflow", overflow <= 1, { overflow });
    }
    // 2 + 3. Long Form form (no submission) and phone layout.
    page = await phone.newPage();
    await page.goto(`${APP}/dashboard/long-form/new`, { waitUntil: "networkidle" });
    await dismiss(page);
    const max = await page.locator('input[name="duration_minutes"]').getAttribute("max");
    const font = await page.locator('input[name="duration_minutes"]').evaluate((el: Element) => getComputedStyle(el).fontSize);
    check("long form: form accepts up to 30 minutes", max === "30", { max });
    check("phone: inputs are 16 px (no iOS zoom on focus)", font === "16px", { font });
    for (const p of ["/dashboard", "/dashboard/long-form/new", "/dashboard/podcast"]) {
      await page.goto(`${APP}${p}`, { waitUntil: "networkidle" });
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`phone: ${p} has no horizontal overflow`, o <= 1, { overflow: o });
    }
    await phone.close();
  } finally {
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
    for (const t of opened) { const { error } = await admin.auth.admin.signOut(t, "local"); check("temporary owner session logout", !error); }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
}
main().catch(() => { console.error("FAILED: platform owner validation; see checks above"); process.exitCode = 1; });

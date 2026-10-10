/**
 * Supervised pilot, PRODUCTION validation with the owner account on a phone, zero provider cost:
 *  A. Insufficient budget (real UI): a fresh draft (no paid call to create it) with a budget below its estimate →
 *     "Producir ahora" is refused with the reason; nothing recorded in the paid-call ledger.
 *  B. Insufficient budget found by the scheduled tick (staged state): the same draft is put in "scheduled" with a
 *     budget below its estimate directly in the DB; the real scheduled worker tick must block it before any call and
 *     send ONE notice (in-app + GitHub comment).
 *  C. Scheduled production (real UI): on the already-narrated episode (narration reused, $0), set a budget and
 *     schedule the start, close the app; the scheduled tick claims it, a manual "produce now" meanwhile is refused,
 *     the worker delivers; back on the phone: review panel (duration, cost, checks, defects), approve, publication
 *     becomes manual, download = stored bytes; one "delivered" notice; ledger rows unchanged.
 * Owner session: one-time admin sign-in link in the runner (no password), always signed out. Public log: states only.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { connectResolved } from "../lib/supabase-db";

const APP = "https://atomivid.vercel.app";
const URL_ = process.env.SUPABASE_URL!.trim(), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const REPO = process.env.GITHUB_REPOSITORY ?? "", GH = process.env.GH_ACTIONS_TOKEN ?? "";
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const results: { check: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const opened: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (m: string) => m.replace(/https?:\/\/\S+/g, "<url>").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>").slice(0, 300);

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

async function ghComments(since: string) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/issues/comments?since=${since}&per_page=50`, { headers: { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json" } });
  return r.ok ? ((await r.json()) as { body: string; user: { login: string } }[]) : [];
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function main() {
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised" }); process.exitCode = 1; return; }
  const startedAt = new Date().toISOString();
  const { client } = await connectResolved();
  const owner = (await client.query("select user_id::text id from podcast_editor.propietarios limit 1")).rows[0]?.id as string;
  const narrated = (await client.query(`select id::text id, voice_id from public.podcast_episodes where user_id=$1 and status='ready' and source='tts' and audio_path is not null and duration_seconds >= 20 order by created_at desc limit 1`, [owner])).rows[0] as { id: string; voice_id: string } | undefined;
  const ledger = async (ep: string) => (await client.query(`select count(*)::int n from public.pi_paid_operations where project_id=$1`, [`podcast-${ep}`])).rows[0].n as number;
  const pilotCols = (await client.query(`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='podcast_episodes' and column_name in ('budget_usd','scheduled_at','video_checks','review_status','publish_status')`)).rows[0].n;
  log("PRECONDITIONS", { owner: Boolean(owner), narratedEpisode: Boolean(narrated), pilotColumns: pilotCols, actionsToken: Boolean(GH) });
  if (!owner || !narrated || pilotCols !== 5) { process.exitCode = 1; await client.end(); return; }
  const db = createClient(URL_, KEY, { auth: { persistSession: false } });
  const read = async (id: string) => (await db.from("podcast_episodes").select("*").eq("id", id).single()).data as Row;
  const notices = async (id: string) => ((await db.from("production_notices").select("kind,run_key,delivered_at,channel,delivery_error").eq("episode_id", id)).data ?? []) as Row[];
  const narratedLedgerBefore = await ledger(narrated.id);
  const before = await read(narrated.id);
  if (["queued", "running", "scheduled"].includes(before.video_status)) { check("precondition: narrated episode idle", false); await client.end(); process.exitCode = 1; return; }

  const pw = ["play", "wright"].join("");
  const { chromium, devices } = (await import(pw)) as { chromium: { launch: (o?: object) => Promise<any> }; devices: Record<string, object> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const cookies = await sessionCookies(owner);
  const phone = await browser.newContext({ acceptDownloads: true, ...devices["iPhone 13"], timezoneId: "UTC", locale: "es-MX" });
  await phone.addCookies(cookies.map((c) => ({ ...c, domain: "atomivid.vercel.app", path: "/", secure: true, sameSite: "Lax" as const })));
  const dismiss = async (page: any) => { const b = page.getByRole("button", { name: "Omitir", exact: true }); if (await b.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) await b.click(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const open = async (id: string) => { const p = await phone.newPage(); await p.goto(`${APP}/dashboard/podcast/${id}`, { waitUntil: "networkidle" }); await dismiss(p); return p; };
  let draftId: string | null = null;
  try {
    // A. Insufficient budget from the UI (fresh draft: creating it is free).
    let page = await phone.newPage();
    await page.goto(`${APP}/dashboard/podcast`, { waitUntil: "networkidle" });
    await dismiss(page);
    const created = await page.evaluate(`fetch("/api/podcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Prueba piloto (presupuesto)", language: "es", source: "tts", voiceId: ${JSON.stringify(narrated.voice_id)}, script: "Este es un guion de prueba del piloto supervisado. No debe narrarse: su presupuesto es menor que su costo estimado." }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`) as { status: number; body: { id?: string } };
    draftId = created.body.id ?? null;
    check("A. draft created from the owner session (no paid call)", created.status === 200 && !!draftId, { status: created.status });
    if (!draftId) throw new Error("no draft");
    await page.close();
    page = await open(draftId);
    const budgetInput = page.locator('input[name="budget_usd"]');
    check("A. the production panel asks for a maximum budget (16 px input)", (await budgetInput.count()) === 1 && (await budgetInput.evaluate((el: Element) => getComputedStyle(el).fontSize)) === "16px");
    await budgetInput.fill("0.001");
    const [resA] = await Promise.all([page.waitForResponse((r: any) => r.url().endsWith("/video") && r.request().method() === "POST"), page.getByRole("button", { name: "Producir ahora" }).click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.waitForTimeout(1500);
    const shown = await page.getByText(/Presupuesto insuficiente/).first().textContent().catch(() => null);
    const draftA = await read(draftId);
    check("A. insufficient budget refused with the reason, nothing started or charged", resA.status() === 402 && !!shown && /No se cobró nada/.test(shown) && draftA.video_status === "none" && (await ledger(draftId)) === 0, { status: resA.status(), videoStatus: draftA.video_status });
    await page.close();

    // B. Insufficient budget at the scheduled start (state staged in the DB; tick + notice are real).
    await db.from("podcast_episodes").update({ video_status: "scheduled", budget_usd: 0.0001, scheduled_at: new Date(Date.now() - 60_000).toISOString(), video_requested_at: new Date().toISOString() }).eq("id", draftId);
    log("STAGED", { scenario: "B", note: "scheduled draft with a budget below its estimate set directly in the DB" });

    // C. Scheduled production of the narrated episode from the UI.
    page = await open(narrated.id);
    const scheduleAt = new Date(Date.now() + 3 * 60_000);
    const local = scheduleAt.toISOString().slice(0, 16); // context timezone is UTC
    await page.locator('input[name="budget_usd"]').fill("0.10");
    await page.locator('input[name="schedule_at"]').fill(local);
    const [resC] = await Promise.all([page.waitForResponse((r: any) => r.url().endsWith("/video") && r.request().method() === "POST"), page.getByRole("button", { name: "Programar" }).click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.waitForTimeout(1500);
    const sched = await read(narrated.id);
    check("C. production scheduled from the phone with its budget (one-shot, no run yet)", resC.status() === 202 && sched.video_status === "scheduled" && Number(sched.budget_usd) === 0.1 && sched.publish_status === "held", { status: resC.status(), videoStatus: sched.video_status });
    check("C. the page shows the scheduled start and a cancel option", (await page.getByText(/Programada para/).count()) > 0 && (await page.getByRole("button", { name: "Cancelar programación" }).count()) === 1);
    await page.close(); // the owner closes the app

    // Wait for the real scheduled ticks (GitHub cron, every 15 min, may be late).
    const end = Date.now() + 55 * 60_000;
    let draftB = await read(draftId), row = await read(narrated.id), refusedWhileRunning: number | null = null;
    while (Date.now() < end && !(draftB.video_status === "blocked" && ["ready", "failed", "blocked"].includes(row.video_status) && row.video_status !== "scheduled" && !(row.video_status === "ready" && row.video_sha256 === before.video_sha256))) {
      await sleep(20_000);
      draftB = await read(draftId); row = await read(narrated.id);
      if (refusedWhileRunning === null && (row.video_status === "queued" || row.video_status === "running")) {
        const p = await open(narrated.id);
        refusedWhileRunning = await p.evaluate(`fetch("/api/podcast/${narrated.id}/video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetUsd: 0.1 }) }).then((r) => r.status)`) as number;
        await p.close();
      }
    }
    const nB = await notices(draftId);
    check("B. scheduled tick blocked the production for insufficient budget before any call", draftB.video_status === "blocked" && /Presupuesto insuficiente/.test(draftB.video_error ?? "") && (await ledger(draftId)) === 0, { status: draftB.video_status });
    check("B. exactly one 'budget' notice, delivered to GitHub", nB.length === 1 && nB[0].kind === "budget" && !!nB[0].delivered_at && nB[0].channel === "github", nB.map((n) => ({ kind: n.kind, delivered: !!n.delivered_at, error: n.delivery_error })));
    check("C. a manual start while the scheduled run works is refused (no duplicate run)", refusedWhileRunning === 409, { status: refusedWhileRunning });
    check("C. the scheduled tick produced and delivered the video", row.video_status === "ready" && row.video_sha256 !== before.video_sha256 && (row.video_attempts ?? 0) === (before.video_attempts ?? 0) + 1, { status: row.video_status, error: row.video_error ? redact(row.video_error) : null });
    if (row.video_status === "ready") {
      const nC = await notices(narrated.id);
      const delivered = nC.filter((n) => n.kind === "delivered" && n.run_key === row.video_run_token);
      check("C. exactly one 'delivered' notice for this run, sent to GitHub", delivered.length === 1 && !!delivered[0].delivered_at, delivered.map((n) => ({ delivered: !!n.delivered_at, error: n.delivery_error })));
      const checks = row.video_checks as { checks: { id: string; ok: boolean }[]; defects: { id: string; severity: string }[]; spend?: { spentUsd: number; uncertain: number } } | null;
      check("C. technical checks and defects stored, review pending, publication held", !!checks && checks.checks.length >= 6 && Array.isArray(checks.defects) && row.review_status === "pending" && row.publish_status === "held",
        { failedChecks: checks?.checks.filter((c) => !c.ok).map((c) => c.id), defects: checks?.defects.map((d) => `${d.id}:${d.severity}`), spentUsd: checks?.spend?.spentUsd, uncertain: checks?.spend?.uncertain });
      page = await open(narrated.id);
      const panel = await page.locator('section[aria-label="Revisión de la entrega"]').textContent().catch(() => "");
      check("C. review screen shows video, duration, cost, checks, defects and the integrity-vs-approval note", /Duración/.test(panel ?? "") && /Costo/.test(panel ?? "") && /Comprobaciones técnicas/.test(panel ?? "") && /Defectos detectados/.test(panel ?? "") && /no la calidad creativa/.test(panel ?? ""));
      const playback = await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return { found: false, played: false, w: 0 };
        v.muted = true; await v.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 4000));
        return { found: true, played: v.currentTime > 1, w: v.videoWidth };
      });
      check("C. the video plays on the phone (1920 wide)", playback.found && playback.played && playback.w === 1920, playback);
      const href = await page.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
      const r = await fetch(href!);
      const buf = Buffer.from(await r.arrayBuffer());
      check("C. download returns the stored MP4 (sha256) as an attachment", r.ok && createHash("sha256").update(buf).digest("hex") === row.video_sha256 && /attachment/i.test(r.headers.get("content-disposition") ?? ""), { bytes: buf.length });
      const [resR] = await Promise.all([page.waitForResponse((x: any) => x.url().endsWith("/review")), page.getByRole("button", { name: "Aprobar para publicar" }).click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
      await page.waitForTimeout(1500);
      const approved = await read(narrated.id);
      check("C. owner approval recorded; publication becomes manual (no upload integration)", resR.status() === 200 && approved.review_status === "approved" && approved.publish_status === "manual" && !!approved.reviewed_at);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: episode page has no horizontal overflow", overflow <= 1, { overflow });
      await page.close();
      page = await phone.newPage();
      await page.goto(`${APP}/dashboard/podcast`, { waitUntil: "networkidle" });
      check("in-app notices listed on the podcast page", (await page.locator('section[aria-label="Avisos"] li').count()) >= 2);
      await page.close();
    }
    check("no new paid call on the narrated episode (narration reused)", (await ledger(narrated.id)) === narratedLedgerBefore, { before: narratedLedgerBefore });
    const comments = (await ghComments(startedAt)).filter((c) => c.user.login === "github-actions[bot]" && /^@\S+ /.test(c.body));
    check("GitHub: owner mentioned in notice comments, generic text only", comments.length >= 2 && comments.every((c) => !/Prueba piloto|USD/.test(c.body)), { comments: comments.length });
    await phone.close();
  } finally {
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
    // Leave no scheduled test production behind.
    if (draftId) await db.from("podcast_episodes").update({ video_status: "blocked", scheduled_at: null }).eq("id", draftId).eq("video_status", "scheduled");
    await client.end().catch(() => undefined);
    for (const t of opened) { const { error } = await admin.auth.admin.signOut(t, "local"); check("temporary owner session logout", !error); }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
}
main().catch((e) => { console.error("FAILED: pilot validation", e instanceof Error ? `${e.constructor.name}: ${redact(e.message)}` : "unknown"); process.exitCode = 1; });

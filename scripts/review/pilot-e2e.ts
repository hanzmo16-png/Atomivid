/**
 * Supervised pilot, PRODUCTION validation with the owner account on a phone (real UI), zero provider cost: every
 * production reuses the already-paid narration of the owner's narrated episode; stock is free-licence; the editor
 * runs on the worker. No row is inserted or edited by hand: every state comes from the UI, the app and the worker.
 *  A. Insufficient budget on a fresh draft (creating it is free): refused with the reason, nothing charged.
 *  B. "Producir ahora" + a second start while it is active → the second is refused (409).
 *  C. Retries: the run is cancelled twice mid-production (real interruption) and retried from the UI: retry_count
 *     goes 1, 2 (consecutive); each interruption leaves ONE "blocked" notice posted by github-actions[bot]; the third
 *     run delivers and retry_count returns to 0, with ONE "delivered" notice from the bot.
 *  D. Scheduling from the UI: start in ~3 min with a budget, close the app; the database tick claims it, the worker
 *     delivers; review screen (duration, cost, checks, defects), approval → publication manual, download = stored.
 *  E. Public notices audit: every comment since the start is by github-actions[bot] and carries no private data,
 *     signed links, ids or credentials.
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
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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

async function gh(path: string, method = "GET") {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { method, headers: { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json" } });
  return { status: r.status, json: r.status === 202 || r.status === 204 ? null : await r.json().catch(() => null) };
}

async function main() {
  if (process.env.OWNER_SESSION_AUTHORIZED !== "yes") { log("BLOCKED", { reason: "owner sign-in not authorised" }); process.exitCode = 1; return; }
  const startedAt = new Date().toISOString();
  const { client } = await connectResolved();
  const owner = (await client.query("select user_id::text id from podcast_editor.propietarios limit 1")).rows[0]?.id as string;
  const narrated = (await client.query(`select id::text id, voice_id from public.podcast_episodes where user_id=$1 and status='ready' and source='tts' and audio_path is not null and duration_seconds >= 20 order by created_at desc limit 1`, [owner])).rows[0] as { id: string; voice_id: string } | undefined;
  const ledger = async (ep: string) => (await client.query(`select count(*)::int n from public.pi_paid_operations where project_id=$1`, [`podcast-${ep}`])).rows[0].n as number;
  const cols = (await client.query(`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='podcast_episodes' and column_name in ('budget_usd','scheduled_at','video_checks','review_status','publish_status','retry_count')`)).rows[0].n;
  log("PRECONDITIONS", { owner: Boolean(owner), narratedEpisode: Boolean(narrated), pilotColumns: cols, actionsToken: Boolean(GH) });
  if (!owner || !narrated || cols !== 6 || !GH) { process.exitCode = 1; await client.end(); return; }
  const db = createClient(URL_, KEY, { auth: { persistSession: false } });
  const read = async (id: string) => (await db.from("podcast_episodes").select("*").eq("id", id).single()).data as Row;
  const notices = async (id: string, since: string) => ((await db.from("production_notices").select("kind,run_key,delivered_at,channel,delivery_error,created_at").eq("episode_id", id).gte("created_at", since)).data ?? []) as Row[];
  const ep = narrated.id;
  const ledgerBefore = await ledger(ep);
  const before = await read(ep);
  if (["queued", "running", "scheduled"].includes(before.video_status)) { check("precondition: narrated episode idle", false); await client.end(); process.exitCode = 1; return; }

  const pw = ["play", "wright"].join("");
  const { chromium, devices } = (await import(pw)) as { chromium: { launch: (o?: object) => Promise<any> }; devices: Record<string, object> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const cookies = await sessionCookies(owner);
  const phone = await browser.newContext({ acceptDownloads: true, ...devices["iPhone 13"], timezoneId: "UTC", locale: "es-MX" });
  await phone.addCookies(cookies.map((c) => ({ ...c, domain: "atomivid.vercel.app", path: "/", secure: true, sameSite: "Lax" as const })));
  const dismiss = async (page: any) => { const b = page.getByRole("button", { name: "Omitir", exact: true }); if (await b.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) await b.click(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const open = async (id: string) => { const p = await phone.newPage(); await p.goto(`${APP}/dashboard/podcast/${id}`, { waitUntil: "networkidle" }); await dismiss(p); return p; };
  const clickPost = async (page: any, button: RegExp | string, suffix = "/video") => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const [res] = await Promise.all([page.waitForResponse((r: any) => r.url().endsWith(suffix) && r.request().method() === "POST", { timeout: 60_000 }), page.getByRole("button", { name: button }).first().click()]); // eslint-disable-line @typescript-eslint/no-explicit-any
    await page.waitForTimeout(1500);
    return res.status() as number;
  };
  const waitRow = async (pred: (r: Row) => boolean, maxMs: number) => { const end = Date.now() + maxMs; let r = await read(ep); while (!pred(r) && Date.now() < end) { await sleep(5000); r = await read(ep); } return r; };
  const cancelActiveRun = async () => {
    const runs = await gh(`/actions/workflows/podcast-video.yml/runs?status=in_progress&per_page=5`);
    const run = (runs.json as { workflow_runs?: { id: number; event: string }[] } | null)?.workflow_runs?.find((r) => r.event === "repository_dispatch");
    return run ? (await gh(`/actions/runs/${run.id}/cancel`, "POST")).status : 0;
  };
  try {
    // A. Insufficient budget on a fresh draft.
    let page = await phone.newPage();
    await page.goto(`${APP}/dashboard/podcast`, { waitUntil: "networkidle" });
    await dismiss(page);
    const created = await page.evaluate(`fetch("/api/podcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Prueba piloto (presupuesto)", language: "es", source: "tts", voiceId: ${JSON.stringify(narrated.voice_id)}, script: "Guion de prueba del piloto supervisado. No debe narrarse: su presupuesto es menor que su costo estimado." }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`) as { status: number; body: { id?: string } };
    const draftId = created.body.id ?? null;
    await page.close();
    if (draftId) {
      page = await open(draftId);
      await page.locator('input[name="budget_usd"]').fill("0.001");
      const st = await clickPost(page, "Producir ahora");
      const shown = await page.getByText(/Presupuesto insuficiente/).first().textContent().catch(() => null);
      const d = await read(draftId);
      check("A. insufficient budget refused with the reason; nothing started or charged", st === 402 && !!shown && /No se cobró nada/.test(shown) && d.video_status === "none" && (await ledger(draftId)) === 0, { status: st, videoStatus: d.video_status });
      await page.close();
    } else check("A. draft created", false, { status: created.status });

    // B. Produce now + a second start while active.
    page = await open(ep);
    await page.locator('input[name="budget_usd"]').fill("0.10");
    const st1 = await clickPost(page, /Volver a producir|Producir ahora|Reintentar/);
    const second = await page.evaluate(`fetch("/api/podcast/${ep}/video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetUsd: 0.1 }) }).then((r) => r.status)`) as number;
    const r1 = await read(ep);
    check("B. production started from the phone with its budget", st1 === 202 && ["queued", "running"].includes(r1.video_status) && Number(r1.budget_usd) === 0.1 && r1.retry_count === 0, { status: st1, retryCount: r1.retry_count });
    check("B. a second start while the production is active is refused (409)", second === 409, { status: second });
    await page.close();

    // C. Two real interruptions with retries from the UI, then delivery.
    const retryCounts: number[] = [];
    for (let round = 1; round <= 2; round++) {
      const running = await waitRow((r) => r.video_status === "running" && /Buscando|Montando|Preparando/.test(r.video_stage ?? ""), 8 * 60_000);
      const token = running.video_run_token;
      const cancel = await cancelActiveRun();
      const failed = await waitRow((r) => r.video_status === "failed", 6 * 60_000);
      // The failed status is written before the notice is recorded and posted: wait (≤ 90 s) for the delivery outcome.
      let n: Row[] = [];
      for (let i = 0; i < 30; i++) {
        n = (await notices(ep, startedAt)).filter((x) => x.run_key === token);
        if (n.length > 0 && n.every((x) => x.delivered_at || x.delivery_error)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      check(`C${round}. interruption: run cancelled mid-production, episode failed, one 'blocked' notice delivered`, cancel === 202 && failed.video_status === "failed" && n.length === 1 && n[0].kind === "blocked" && !!n[0].delivered_at && n[0].channel === "github",
        { cancel, status: failed.video_status, notices: n.map((x) => ({ kind: x.kind, delivered: !!x.delivered_at, error: x.delivery_error })) });
      page = await open(ep);
      const st = await clickPost(page, "Reintentar");
      const rr = await read(ep);
      retryCounts.push(rr.retry_count);
      check(`C${round}. retry from the UI accepted; consecutive retry count = ${round}`, st === 202 && rr.retry_count === round, { status: st, retryCount: rr.retry_count });
      await page.close();
    }
    const delivered = await waitRow((r) => r.video_status === "ready" || r.video_status === "failed" || r.video_status === "blocked", 30 * 60_000);
    const dn = (await notices(ep, startedAt)).filter((x) => x.run_key === delivered.video_run_token && x.kind === "delivered");
    check("C. third run delivered; retry count reset to 0; one 'delivered' notice from the bot", delivered.video_status === "ready" && delivered.retry_count === 0 && dn.length === 1 && !!dn[0].delivered_at,
      { status: delivered.video_status, retryCounts, retryAfter: delivered.retry_count, error: delivered.video_error ? redact(delivered.video_error) : null });

    // D. Scheduling from the UI.
    page = await open(ep);
    const at = new Date(Date.now() + 3 * 60_000).toISOString().slice(0, 16); // context timezone UTC
    await page.locator('input[name="budget_usd"]').fill("0.10");
    await page.locator('input[name="schedule_at"]').fill(at);
    const stS = await clickPost(page, "Programar");
    const sched = await read(ep);
    check("D. production scheduled from the phone (one-shot) with its budget", stS === 202 && sched.video_status === "scheduled" && !!sched.scheduled_at && sched.publish_status === "held", { status: stS, videoStatus: sched.video_status });
    check("D. the page shows the scheduled start and a cancel option", (await page.getByText(/Programada para/).count()) > 0 && (await page.getByRole("button", { name: "Cancelar programación" }).count()) === 1);
    await page.close(); // the owner closes the app
    const prevSha = delivered.video_sha256;
    const claimed = await waitRow((r) => r.video_status !== "scheduled", 15 * 60_000);
    const lateBy = claimed.video_heartbeat_at ? Math.round((Date.parse(claimed.video_heartbeat_at) - Date.parse(sched.scheduled_at)) / 1000) : null;
    check("D. the scheduled start was claimed by the database tick (no manual action)", ["queued", "running", "ready"].includes(claimed.video_status), { status: claimed.video_status, secondsAfterSchedule: lateBy });
    const done = await waitRow((r) => (r.video_status === "ready" && r.video_sha256 !== prevSha) || r.video_status === "failed" || r.video_status === "blocked", 30 * 60_000);
    const sn = (await notices(ep, sched.scheduled_at)).filter((x) => x.run_key === done.video_run_token && x.kind === "delivered");
    check("D. scheduled production delivered with one 'delivered' notice from the bot", done.video_status === "ready" && done.video_sha256 !== prevSha && sn.length === 1 && !!sn[0].delivered_at, { status: done.video_status });
    if (done.video_status === "ready") {
      const checks = done.video_checks as { checks: { id: string; ok: boolean }[]; defects: { id: string; severity: string }[]; spend?: { spentUsd: number; uncertain: number } } | null;
      check("D. checks and defects stored; review pending; publication held", !!checks && checks.checks.length >= 6 && done.review_status === "pending" && done.publish_status === "held",
        { failedChecks: checks?.checks.filter((c) => !c.ok).map((c) => c.id), defects: checks?.defects.map((d) => `${d.id}:${d.severity}`), spentUsd: checks?.spend?.spentUsd, uncertain: checks?.spend?.uncertain });
      page = await open(ep);
      const panel = (await page.locator('section[aria-label="Revisión de la entrega"]').textContent().catch(() => "")) ?? "";
      check("D. review screen: video, duration, cost, checks, defects, integrity ≠ approval", /Duración/.test(panel) && /Costo/.test(panel) && /Comprobaciones técnicas/.test(panel) && /Defectos detectados/.test(panel) && /no la calidad creativa/.test(panel));
      const playback = await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return { found: false, played: false, w: 0 };
        v.muted = true; await v.play().catch(() => undefined); await new Promise((r) => setTimeout(r, 4000));
        return { found: true, played: v.currentTime > 1, w: v.videoWidth };
      });
      check("D. plays on the phone (1920 wide)", playback.found && playback.played && playback.w === 1920, playback);
      const href = await page.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
      const r = await fetch(href!);
      const buf = Buffer.from(await r.arrayBuffer());
      check("D. download = stored MP4 (sha256), as an attachment", r.ok && createHash("sha256").update(buf).digest("hex") === done.video_sha256 && /attachment/i.test(r.headers.get("content-disposition") ?? ""), { bytes: buf.length });
      const stR = await clickPost(page, "Aprobar para publicar", "/review");
      const ap = await read(ep);
      check("D. approval recorded by the owner; publication becomes manual (no upload integration)", stR === 200 && ap.review_status === "approved" && ap.publish_status === "manual");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: no horizontal overflow", overflow <= 1, { overflow });
      await page.close();
    }
    check("no new paid call: ledger rows of the narrated episode unchanged", (await ledger(ep)) === ledgerBefore, { before: ledgerBefore });

    // E. Public notices audit.
    const cm = await gh(`/issues/comments?since=${startedAt}&per_page=100`);
    const comments = ((cm.json ?? []) as { body: string; user: { login: string }; issue_url: string }[]).filter((c) => /\/issues\/\d+$/.test(c.issue_url) && /Atomivid|producción/i.test(c.body));
    const leaks = comments.filter((c) => /sig=|token=|eyJ[\w-]{10,}|[0-9a-f]{8}-[0-9a-f]{4}-|supabase\.co|Prueba piloto|USD|apikey|Bearer|\.mp4/i.test(c.body) || (c.body.match(/https?:\/\/\S+/g) ?? []).some((u) => !u.startsWith(`${APP}/dashboard/podcast`)));
    check("E. notices posted by github-actions[bot], mentioning the owner", comments.length >= 4 && comments.every((c) => c.user.login === "github-actions[bot]" && /^@\S+ /.test(c.body)), { comments: comments.length, authors: [...new Set(comments.map((c) => c.user.login))] });
    check("E. public notices carry no private data, ids, signed links or credentials", leaks.length === 0, { leaks: leaks.length });
    await phone.close();
  } finally {
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
    await client.end().catch(() => undefined);
    for (const t of opened) { const { error } = await admin.auth.admin.signOut(t, "local"); check("temporary owner session logout", !error); }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  }
}
main().catch((e) => { console.error("FAILED: pilot validation", e instanceof Error ? `${e.constructor.name}: ${redact(e.message)}` : "unknown"); process.exitCode = 1; });

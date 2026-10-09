/**
 * Owner-authorized end-to-end test of the in-app YouTube flow (2026-10-09, max USD 5 including the script).
 * Drives the REAL production app in a browser as the owner account: create → script → configure/budget →
 * start (double click) → reload / mobile return during production → playback + download → ledger checks.
 *
 * Session: a one-time magic-link token is generated with the admin API (no email is sent), verified on
 * this runner, and written into cookies by @supabase/ssr (the app's own format). It never leaves the runner
 * and is signed out at the end. Logs: statuses, counts and amounts only (no email, cookies or script text).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { chromium, devices, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const APP = "https://atomivid.vercel.app";
const BUDGET_USD = 5;
const OWNER_REFERENCE_REQUEST = "5bc99f47-7759-48c7-a2a2-92a282d97f78"; // an existing long-form request of the owner
const TOPIC = "Cómo se forman las auroras boreales";
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = process.env.SUPABASE_URL!.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const findings: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { findings.push({ check: name, ok, detail }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };

async function spentSince(startIso: string, ownerId: string, requestId: string | null) {
  const { data } = await db.from("pi_paid_operations").select("project_id,provider,status,reserved_usd,committed_usd,created_at").gte("created_at", startIso);
  const mine = (data ?? []).filter((o) => String(o.project_id).startsWith(`documentary:${ownerId}:`) || (requestId && o.project_id === requestId));
  const usd = mine.reduce((a, o) => a + Number(o.status === "COMMITTED" ? o.committed_usd : o.status === "REFUNDED" ? 0 : o.reserved_usd), 0);
  const byProvider: Record<string, number> = {};
  for (const o of mine) byProvider[o.provider] = Math.round(((byProvider[o.provider] ?? 0) + Number(o.status === "COMMITTED" ? o.committed_usd : o.status === "REFUNDED" ? 0 : o.reserved_usd)) * 10000) / 10000;
  return { usd: Math.round(usd * 10000) / 10000, ops: mine.length, uncertain: mine.filter((o) => ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status)).length, byProvider };
}

async function ownerSessionCookies() {
  const { data: ref } = await db.from("video_requests").select("user_id").eq("id", OWNER_REFERENCE_REQUEST).single();
  const { data: u } = await db.auth.admin.getUserById(ref!.user_id);
  const email = u.user?.email;
  if (!email) throw Error("owner not found");
  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link.properties?.hashed_token) throw Error("link generation failed");
  let jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(url, key, { cookies: { getAll: () => jar, setAll: (c) => { for (const x of c) { jar = jar.filter((j) => j.name !== x.name); if (x.value) jar.push({ name: x.name, value: x.value }); } } } });
  const { data: v, error: vErr } = await ssr.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (vErr || !v.session) throw Error("token verification failed");
  return { ownerId: ref!.user_id as string, cookies: jar, signOut: () => ssr.auth.signOut({ scope: "local" }) };
}

/** First visit in a fresh browser shows the welcome tour over the page; a person closes it once ("Omitir"). */
async function dismissOnboarding(page: Page, where: string) {
  const skip = page.getByRole("button", { name: "Omitir" });
  if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) {
    await skip.click();
    const closed = await page.locator('[aria-labelledby="onboarding-title"]').isHidden({ timeout: 5000 }).catch(() => false);
    check(`welcome tour can be dismissed (${where})`, closed);
  }
}

async function text(page: Page) { return (await page.locator("main").innerText().catch(() => "")) || (await page.locator("body").innerText()); }

async function main() {
  const startIso = new Date().toISOString();
  let spendStart = startIso;
  const session = await ownerSessionCookies();
  const browser = await chromium.launch();
  const cookieList = session.cookies.map((c) => ({ name: c.name, value: c.value, domain: "atomivid.vercel.app", path: "/", httpOnly: false, secure: true, sameSite: "Lax" as const }));
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await desktop.addCookies(cookieList);
  const page = await desktop.newPage();
  let requestId: string | null = null;
  try {
    // 1. Access.
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    check("signed-in dashboard (no redirect to login)", !page.url().includes("/login"), { path: new URL(page.url()).pathname });
    await dismissOnboarding(page, "desktop");

    // Reuse the test project of a previous run if its script is ready and nothing was confirmed yet:
    // the script it already paid for is not generated (or charged) again.
    const { data: prior } = await db.from("documentary_script_jobs").select("id,request_id,status,created_at").eq("user_id", session.ownerId).eq("topic", TOPIC).eq("status", "completed").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const { data: priorReq } = prior ? await db.from("video_requests").select("status,long_form_confirmed_at").eq("id", prior.request_id).maybeSingle() : { data: null };
    let job: { id: string; request_id: string; status: string };
    if (prior && priorReq?.status === "script_ready" && !priorReq.long_form_confirmed_at) {
      job = prior;
      requestId = prior.request_id;
      spendStart = prior.created_at;
      log("REUSING_TEST_PROJECT", { job: prior.id.slice(0, 8), request: prior.request_id.slice(0, 8) });
    } else {
    // 2. Create the YouTube project; the submit button is clicked twice (double submit).
    await page.goto(`${APP}/dashboard/long-form/new`, { waitUntil: "networkidle" });
    await page.fill("#topic", TOPIC);
    await page.selectOption("#language", "es");
    await page.fill("#duration_minutes", "3");
    await page.locator('form:has(#topic) button[type="submit"]').waitFor({ state: "visible" });
    // Two submissions in the same tick = a real double click before React disables the button.
    const navigated = page.waitForURL(/script_job=|error=/, { timeout: 120000 }).then(() => true).catch(() => false);
    await page.evaluate(() => {
      const form = document.querySelector("form:has(#topic)") as HTMLFormElement | null;
      if (!form) throw new Error("create form not found");
      form.requestSubmit();
      form.requestSubmit();
    });
    const arrived = await navigated;
    const after = new URL(page.url());
    if (!after.searchParams.get("script_job")) {
      const alert = await page.locator('[role="alert"]').first().innerText().catch(() => null);
      log("CREATE_RESULT", { navigated: arrived, path: after.pathname, error: after.searchParams.get("error"), alert });
    }
    const jobId = new URL(page.url()).searchParams.get("script_job");
    check("create → redirected with a script job", Boolean(jobId), { path: new URL(page.url()).pathname });
    const { data: jobs } = await db.from("documentary_script_jobs").select("id,request_id,status").eq("user_id", session.ownerId).eq("topic", TOPIC).gte("created_at", startIso);
    check("double submit created exactly one script job", (jobs ?? []).length === 1, { jobs: (jobs ?? []).length });
    if (!jobs?.length) return;
    job = jobs[0];
    requestId = job.request_id;
    }

    // 3. Script generation: follow it in the app, reloading (progress must survive reloads).
    const scriptDeadline = Date.now() + 40 * 60_000;
    let jobRow: Record<string, any> = job;
    let reloads = 0;
    while (Date.now() < scriptDeadline) {
      ({ data: jobRow } = await db.from("documentary_script_jobs").select("status,stage,error_message").eq("id", job.id).single() as never);
      if (jobRow.status === "completed" || jobRow.status === "failed") break;
      await page.goto(`${APP}/dashboard/long-form/jobs/${job.id}`, { waitUntil: "networkidle" }).catch(() => undefined);
      reloads++;
      const spend = await spentSince(spendStart, session.ownerId, requestId);
      if (spend.usd > BUDGET_USD) throw Error(`budget exceeded during script (${spend.usd})`);
      await sleep(30000);
    }
    log("SCRIPT_JOB", { status: jobRow.status, stage: jobRow.stage, reloads, error: jobRow.error_message ? String(jobRow.error_message).slice(0, 160) : null });
    check("script job completed", jobRow.status === "completed");
    if (jobRow.status !== "completed") return;
    const afterScript = await spentSince(spendStart, session.ownerId, requestId);
    log("SPEND_AFTER_SCRIPT", afterScript);
    await page.goto(`${APP}/dashboard/long-form/jobs/${job.id}`, { waitUntil: "networkidle" });
    check("job page offers the configure step", (await page.locator(`a[href*="/dashboard/long-form/configure/${requestId}"]`).count()) > 0);

    // 4. Configure: read the on-screen estimate of the cheapest strategy, enforce the remaining budget.
    await page.goto(`${APP}/dashboard/long-form/configure/${requestId}`, { waitUntil: "networkidle" });
    const strategies: { value: string; usd: number }[] = [];
    for (const value of ["economical", "balanced", "cinematic"]) {
      const label = page.locator("label", { has: page.locator(`input[name="strategy"][value="${value}"]`) });
      // es-MX currency format, e.g. "~USD 0.61" (thousands separator ",").
      const m = (await label.innerText()).match(/~[^\d]*([\d,]+(?:\.\d+)?)/);
      strategies.push({ value, usd: m ? Number(m[1].replace(/,/g, "")) : NaN });
    }
    log("ESTIMATES", strategies);
    const cheapest = strategies.filter((s) => Number.isFinite(s.usd)).sort((a, b) => a.usd - b.usd)[0];
    const remaining = BUDGET_USD - afterScript.usd;
    if (!cheapest || cheapest.usd * 1.15 > remaining) {
      check("estimate fits the remaining authorized budget", false, { cheapest, remaining });
      return;
    }
    check("estimate fits the remaining authorized budget", true, { cheapest, remaining: Math.round(remaining * 100) / 100 });
    const radio = page.locator(`input[name="strategy"][value="${cheapest.value}"]`);
    const diag = async () => ({ path: new URL(page.url()).pathname, radioDisabled: await radio.isDisabled().catch(() => null), radioVisible: await radio.isVisible().catch(() => null),
      fieldsetDisabled: await page.locator("fieldset").first().isDisabled().catch(() => null), alerts: (await page.locator('[role="alert"]').allInnerTexts().catch(() => [])).map((t) => t.slice(0, 200)) });
    if (!(await radio.isChecked().catch(() => false))) {
      await page.locator("label", { has: radio }).click({ timeout: 15000 }).catch(async () => log("STRATEGY_CLICK_FAILED", await diag()));
    }
    const chosen = await radio.isChecked().catch(() => false);
    check("strategy selected in the UI", chosen, chosen ? { strategy: cheapest.value } : await diag());
    if (!chosen) return;
    const confirmBtn = page.getByRole("button", { name: /Confirmar y generar video/ });
    if (!(await confirmBtn.isEnabled())) {
      const blocked = (await text(page)).match(/No se puede iniciar todavía:[^\n]*/)?.[0] ?? "disabled";
      check("configure allows starting", false, { blocked });
      return;
    }
    // Double click on the paid start.
    await confirmBtn.dblclick();
    await page.waitForURL(new RegExp(`/dashboard/videos/${requestId}`), { timeout: 120000 }).catch(() => undefined);
    const { data: started } = await db.from("video_requests").select("status,render_attempts,long_form_confirmed_at").eq("id", requestId).single();
    check("double click started exactly one attempt", started?.render_attempts === 1, started);
    check("lands on the video page", page.url().includes(`/dashboard/videos/${requestId}`));

    // 5. Production: reload the desktop page and come back from a phone while it works.
    const mobile = await browser.newContext({ ...devices["iPhone 13"] });
    await mobile.addCookies(cookieList);
    const phone = await mobile.newPage();
    const renderDeadline = Date.now() + 150 * 60_000;
    let row: Record<string, any> = {};
    let polls = 0, sawProgressOnPhone = false;
    while (Date.now() < renderDeadline) {
      ({ data: row } = await db.from("video_requests").select("status,long_form_stage,supply_wait_started_at,render_attempts,video_path,error_message").eq("id", requestId).single() as never);
      if (row.status !== "processing") break;
      polls++;
      await page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
      if (polls % 4 === 1) {
        await phone.goto(`${APP}/dashboard/videos/${requestId}`, { waitUntil: "networkidle" }).catch(() => undefined);
        if (polls === 1) await dismissOnboarding(phone, "phone");
        const t = await text(phone);
        if (/Produciendo|progreso|En espera de capacidad|Preparando|etapa/i.test(t)) sawProgressOnPhone = true;
      }
      const spend = await spentSince(spendStart, session.ownerId, requestId);
      if (spend.usd > BUDGET_USD) log("BUDGET_ALERT", spend);
      log("PRODUCTION", { status: row.status, stage: row.long_form_stage, waiting: !!row.supply_wait_started_at, spendUsd: spend.usd });
      await sleep(60000);
    }
    check("state survives reloads and is visible from a phone", sawProgressOnPhone || row.status === "completed", { polls });
    log("FINAL_ROW", { status: row.status, attempts: row.render_attempts, video: !!row.video_path, error: row.error_message ? String(row.error_message).slice(0, 200) : null });
    check("production completed", row.status === "completed" && Boolean(row.video_path));

    // 6. Playback and download from the app (desktop and phone).
    await page.goto(`${APP}/dashboard/videos/${requestId}`, { waitUntil: "networkidle" });
    if (row.status === "completed") {
      const meta = await page.evaluate(async () => {
        const v = document.querySelector("video");
        if (!v) return null;
        if (v.readyState < 1) await new Promise((r) => { v.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 20000); });
        return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      });
      check("video plays in the page (metadata loaded)", Boolean(meta && meta.duration > 0 && meta.width > 0), meta);
      const href = await page.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
      if (href) {
        const r = await fetch(href, { redirect: "follow" });
        const bytes = Buffer.from(await r.arrayBuffer());
        writeFileSync("/tmp/download.mp4", bytes);
        const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", "/tmp/download.mp4"]).toString());
        const vstream = probe.streams.find((s: any) => s.codec_type === "video");
        check("download is a playable MP4", r.ok && bytes.length > 0 && Number(probe.format.duration) > 0 && !!vstream, { http: r.status, bytes: bytes.length, seconds: Math.round(Number(probe.format.duration)), width: vstream?.width, height: vstream?.height, audio: probe.streams.some((s: any) => s.codec_type === "audio") });
      } else check("download link present", false);
      await phone.goto(`${APP}/dashboard/videos/${requestId}`, { waitUntil: "networkidle" });
      await dismissOnboarding(phone, "phone");
      check("phone shows the player and download", (await phone.locator("video").count()) > 0 && (await phone.getByRole("link", { name: /Descargar video/ }).count()) > 0);
    }
    await mobile.close();
  } finally {
    const spend = await spentSince(spendStart, session.ownerId, requestId).catch(() => null);
    if (requestId) {
      const { data: ops } = await db.from("pi_paid_operations").select("idempotency_key,provider,method,status").eq("project_id", requestId);
      const keys = (ops ?? []).map((o) => o.idempotency_key);
      check("no duplicate paid operations on the production", new Set(keys).size === keys.length, { ops: keys.length });
      check("no uncertain paid operations left", (ops ?? []).every((o) => !["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status)));
    }
    log("SPEND_TOTAL", spend);
    if (spend) check(`total spend within USD ${BUDGET_USD}`, spend.usd <= BUDGET_USD, spend);
    log("REQUEST", { id: requestId });
    await browser.close().catch(() => undefined);
    await session.signOut().catch(() => undefined);
    log("SUMMARY", { passed: findings.filter((f) => f.ok).length, failed: findings.filter((f) => !f.ok).map((f) => f.check) });
  }
}

main().catch((e) => { console.error("E2E_FAILED", e instanceof Error ? e.message.slice(0, 300) : "error"); process.exitCode = 1; });

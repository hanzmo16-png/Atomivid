/**
 * New-customer verification against the deployed app, in a real browser, with an ordinary account
 * (no owner permissions). Zero provider spend: no script, voice or video is generated.
 *   1. Register through the real form; the address is confirmed with the admin API (the QA mailbox is
 *      not reachable), then the user signs in through the real login form.
 *   2. Dashboard as a non-subscriber: banner, Reel form only, no private beta entry points.
 *   3. Isolation: the owner's documentary, private pages and APIs answer "not found"/refused.
 *   4. Billing: plans shown; "Elegir" opens Stripe Checkout. The session id prefix tells test vs live mode.
 *      Live mode → STOP before any card is entered. Test mode → pay with Stripe's test card, then check that
 *      the webhook assigned the plan (subscriptions row + billing page) and the Reel form is usable.
 * Logs: statuses and booleans only (no emails, cookies or tokens).
 */
import { createClient } from "@supabase/supabase-js";
// playwright is installed only on the E2E runner (not a project dependency): loaded at runtime, untyped,
// so the app's build never needs it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
const loadPlaywright = async () => (await import(["play", "wright"].join(""))) as { chromium: { launch: (o?: object) => Promise<any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
import { randomUUID } from "node:crypto";

// Target deployment. Production by default; the Stripe TEST journey runs against the preview branch alias,
// whose Preview env vars hold Stripe test keys (production's credentials are never touched).
const PROD_APP = "https://atomivid.vercel.app";
const APP = (process.env.E2E_APP?.trim() || PROD_APP).replace(/\/$/, "");
// Vercel "Protection Bypass for Automation" secret, only needed for protected preview deployments. It is sent
// once to the preview origin to set Vercel's bypass cookie there; never logged, never sent to Stripe.
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "";
// Spend authorised for one ordinary-customer Reel (provider cost, USD). Stops before rendering above it.
const REEL_SPEND_CAP_USD = 0.5;
// Stable Vercel alias of the branch reserved for Stripe TEST mode (its own Preview env vars, never production's).
const PREVIEW_APP = "https://atomivid-git-qa-stripe-test-atomivid.vercel.app";
const OWNER_REQUEST = "516b72ae-db4c-48a7-bea1-b08913c70a90"; // Hans's finished test documentary
const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok, detail }); log(ok ? "PASS" : "FAIL", { check: name, detail }); };
const mode = (process.env.E2E_MODE ?? "verify").trim();

/** Opens the target once with Vercel's bypass parameters so the preview sets its own bypass cookie. */
async function primeBypass(page: Page) {
  if (!BYPASS || APP === "https://atomivid.vercel.app") return;
  await page.goto(`${APP}/?x-vercel-protection-bypass=${encodeURIComponent(BYPASS)}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: "domcontentloaded" });
}
const serverHeaders = (): Record<string, string> => (BYPASS && APP !== "https://atomivid.vercel.app" ? { "x-vercel-protection-bypass": BYPASS } : {});

/** Disposable inbox (mail.tm public API, free) so the confirmation email is really received and clicked. */
async function disposableInbox(): Promise<{ address: string; waitForLink: (timeoutMs: number) => Promise<string | null> }> {
  const api = "https://api.mail.tm";
  const domains = await fetch(`${api}/domains`).then((r) => r.json()) as { "hydra:member"?: { domain: string; isActive: boolean }[] };
  const domain = domains["hydra:member"]?.find((d) => d.isActive)?.domain;
  if (!domain) throw new Error("mail.tm: no active domain");
  const address = `qa.cliente.${Date.now()}@${domain}`, password = `Qa-${randomUUID()}`;
  const made = await fetch(`${api}/accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, password }) });
  if (!made.ok) throw new Error(`mail.tm account: ${made.status}`);
  const { token } = await fetch(`${api}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, password }) }).then((r) => r.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  return {
    address,
    async waitForLink(timeoutMs: number) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const list = await fetch(`${api}/messages`, { headers: auth }).then((r) => r.json()).catch(() => null) as { "hydra:member"?: { id: string }[] } | null;
        const first = list?.["hydra:member"]?.[0];
        if (first) {
          const msg = await fetch(`${api}/messages/${first.id}`, { headers: auth }).then((r) => r.json()) as { html?: string[]; text?: string };
          const body = `${(msg.html ?? []).join(" ")} ${msg.text ?? ""}`.replace(/&amp;/g, "&");
          const link = body.match(/https:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/)?.[0] ?? body.match(/https:\/\/[^\s"'<>]+(confirm|callback|token)[^\s"'<>]*/)?.[0];
          if (link) return link;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      return null;
    },
  };
}

async function dismissTour(page: Page) {
  // The tour mounts after hydration: wait for it briefly instead of sampling visibility once.
  const skip = page.getByRole("button", { name: "Omitir" });
  if (await skip.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false)) await skip.click();
}
const bodyText = async (page: Page) => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

/** Raw Supabase sign-up outcome (code/status only) for two kinds of address; no form, no secrets logged. */
async function signupDiag() {
  for (const domain of ["example.com", "mailinator.com"]) {
    const email = `qa.atomivid.${Date.now()}@${domain}`;
    const { data, error } = await db.auth.signUp({ email, password: `Qa-${randomUUID()}`, options: { emailRedirectTo: `${APP}/auth/callback` } });
    log("SIGNUP_DIAG", { domain, ok: !error, userCreated: Boolean(data?.user?.id), identities: data?.user?.identities?.length ?? null,
      code: (error as { code?: string } | null)?.code ?? null, status: (error as { status?: number } | null)?.status ?? null, message: error?.message?.slice(0, 120) ?? null });
    if (data?.user?.id) log("SIGNUP_DIAG_ACCOUNT", { domain, confirmed: Boolean(data.user.email_confirmed_at) });
  }
}

/** Launch tables exist for the server, and an ordinary signed-in session can neither read nor write them. */
async function dbCheck() {
  for (const t of ["marketing_events", "early_access_requests"]) {
    const { error } = await db.from(t).select("*", { count: "exact", head: true });
    log("SERVER_TABLE", { table: t, readable: !error, code: error?.code ?? null });
  }
  const { data: f, error: fErr } = await db.rpc("marketing_funnel", { p_from: "2026-10-01T00:00:00Z", p_to: "2030-01-01T00:00:00Z" });
  log("FUNNEL_RPC", { ok: !fErr, keys: f ? Object.keys(f as object) : null, code: fErr?.code ?? null });
  const email = `qa.rls.${Date.now()}@example.com`, password = `Qa-${randomUUID()}`;
  const { data: made } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  const anonish = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s } = await anonish.auth.signInWithPassword({ email, password });
  const asUser = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${s.session?.access_token}` } } });
  for (const t of ["marketing_events", "early_access_requests"]) {
    const r = await asUser.from(t).select("*").limit(1);
    const w = await asUser.from(t).insert(t === "marketing_events" ? { event: "landing_view", dedupe_key: `rls-probe-${Date.now()}` } : { product: "documentales", email: `rls${Date.now()}@example.com`, consent_at: new Date().toISOString() });
    log("USER_SESSION_ACCESS", { table: t, readRows: r.data?.length ?? null, readCode: r.error?.code ?? null, writeRefused: Boolean(w.error), writeCode: w.error?.code ?? null });
  }
  const fu = await asUser.rpc("marketing_funnel", { p_from: "2026-10-01T00:00:00Z", p_to: "2030-01-01T00:00:00Z" });
  log("USER_SESSION_FUNNEL", { refused: Boolean(fu.error), code: fu.error?.code ?? null });
  if (made?.user) await db.auth.admin.deleteUser(made.user.id);
}

/**
 * Public launch surface, as an anonymous visitor (no account, no spend): landing copy and offer states,
 * first-party measurement (one landing view per day however many reloads, one click per CTA), the
 * early-access form (confirmation, repeat detected). Rows created here carry utm_source=qa_e2e and are
 * removed at the end so they never count as real interest.
 */
async function launchCheck() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const qaEmail = `qa.lista.${Date.now()}@example.com`;
  let visitorId: string | null = null;
  try {
    await primeBypass(page);
    await page.goto(`${APP}/?utm_source=qa_e2e&utm_medium=test`, { waitUntil: "networkidle" });
    const landing = await bodyText(page);
    check("landing: plans section with current prices", /\$19/.test(landing) && /\$49/.test(landing) && /\$129/.test(landing));
    check("landing: offer states (Reels / early access / coming soon)", /(Disponible|Apertura de pagos pendiente)/i.test(landing) && /Acceso anticipado/i.test(landing) && /Próximamente/i.test(landing) && /Podcast Creator/i.test(landing));
    const closed = /Todavía no aceptamos pagos/.test(landing);
    const registerLinks = await page.locator('a[href="/register"]').count();
    const waitlistLinks = await page.locator('a[href="/avisame"]').count();
    check(closed ? "sales closed: CTAs lead to the launch list, none to registration" : "sales open: CTAs lead to registration", closed ? registerLinks === 0 && waitlistLinks > 0 : registerLinks > 0, { registerLinks, waitlistLinks });
    check("landing: no free-video promise, says there is no free trial", !/primer video gratis|gratis tu primer/i.test(landing) && /prueba gratis/i.test(landing));
    check("landing: avatar not announced", !/avatar/i.test(landing));
    log("LANDING_PAYMENTS_NOTE", { paymentsNotEnabledNote: /Todavía no aceptamos pagos/.test(landing) });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    visitorId = (await ctx.cookies(APP)).find((c: { name: string }) => c.name === "atv_vid")?.value ?? null;
    check("visitor cookie set (first-party, httpOnly)", Boolean(visitorId) && Boolean((await ctx.cookies(APP)).find((c: { name: string; httpOnly: boolean }) => c.name === "atv_vid")?.httpOnly));
    const { data: views } = await db.from("marketing_events").select("event,source").eq("visitor_id", visitorId!).eq("event", "landing_view");
    check("landing view counted once despite reload", views?.length === 1 && views[0].source === "qa_e2e", { rows: views?.length ?? null });
    // Two clicks on the same CTA (the second after coming back) count once.
    for (let i = 0; i < 2; i++) {
      await Promise.all([page.waitForURL(/\/acceso-anticipado/, { timeout: 30000 }).catch(() => undefined), page.locator('a[href="/acceso-anticipado"]').first().click()]);
      if (i === 0) await page.goBack({ waitUntil: "networkidle" });
    }
    await page.waitForTimeout(1500);
    const { data: clicks } = await db.from("marketing_events").select("cta").eq("visitor_id", visitorId!).eq("event", "cta_click");
    check("CTA click counted once per CTA and day", clicks?.length === 1 && clicks[0].cta === "early_access_open", { rows: clicks?.length ?? null });
    // Early-access form.
    await page.goto(`${APP}/acceso-anticipado`, { waitUntil: "networkidle" });
    const ea = await bodyText(page);
    check("early-access page: no charge, no date, no immediate access", /No hay cobro/.test(ea) && /no hay fecha/i.test(ea));
    for (const round of ["first", "repeat"]) {
      await page.goto(`${APP}/acceso-anticipado`, { waitUntil: "networkidle" });
      await page.fill('input[name="email"]', qaEmail);
      await page.check('input[name="consent"]');
      await Promise.all([page.waitForURL(/registrado=|error=/, { timeout: 30000 }).catch(() => undefined), page.getByRole("button", { name: /Apuntarme/ }).click()]);
      const text = await bodyText(page);
      if (round === "first") check("early-access: on-screen confirmation", /Tu solicitud quedó registrada/.test(text), { url: new URL(page.url()).search });
      else check("early-access: repeat detected, not duplicated", /ya estaba en la lista/.test(text), { url: new URL(page.url()).search });
    }
    const { data: reqs } = await db.from("early_access_requests").select("product,consent_at").eq("email", qaEmail);
    check("early-access: exactly one stored request with consent", reqs?.length === 1 && Boolean(reqs[0].consent_at), { rows: reqs?.length ?? null });
    // Reels/Shorts launch list (same table, its own product).
    await page.goto(`${APP}/avisame`, { waitUntil: "networkidle" });
    check("launch list page: says payments are not open, no charge", /Todavía no estamos aceptando pagos/.test(await bodyText(page)) && /No hay cobro/.test(await bodyText(page)));
    await page.fill('input[name="email"]', qaEmail);
    await page.check('input[name="consent"]');
    await Promise.all([page.waitForURL(/registrado=|error=/, { timeout: 30000 }).catch(() => undefined), page.getByRole("button", { name: /Apuntarme/ }).click()]);
    check("launch list: on-screen confirmation", /Tu solicitud quedó registrada/.test(await bodyText(page)), { url: new URL(page.url()).search });
    const { data: reelsReq } = await db.from("early_access_requests").select("product").eq("email", qaEmail).eq("product", "reels");
    check("launch list: stored once under product 'reels'", reelsReq?.length === 1);
    const { data: joined } = await db.from("marketing_events").select("dedupe_key").eq("visitor_id", visitorId!).eq("event", "early_access_joined");
    check("list events counted once per list, no email in the event", joined?.length === 2 && joined.every((j: { dedupe_key: string }) => !j.dedupe_key.includes("@")), { rows: joined?.length ?? null });
    const { data: f } = await db.rpc("marketing_funnel", { p_from: new Date(Date.now() - 3600_000).toISOString(), p_to: new Date(Date.now() + 60_000).toISOString() });
    check("funnel report includes these events", Boolean((f as { events?: Record<string, unknown> })?.events?.landing_view));
    // Unauthenticated access to the beacon from another origin is refused.
    const foreign = await fetch(`${APP}/api/m`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ event: "landing_view" }) });
    const { count: afterForeign } = await db.from("marketing_events").select("*", { count: "exact", head: true }).eq("visitor_id", visitorId!);
    log("FOREIGN_ORIGIN_BEACON", { status: foreign.status, rowsForVisitor: afterForeign });
  } finally {
    // Remove QA data so it never counts as real interest or traffic.
    if (visitorId) { const { count } = await db.from("marketing_events").delete({ count: "exact" }).eq("visitor_id", visitorId); log("QA_EVENTS_REMOVED", { rows: count }); }
    const { count: eaDel } = await db.from("early_access_requests").delete({ count: "exact" }).eq("email", qaEmail); log("QA_REQUESTS_REMOVED", { rows: eaDel });
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
  }
}

/**
 * Read-only configuration state (no sign-up, no email, no checkout, no spend). Reports presence and modes only.
 *  - Supabase Auth public settings (email provider on, autoconfirm off).
 *  - Stripe webhook secret presence on production and on the test preview: an unsigned POST answers
 *    "Webhook no configurado" when the secret is missing and "Firma inválida" when it exists.
 *  - Whether preview deployments are behind Vercel protection (401/403) for automation.
 *  - Subscriptions table aggregates (how many rows, how many with a Stripe customer); no ids.
 */
async function stateCheck() {
  const url = process.env.SUPABASE_URL!.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const st = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } }).then((r) => r.json()).catch(() => null) as Record<string, any> | null;
  log("AUTH_SETTINGS", { emailEnabled: st?.external?.email ?? null, autoconfirm: st?.mailer_autoconfirm ?? null, disableSignup: st?.disable_signup ?? null, phoneAutoconfirm: st?.phone_autoconfirm ?? null, samlEnabled: st?.saml_enabled ?? null });
  for (const [name, base] of [["production", APP], ["preview-qa-stripe-test", PREVIEW_APP]] as const) {
    const r = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=0,v1=00", "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const text = r ? await r.text().catch(() => "") : "";
    log("STRIPE_WEBHOOK_SECRET", { env: name, status: r?.status ?? null, secretConfigured: /Firma inválida/.test(text) ? true : /Webhook no configurado/.test(text) ? false : null, protected: r ? [401, 403].includes(r.status) && !/Firma|Webhook/.test(text) : null });
  }
  const { count: subs } = await db.from("subscriptions").select("*", { count: "exact", head: true });
  const { count: withCustomer } = await db.from("subscriptions").select("*", { count: "exact", head: true }).like("stripe_customer_id", "cus_%");
  const { count: active } = await db.from("subscriptions").select("*", { count: "exact", head: true }).in("status", ["active", "trialing"]);
  log("SUBSCRIPTIONS", { rows: subs, withStripeCustomer: withCustomer, active });
  const pv = await fetch("https://atomivid-git-claude-limited-launch-atomivid.vercel.app/", { redirect: "manual" }).catch(() => null);
  log("PREVIEW_PROTECTION", { status: pv?.status ?? null, redirectsToVercelLogin: /vercel\.com\/(login|sso)/.test(pv?.headers.get("location") ?? "") });
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  let recent = 0, unconfirmed = 0;
  for (let p = 1; p <= 10; p++) {
    const { data } = await db.auth.admin.listUsers({ page: p, perPage: 200 });
    if (!data?.users.length) break;
    for (const u of data.users) if (u.created_at >= since) { recent++; if (!u.email_confirmed_at) unconfirmed++; }
  }
  log("RECENT_ACCOUNTS_7D", { created: recent, unconfirmed });
}

/**
 * One ~30 s Reel produced by the ordinary QA customer through the real UI, after the test subscription.
 * Spend: provider cost only, capped at REEL_SPEND_CAP_USD; one attempt, no retries. Checks progress that
 * survives a reload, playback, download (real MP4 1080×1920 ~30 s), quota use and no duplicated paid calls.
 */
async function reelJourney(page: Page, userId: string, email: string, password: string) {
  // Produced on the production app (its real render worker and provider configuration); the customer's
  // entitlement is the subscription the Stripe TEST webhook assigned (same database), not an owner bypass.
  const APP = PROD_APP;
  const startedAt = new Date().toISOString();
  await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60000 }).catch(() => undefined), page.locator('form:has(input[name="email"]) button[type="submit"]').click()]);
  check("customer signs in on production", new URL(page.url()).pathname.startsWith("/dashboard"));
  await page.goto(`${APP}/dashboard/new`, { waitUntil: "networkidle" });
  await dismissTour(page);
  await page.fill('textarea[name="topic"]', "Tres datos sorprendentes sobre las auroras boreales");
  await page.selectOption('select[name="style"]', { index: 1 });
  await Promise.all([page.waitForURL(/\/dashboard\?created=1|\/dashboard\/new\?error=/, { timeout: 60000 }).catch(() => undefined), page.locator('form button[type="submit"]').last().click()]);
  check("Reel request created from the form", /created=1/.test(page.url()), { error: new URL(page.url()).searchParams.get("error") });
  const { data: req } = await db.from("video_requests").select("id,status,mode,duration_seconds").eq("user_id", userId).gte("created_at", startedAt).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!req) { log("BLOCKED", { step: "reel", reason: "no request row" }); return; }
  log("REEL_REQUEST", { mode: req.mode, durationSeconds: req.duration_seconds });
  const status = async () => (await db.from("video_requests").select("status,progress_stage,video_path,render_attempts,error_message").eq("id", req.id).single()).data as Record<string, any>;
  const waitFor = async (pred: (r: Record<string, any>) => boolean, ms: number) => { const until = Date.now() + ms; let r = await status(); while (!pred(r) && Date.now() < until) { await new Promise((x) => setTimeout(x, 10000)); r = await status(); } return r; };

  // Script (the first paid step: script model call).
  await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Generar guion" }).first().click();
  const afterScript = await waitFor((r) => r.status !== "pending" && r.status !== "generating_script", 240_000);
  check("script generated", afterScript.status === "script_ready", { status: afterScript.status });
  if (afterScript.status !== "script_ready") return;

  // Spend gate before the render: estimated provider cost for this Reel must fit the authorised cap.
  const { data: est } = await db.from("generation_costs").select("estimated_cost_usd,voice_characters,script_calls").eq("request_id", req.id).maybeSingle();
  const { data: rows } = await db.from("video_requests").select("script_json").eq("id", req.id).single();
  const segments = ((rows as any)?.script_json?.segments ?? []) as { text?: string }[];
  const narrationChars = segments.reduce((n, sg) => n + (sg.text?.length ?? 0), 0) || JSON.stringify((rows as any)?.script_json ?? {}).length;
  // Voice at twice the configured ElevenLabs rate ($0.10/1k chars) plus a fixed margin for footage/music lookups.
  const projected = Number(est?.estimated_cost_usd ?? 0) + narrationChars * 0.0002 + 0.05;
  log("REEL_SPEND_PROJECTION", { scriptCostUsd: Number(est?.estimated_cost_usd ?? 0), projectedTotalUsd: Number(projected.toFixed(3)), capUsd: REEL_SPEND_CAP_USD });
  if (projected > REEL_SPEND_CAP_USD) { log("STOPPED_BEFORE_RENDER", { reason: "projection above the authorised cap; no render started" }); return; }

  await page.goto(`${APP}/dashboard/review/${req.id}`, { waitUntil: "networkidle" });
  await Promise.all([page.waitForURL(/\/dashboard$|\/dashboard\?/, { timeout: 90000 }).catch(() => undefined), page.getByRole("button", { name: /Generar video final/ }).click()]);
  const processing = await waitFor((r) => r.status === "processing" && Boolean(r.progress_stage), 120_000);
  await page.reload({ waitUntil: "networkidle" });
  const shown = await bodyText(page);
  check("progress persists after reload (status shown from the server)", processing.status === "processing" && /Procesando|Generando|En espera|%/.test(shown), { stage: processing.progress_stage });
  const done = await waitFor((r) => r.status === "completed" || r.status === "failed", 25 * 60_000);
  check("Reel completed", done.status === "completed" && Boolean(done.video_path), { status: done.status, attempts: done.render_attempts, error: done.error_message?.slice(0, 160) ?? null });
  if (done.status !== "completed") return;

  await page.goto(`${APP}/dashboard/videos/${req.id}`, { waitUntil: "networkidle" });
  const playback = await page.evaluate(async () => {
    const v = document.querySelector("video") as HTMLVideoElement | null;
    if (!v) return { found: false, played: false, w: 0, h: 0, d: 0 };
    v.muted = true;
    await v.play().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 4000));
    return { found: true, played: v.currentTime > 1, w: v.videoWidth, h: v.videoHeight, d: v.duration };
  });
  check("Reel plays in the browser", playback.found && playback.played, playback);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }).catch(() => null), page.getByRole("link", { name: /Descargar video/ }).first().click()]);
  const file = download ? `/tmp/reel-${Date.now()}.mp4` : null;
  if (download && file) await download.saveAs(file);
  let probe: Record<string, unknown> | null = null;
  if (file) {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).toString();
    const j = JSON.parse(out) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    const v = j.streams.find((x) => x.codec_type === "video");
    probe = { width: v?.width, height: v?.height, audio: j.streams.some((x) => x.codec_type === "audio"), seconds: Number(Number(j.format.duration).toFixed(1)) };
  }
  check("download is a real 1080×1920 MP4 of about 30 s with audio", Boolean(probe && probe.width === 1080 && probe.height === 1920 && probe.audio && Math.abs(Number(probe.seconds) - 30) <= 6), probe ?? undefined);

  // Quota and paid calls.
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const { count: used } = await db.from("video_requests").select("*", { count: "exact", head: true }).eq("user_id", userId).neq("mode", "avatar").gte("created_at", monthStart);
  check("quota: exactly one Reel counted this month", used === 1, { used });
  const { data: ops } = await db.from("pi_paid_operations").select("idempotency_key,provider,status,committed_usd,reserved_usd").eq("project_id", req.id);
  const keys = (ops ?? []).map((o: any) => o.idempotency_key);
  const committed = (ops ?? []).reduce((a: number, o: any) => a + Number(o.committed_usd ?? 0), 0);
  check("no duplicated paid operations", new Set(keys).size === keys.length, { operations: keys.length, byProvider: Object.fromEntries([...new Set((ops ?? []).map((o: any) => o.provider))].map((p) => [p, (ops ?? []).filter((o: any) => o.provider === p).length])) });
  const { data: finalCost } = await db.from("generation_costs").select("estimated_cost_usd,voice_characters,footage_count,video_duration_seconds").eq("request_id", req.id).maybeSingle();
  log("REEL_SPEND", { ledgerCommittedUsd: Number(committed.toFixed(4)), estimatedCostUsd: Number(finalCost?.estimated_cost_usd ?? 0), voiceCharacters: finalCost?.voice_characters ?? null, footage: finalCost?.footage_count ?? null, capUsd: REEL_SPEND_CAP_USD });
  check("Reel provider cost within the authorised cap", Math.max(committed, Number(finalCost?.estimated_cost_usd ?? 0)) <= REEL_SPEND_CAP_USD);
}

/** Historical provider cost of finished 30 s Reels (aggregates only), to size the spend before producing one. */
async function reelCost() {
  const { data } = await db.from("video_requests").select("id,duration_seconds,mode,status").eq("status", "completed").neq("mode", "avatar").neq("mode", "long_form").limit(500);
  const ids = (data ?? []).filter((r: any) => r.duration_seconds === 30).map((r: any) => r.id);
  const costs: number[] = [], chars: number[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data: c } = await db.from("generation_costs").select("estimated_cost_usd,voice_characters").in("request_id", ids.slice(i, i + 100));
    for (const r of c ?? []) { costs.push(Number(r.estimated_cost_usd)); chars.push(Number(r.voice_characters)); }
  }
  costs.sort((a, b) => a - b); chars.sort((a, b) => a - b);
  const q = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
  log("REEL_30S_HISTORY", { completed30s: ids.length, withCost: costs.length, medianUsd: q(costs, 0.5), p90Usd: q(costs, 0.9), maxUsd: costs.at(-1) ?? null, medianVoiceChars: q(chars, 0.5), maxVoiceChars: chars.at(-1) ?? null });
}

async function main() {
  if (mode === "reel-cost") return reelCost();
  if (mode === "state") return stateCheck();
  if (mode === "launch") return launchCheck();
  if (mode === "all") await launchCheck();
  if (mode === "signup-diag") return signupDiag();
  if (mode === "db-check") return dbCheck();
  // journey: the full customer path with a real, received confirmation email (no admin shortcut).
  const realEmail = mode.startsWith("journey");
  const inbox = realEmail ? await disposableInbox() : null;
  const email = inbox?.address ?? `qa.cliente.${Date.now()}@example.com`;
  const password = `Qa-${randomUUID()}`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  let userId: string | null = null;
  log("TARGET", { app: APP, realEmail });
  try {
    await primeBypass(page);
    // 1. Register through the real form. When Supabase cannot send the confirmation email (its built-in
    //    sender has a tiny project-wide quota), the account is created with the admin API instead, already
    //    confirmed, so the rest of the journey can still be verified; the email step is reported apart.
    await page.goto(`${APP}/register`, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([page.waitForURL(/\/login\?message=|\/register\?error=/, { timeout: 60000 }).catch(() => undefined), page.locator('form:has(input[name="email"]) button[type="submit"]').click()]);
    const after = new URL(page.url());
    const registered = after.pathname === "/login" && (after.searchParams.get("message") ?? "").includes("correo");
    check("register form → 'check your email' message", registered, { path: after.pathname, error: after.searchParams.get("error") });
    let created: { id: string; email_confirmed_at?: string | null } | undefined;
    for (let pageNo = 1; pageNo <= 10 && !created; pageNo++) {
      const { data: list } = await db.auth.admin.listUsers({ page: pageNo, perPage: 200 });
      created = list?.users.find((u) => u.email === email);
      if (!list?.users.length) break;
    }
    if (created && inbox) {
      check("new account is unconfirmed until the email link", !created.email_confirmed_at);
      const link = await inbox.waitForLink(180_000);
      check("confirmation email received in the customer's inbox", Boolean(link));
      if (!link) { log("BLOCKED", { step: "signup email", reason: "no confirmation email within 3 minutes" }); return; }
      await page.goto(link, { waitUntil: "networkidle" }).catch(() => undefined);
      const { data: after2 } = await db.auth.admin.getUserById(created.id);
      check("clicking the email link confirms the account", Boolean(after2?.user?.email_confirmed_at), { landed: new URL(page.url()).pathname });
    } else if (created) {
      check("new account is unconfirmed until the email link", !created.email_confirmed_at);
      await db.auth.admin.updateUserById(created.id, { email_confirm: true });
    } else if (inbox) {
      log("BLOCKED", { step: "signup", reason: "the public form did not create the account (see the register error above)" });
      return;
    } else {
      const { data: made, error: makeError } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      if (makeError || !made.user) { check("QA account created (admin fallback)", false); return; }
      created = made.user;
      log("QA_ACCOUNT_FALLBACK", { reason: "register form did not create the account; created confirmed via admin to continue" });
    }
    userId = created.id;

    // Sign in through the real login form.
    await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 60000 }).catch(() => undefined), page.locator('form:has(input[name="email"]) button[type="submit"]').click()]);
    check("login → dashboard", new URL(page.url()).pathname.startsWith("/dashboard"), { path: new URL(page.url()).pathname });
    await dismissTour(page);

    // 2. Dashboard as a non-subscriber.
    const dash = await bodyText(page);
    check("non-subscriber sees that generating requires a subscription", /suscripción activa/i.test(dash));
    await page.goto(`${APP}/dashboard/new`, { waitUntil: "networkidle" });
    const create = await bodyText(page);
    check("new-video page offers the Reel form", (await page.locator('form input[name="topic"], form textarea[name="topic"]').count()) > 0);
    check("no YouTube/podcast/avatar entry points for an ordinary account", !/YouTube \/ Documental|Podcast \(Beta\)|avatar/i.test(create), { found: create.match(/YouTube \/ Documental|Podcast \(Beta\)|avatar/i)?.[0] ?? null });

    // 3. Isolation and private features.
    for (const path of [`/dashboard/videos/${OWNER_REQUEST}`, "/dashboard/long-form/new", "/dashboard/podcast", `/dashboard/long-form/configure/${OWNER_REQUEST}`]) {
      const r = await page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded" });
      const status = r?.status() ?? 0;
      const text = await bodyText(page);
      check(`private page refused: ${path.replace(OWNER_REQUEST, "<owner-request>")}`, status === 404 || /no encontr|404|not found/i.test(text), { status });
    }
    for (const path of [`/api/generate/${OWNER_REQUEST}/render`, `/api/generate/${OWNER_REQUEST}/resume`, `/api/generate/${OWNER_REQUEST}/confirm-production`, "/api/podcast"]) {
      const status = await page.evaluate(async (p: string) => (await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, path);
      check(`private API refused: ${path.replace(OWNER_REQUEST, "<owner-request>")}`, [400, 401, 403, 404, 409].includes(status), { status });
    }
    const { data: ownerRow } = await db.from("video_requests").select("status,video_path").eq("id", OWNER_REQUEST).single();
    check("owner's documentary unchanged by the attempts", ownerRow?.status === "completed" && Boolean(ownerRow.video_path));

    // 4. Billing.
    await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" });
    await dismissTour(page);
    const billing = await bodyText(page);
    const plans = ["Starter", "Pro", "Business"].filter((p) => new RegExp(p, "i").test(billing));
    check("billing shows the current plans", plans.length === 3, { plans, prices: billing.match(/\$\s?\d+\s?\/mes/g) });
    if (/Pagos aún no habilitados/.test(billing)) {
      // Payments are switched off until Stripe prices exist: the page must say so and offer no checkout.
      check("billing says payments are not enabled and offers no checkout", (await page.getByRole("button", { name: /Elegir Starter/ }).count()) === 0 && /No se te cobrará nada/.test(billing));
      log("PAYMENT_NOT_ATTEMPTED", { reason: "payments not enabled on the server (no Stripe price configured)" });
      return;
    }
    const choose = page.getByRole("button", { name: /Elegir Starter/ });
    await Promise.all([page.waitForURL(/checkout\.stripe\.com|\/dashboard\/billing\?error/, { timeout: 60000 }).catch(() => undefined), choose.click()]);
    const checkoutUrl = page.url();
    const billingError = new URL(checkoutUrl).searchParams.get("error");
    const stripeMode = /cs_test_/.test(checkoutUrl) ? "test" : /cs_live_/.test(checkoutUrl) ? "live" : "unknown";
    check("'Elegir Starter' opens Stripe Checkout", /checkout\.stripe\.com/.test(checkoutUrl), { stripeMode, billingError });
    log("STRIPE_MODE", { mode: stripeMode });
    if (stripeMode !== "test" || !(mode === "pay-test" || mode.startsWith("journey"))) {
      log("PAYMENT_NOT_ATTEMPTED", { reason: stripeMode === "live" ? "Stripe is LIVE here: no card entered, no charge" : stripeMode === "test" ? "test mode detected; payment step runs only in pay-test/journey mode" : "no checkout session" });
      return;
    }
    // Stripe test mode only: Stripe's documented test card (no real money exists in test mode).
    await page.getByLabel(/Email/i).fill(email).catch(() => undefined);
    await page.getByPlaceholder(/1234 1234 1234 1234/).fill("4242424242424242");
    await page.getByPlaceholder(/MM \/ YY|MM \/ AA/).fill("12 / 34");
    await page.getByPlaceholder(/CVC/).fill("123");
    await page.getByPlaceholder(/Full name on card|Nombre/).fill("QA Atomivid").catch(() => undefined);
    await Promise.all([page.waitForURL(/\/dashboard\/billing\?checkout=success/, { timeout: 120000 }).catch(() => undefined), page.locator('button[type="submit"]').first().click()]);
    check("test payment returns to billing with success", /checkout=success/.test(page.url()));
    let sub: Record<string, any> | null = null;
    for (let i = 0; i < 20 && !(sub && ["active", "trialing"].includes(sub.status)); i++) {
      ({ data: sub } = await db.from("subscriptions").select("status,price_id").eq("user_id", userId).maybeSingle() as never);
      if (!(sub && ["active", "trialing"].includes(sub.status))) await new Promise((r) => setTimeout(r, 3000));
    }
    check("webhook assigned an active subscription", Boolean(sub && ["active", "trialing"].includes(sub.status)), { status: sub?.status ?? null });
    await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" });
    check("billing shows the plan as active", /Administrar suscripción/.test(await bodyText(page)));
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    check("subscription banner gone", !/Necesitas una suscripción activa/i.test(await bodyText(page)));
    const { count: subRows } = await db.from("subscriptions").select("*", { count: "exact", head: true }).eq("user_id", userId);
    check("one subscription row after all webhook deliveries (no duplicated entitlement)", subRows === 1, { rows: subRows });
    if (mode === "journey+reel") await reelJourney(page, userId!, email, password);
  } finally {
    log("QA_ACCOUNT", { kept: Boolean(userId), note: "ordinary QA account (example.com), no owner permissions" });
    log("SUMMARY", { passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.check) });
    await browser.close().catch(() => undefined);
  }
}

main().catch((e) => { console.error("E2E_FAILED", e instanceof Error ? e.message.slice(0, 300) : "error"); process.exitCode = 1; });

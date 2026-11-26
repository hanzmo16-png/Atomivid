/** GitHub-only QA browser preflight: login + GET screens + ledger read. No jobs, paid clicks or ledger writes. */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectCampaign320SurfaceReadOnly } from "../../src/lib/mystery-shopper/v3/campaign-320-readonly-preflight";
import { LEDGER_PREFIX, totals, type LedgerState } from "../../src/lib/mystery-shopper/v3/ledger";
import { measureVideo } from "./av-check";
import { MS_BUCKET } from "../../src/lib/mystery-shopper/jobs";

async function main() {
  const env = process.env;
  const out = env.MS_OUT_DIR!;
  await mkdir(out, { recursive: true });
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL || !env.MYSTERY_SHOPPER_QA_EMAIL || !env.MYSTERY_SHOPPER_QA_PASSWORD) throw new Error("QA bindings unavailable");
  const baseURL = "https://atomivid.vercel.app";
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
  const bucket = sb.storage.from(MS_BUCKET);
  let ledger: unknown;
  try {
    const listed = await bucket.list(LEDGER_PREFIX, { limit: 1000 });
    if (listed.error || !listed.data || listed.data.length >= 1000) throw new Error("ledger list unavailable or truncated");
    const state: LedgerState = { reservations: [], settlements: [] };
    for (const item of listed.data) {
      if (!/^reserve-|^settle-/.test(item.name)) continue;
      const file = await bucket.download(`${LEDGER_PREFIX}/${item.name}`);
      if (file.error || !file.data) throw new Error("ledger entry unreadable");
      const entry = JSON.parse(await file.data.text());
      if (item.name.startsWith("reserve-")) {
        if (!entry.key || !["youtube", "audio-podcast", "reels", "video-podcast"].includes(entry.module) || !Number.isFinite(entry.reservedUsd) || entry.reservedUsd <= 0) throw new Error("invalid reservation");
        state.reservations.push(entry);
      } else {
        if (!entry.key || !Number.isFinite(entry.spentUsd) || entry.spentUsd < 0) throw new Error("invalid settlement");
        state.settlements.push(entry);
      }
    }
    const keys = new Set(state.reservations.map(r => r.key));
    if (keys.size !== state.reservations.length || state.settlements.some(s => !keys.has(s.key)) || new Set(state.settlements.map(s => s.key)).size !== state.settlements.length) throw new Error("unreconciled ledger");
    ledger = { state: "READ", ...totals(state), stop: listed.data.some(f => f.name === "STOP"), reservationCount: state.reservations.length, settlementCount: state.settlements.length };
  } catch { ledger = { state: "BLOCKED", reason: "Ledger unreadable, invalid, truncated or unreconciled; no paid operation permitted" }; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Playwright is installed only on the worker.
  const pw = await import(env.PLAYWRIGHT_MODULE || "playwright") as any;
  const browser = await pw.chromium.launch({ headless: true, executablePath: env.MS_CHROME || undefined });
  const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: "es-MX" });
  // Only the login Server Action POST is permitted. Block application mutations after login.
  let authenticated = false;
  await context.route("**/*", async (route: { request(): { url(): string; method(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
    const req = route.request(); const u = new URL(req.url());
    if (/elevenlabs|anthropic|openai|fal\.(ai|run)|heygen|stripe/i.test(u.hostname)) return route.abort();
    if (authenticated && !["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const screens: unknown[] = [];
  let audio: string | null = null;
  try {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Correo electrónico").fill(env.MYSTERY_SHOPPER_QA_EMAIL);
    await page.getByLabel("Contraseña").fill(env.MYSTERY_SHOPPER_QA_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL((u: URL) => /^\/dashboard(?:\/|$)/.test(u.pathname) || u.searchParams.has("error"), { timeout: 30000 });
    authenticated = new URL(page.url()).pathname.startsWith("/dashboard");
    if (authenticated) {
      audio = await context.request.get(`${baseURL}/api/audio-studio/voices`, { timeout: 15000 }).then(async (r: { ok(): boolean; json(): Promise<{ synthesis?: string }> }) => r.ok() ? (await r.json()).synthesis ?? null : null).catch(() => null);
      if (env.MS_OBSERVE_REEL_ID) {
        const id = env.MS_OBSERVE_REEL_ID;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid observer request id");
        const deadline = Date.now() + 18 * 60000;
        let delivered = false;
        while (Date.now() < deadline) {
          await page.goto(`/dashboard/videos/${id}`, { waitUntil: "domcontentloaded" });
          const body = await page.locator("body").innerText();
          if (/No se pudo generar|Producción cancelada/.test(body)) { screens.push({ requestId: id, state: "FAIL", reason: "Existing production failed; no retry requested" }); break; }
          const link = page.getByRole("link", { name: "Descargar video", exact: true });
          if (await link.isVisible().catch(() => false)) {
            const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), link.click()]);
            const file = path.join(out, "existing-reel.mp4"); await download.saveAs(file);
            const facts = await measureVideo(file); screens.push({ requestId: id, state: "DOWNLOADED", facts, subtitles: "NOT_MEASURED", cost: "RESERVATION_RETAINED_PENDING_RECONCILIATION" }); delivered = true; break;
          }
          await page.waitForTimeout(10000);
        }
        await page.screenshot({ path: path.join(out, "existing-reel-final-412.png"), fullPage: true });
        if (!delivered) screens.push({ observerComplete: false, noRenderResent: true });
      }
      for (const surface of ["reels", "video-podcast"] as const) {
        screens.push(await inspectCampaign320SurfaceReadOnly(page, surface));
        await page.screenshot({ path: path.join(out, `${surface}-412.png`), fullPage: true });
      }
      for (const route of ["/dashboard/long-form/new", "/dashboard/audio-studio"]) {
        const response = await page.goto(route, { waitUntil: "domcontentloaded" });
        const body = await page.locator("body").innerText();
        screens.push({ route, httpStatus: response?.status(), finalPath: new URL(page.url()).pathname, notFound: /no encontramos esa página/i.test(body), headingVisible: await page.locator("h1").isVisible().catch(() => false) });
        await page.screenshot({ path: path.join(out, `${route.includes("long-form") ? "longform" : "audio"}-412.png`), fullPage: true });
      }
    }
  } finally { await browser.close(); }

  const result = { audioSynthesis: audio, authenticated, viewport: "412x915", target: baseURL, ledger, screens, paidCalls: 0, jobsCreated: 0, scope: "AUTHENTICATED_READ_ONLY_NOT_COMMERCIAL_GENERATION" };
  await writeFile(path.join(out, "authenticated-readonly.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!authenticated) process.exitCode = 3;
}
main().catch(() => { console.error("Read-only preflight failed; no credential values or raw HTTP bodies logged"); process.exitCode = 3; });

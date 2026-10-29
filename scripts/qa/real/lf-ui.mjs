// USD 0, SOLO LECTURA: recorre la interfaz REAL de YouTube Long Form con la sesión del dueño, en escritorio, móvil y una
// sesión nueva, SIN crear nada: entrada desde «Nuevo video» → «YouTube / Documental», formulario (no se envía), y la
// página del último documental (reproducción y enlace de descarga). Conteos de solo lectura antes/después prueban que
// no se creó solicitud, trabajo de guion ni operación pagada. No toca Podcast Studio.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";

const APP = process.env.APP_URL || "https://atomivid.vercel.app", EVID = process.env.EVID, OWNER = process.env.OWNER_ID, REF = process.env.LF_REQUEST_ID || "";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (n, c, i = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${i ? ` — ${i}` : ""}`); if (!c) fails++; return c; };
const count = async (t, f) => { let q = db.from(t).select("*", { count: "exact", head: true }); q = f(q); const { count: n } = await q; return n; };
const ledger = async () => ({ requests: await count("video_requests", (q) => q.eq("user_id", OWNER)), scriptJobs: await count("documentary_script_jobs", (q) => q.eq("user_id", OWNER)),
  paidOps: await count("pi_paid_operations", (q) => q.not("project_id", "like", "podcast%")) });
const BEFORE = await ledger(); console.log(`LEDGER_BEFORE ${JSON.stringify(BEFORE)}`);
// Último documental: «hash:<prefijo>» del id (los ids no se imprimen).
const { data: jobs } = await db.from("documentary_script_jobs").select("request_id").eq("user_id", OWNER).order("created_at", { ascending: false }).limit(200);
const hits = [...new Set((jobs || []).map((x) => x.request_id).filter(Boolean))].filter((id) => crypto.createHash("sha256").update(id).digest("hex").startsWith(REF.slice(5)));
const R = REF.startsWith("hash:") && hits.length === 1 ? hits[0] : null;
ok("último documental identificado (único)", !!R, `${hits.length}`);

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
for (const [tag, opts, state] of [["escritorio", { viewport: { width: 1366, height: 900 } }, process.env.STATE_FILE], ["movil", { ...devices["Pixel 7"] }, process.env.STATE_FILE],
  ["sesion-nueva", { viewport: { width: 1280, height: 800 } }, process.env.STATE_FILE_2]]) {
  const ctx = await browser.newContext({ ...opts, storageState: state });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `${tag}-${n}.png`), fullPage: true }).catch(() => {});
  const wide = async (n) => { const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(`${tag}: ${n} sin desplazamiento horizontal`, o <= 1, `${o}px`); };
  try {
    await p.goto(`${APP}/dashboard/new`);
    const card = p.getByText("YouTube / Documental").first();
    ok(`${tag}: «Nuevo video» ofrece «YouTube / Documental»`, await card.isVisible().catch(() => false));
    await card.click(); await p.waitForURL(/long-form\/new/, { timeout: 30000 }).catch(() => {});
    ok(`${tag}: abre el formulario de documental`, /\/dashboard\/long-form\/new/.test(p.url()), new URL(p.url()).pathname);
    const fields = { tema: await p.locator("input[name=topic]").count(), idioma: await p.locator("select[name=language]").count(), duracion: await p.locator("input[name=duration_minutes]").count() };
    ok(`${tag}: campos tema, idioma y duración`, fields.tema === 1 && fields.idioma === 1 && fields.duracion === 1, JSON.stringify(fields));
    const btn = p.getByRole("button", { name: "Crear y revisar guion" });
    ok(`${tag}: botón «Crear y revisar guion» visible (no se pulsa)`, await btn.isVisible().catch(() => false));
    await shot("1-formulario"); await wide("formulario");
    if (R) {
      await p.goto(`${APP}/dashboard/videos/${R}`, { timeout: 120000 }); await p.waitForTimeout(3000);
      const v = p.locator("video").first();
      const play = await v.evaluate(async (el) => { el.muted = true; await el.play().catch(() => {}); await new Promise((x) => setTimeout(x, 5000)); const o = { rs: el.readyState, t: el.currentTime, d: el.duration, err: el.error?.code ?? null }; el.pause(); return o; }).catch((e) => ({ err: String(e).slice(0, 80) }));
      ok(`${tag}: el último documental se reproduce`, play.rs >= 2 && play.t > 0.5 && !play.err, JSON.stringify(play));
      const dl = p.getByText("Descargar video").first();
      const href = await dl.evaluate((el) => el.closest("a")?.getAttribute("href") ?? "").catch(() => "");
      ok(`${tag}: enlace de descarga del MP4`, await dl.isVisible().catch(() => false) && /download=/.test(href), href ? "con download=" : "sin enlace");
      await shot("2-resultado"); await wide("resultado");
    }
  } catch (e) { ok(`${tag}: recorrido sin errores`, false, String(e?.message ?? e).slice(0, 200)); await shot("error"); }
  await ctx.close();
}
await browser.close();
const AFTER = await ledger(); console.log(`LEDGER_AFTER ${JSON.stringify(AFTER)}`);
ok("sin cambios: solicitudes, trabajos de guion ni operaciones pagadas", JSON.stringify(AFTER) === JSON.stringify(BEFORE), JSON.stringify({ BEFORE, AFTER }));
console.log(`RESULT lf-ui: ${fails} FAIL`);
process.exit(fails ? 1 : 0);

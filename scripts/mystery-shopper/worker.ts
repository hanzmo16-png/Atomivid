/**
 * Mystery Shopper 2.0 — worker real. Corre en GitHub Actions (o en el arnés local), nunca en Vercel serverless.
 *
 * 1. Toma el trabajo con un claim atómico (si ya terminó o lo tiene otro worker vivo, sale sin hacer nada).
 * 2. Abre un navegador y un contexto NUEVOS (sin cookies), con id de sesión aleatorio y la versión del navegador.
 * 3. Entra a ATOMIVID con la cuenta QA de los secretos (nunca en código, logs ni informes) y recorre la misión
 *    como el perfil elegido. En modo gratuito no pulsa nada facturable; el navegador además bloquea proveedores.
 * 4. Guarda capturas, registro de acciones e informe en el trabajo (Storage), y el estado con latido.
 *
 * Uso: MS_JOB_ID=<id> npx tsx scripts/mystery-shopper/worker.ts
 * Entorno: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MYSTERY_SHOPPER_QA_EMAIL, MYSTERY_SHOPPER_QA_PASSWORD,
 *          VERCEL_AUTOMATION_BYPASS_SECRET (solo Previews protegidos), MS_WORKER_RUN_URL, PLAYWRIGHT_MODULE, MS_CHROME.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { defaultCatalog, missionById } from "../../src/lib/mystery-shopper/catalog";
import { jobStore, MS_BUCKET, type JobStatus, type StorageApi } from "../../src/lib/mystery-shopper/jobs";
import { findingsFrom, mediaCheck, technicalTerms, verdictFor, LIVE_VERSION, type ActionLog, type LiveReport, type LiveStep, type MediaCheck, type PageMetrics } from "../../src/lib/mystery-shopper/live";
import { PRODUCT_LABEL, type Mission, type ProfileId } from "../../src/lib/mystery-shopper/types";

const run = promisify(execFile);
const BILLABLE = /elevenlabs|anthropic|openai|stripe\.com|fal\.(ai|run)|heygen|pexels|recraft|d-id|runwayml|googleapis\.com\/.*veo/i;
const VIEWPORT: Record<ProfileId, { width: number; height: number; mobile: boolean }> = {
  principiante: { width: 412, height: 915, mobile: true },
  impaciente: { width: 390, height: 844, mobile: true },
  creador: { width: 1366, height: 900, mobile: false },
  profesional: { width: 1440, height: 900, mobile: false },
};

const env = process.env;
const jobId = env.MS_JOB_ID || process.argv[2] || "";
const runnerId = `${env.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${os.hostname()}`}-${randomUUID().slice(0, 8)}`;
const nowIso = () => new Date().toISOString();

function bucket(): StorageApi {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY para guardar el trabajo.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(MS_BUCKET) as unknown as StorageApi;
}

/** Nunca deja pasar la contraseña, correos ni tokens a un log o informe. */
function redact(text: string): string {
  let t = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo]").replace(/\b(eyJ[\w-]{10,}|sk-[\w-]{8,}|ghp_[\w]{10,})/g, "[secreto]");
  for (const s of [env.MYSTERY_SHOPPER_QA_PASSWORD, env.VERCEL_AUTOMATION_BYPASS_SECRET, env.SUPABASE_SERVICE_ROLE_KEY]) if (s && s.length >= 4) t = t.split(s).join("[secreto]");
  return t;
}

async function main(): Promise<number> {
  if (!jobId) { console.error("Falta MS_JOB_ID"); return 2; }
  const store = jobStore(bucket());
  const claim = await store.claim(jobId, runnerId, Date.now());
  if (!claim.ok) { console.log(`[mystery-shopper] ${jobId}: no se ejecuta (${claim.reason}): ${claim.detail}`); return claim.reason === "agotado" ? 1 : 0; }
  const view = (await store.get(jobId))!;
  const job = view.job;
  const mission: Mission = missionById(defaultCatalog(), job.missionId);
  try {
    return await evaluate(store, view, mission, claim.attempt);
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message.split("\n")[0] : String(e)).slice(0, 300);
    console.error("[mystery-shopper] fallo del worker", msg);
    await store.setStatus(jobId, runnerId, { ...view.status, state: "error", stage: "El worker falló", attempt: claim.attempt, runnerId, error: msg, finishedAt: nowIso(), heartbeatAt: nowIso(), updatedAt: nowIso() }).catch(() => {});
    return 1;
  }
}

async function evaluate(store: ReturnType<typeof jobStore>, view: NonNullable<Awaited<ReturnType<ReturnType<typeof jobStore>["get"]>>>, mission: Mission, attempt: number): Promise<number> {
  const job = view.job;
  const claim = { attempt };
  const startedAt = nowIso();
  let status: JobStatus = { ...view.status, state: "en_proceso", stage: "Abriendo un navegador nuevo", attempt: claim.attempt, runnerId, heartbeatAt: startedAt, startedAt, finishedAt: null, workerRunUrl: env.MS_WORKER_RUN_URL || null, error: null, updatedAt: startedAt };
  const save = async (patch: Partial<JobStatus>) => { status = { ...status, ...patch, heartbeatAt: nowIso(), updatedAt: nowIso() }; await store.setStatus(jobId, runnerId, status); };
  await save({});
  const beat = setInterval(() => { save({}).catch((e) => console.error("[mystery-shopper] latido", e instanceof Error ? e.message : e)); }, 30_000);

  const out = path.join(env.MS_OUT_DIR || os.tmpdir(), `ms-${jobId}`); // copia local efímera; lo durable va a Storage
  await mkdir(out, { recursive: true });
  const log: ActionLog[] = [];
  const act = (action: string, detail = "") => { const e = { t: nowIso(), action, detail: redact(detail) }; log.push(e); console.log(`[ms] ${e.t} ${action} ${e.detail}`); };
  const steps: LiveStep[] = [];
  const pages: PageMetrics[] = [];
  const media: MediaCheck[] = [];
  const criteria = (mission.criteria ?? []).map((text) => ({ text, met: null as boolean | null, evidence: "" }));
  const mark = (i: number, met: boolean, evidence: string) => { if (criteria[i]) criteria[i] = { ...criteria[i], met, evidence: redact(evidence).slice(0, 240) }; };
  let critical: string | null = null;
  let authenticated = false;
  let humanGate: string | null = null;
  let observedSha: string | null = null;
  const vp = VIEWPORT[job.profile];

  const pwMod = await import(env.PLAYWRIGHT_MODULE || "playwright");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- playwright no es dependencia de la app; el worker lo instala aparte.
  const pw = (pwMod.chromium ? pwMod : pwMod.default) as any;
  const browser = await pw.chromium.launch({ headless: true, executablePath: env.MS_CHROME || undefined });
  const headers: Record<string, string> = {};
  if (job.target.kind === "preview") {
    if (env.VERCEL_AUTOMATION_BYPASS_SECRET) { headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET; headers["x-vercel-set-bypass-cookie"] = "true"; }
  }
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, locale: "es-MX", extraHTTPHeaders: headers });
  const sessionId = randomUUID();
  const fresh = (await context.cookies()).length === 0;
  await save({ stage: "Navegador nuevo abierto", browser: { sessionId, version: browser.version(), freshContext: fresh } });
  act("navegador", `sesión ${sessionId} · ${browser.version()} · contexto nuevo=${fresh} · ${vp.width}×${vp.height} · perfil ${job.profile}`);
  await context.route("**/*", (route: { request(): { url(): string }; abort(r?: string): Promise<void>; continue(): Promise<void> }) => {
    const u = route.request().url();
    if (BILLABLE.test(new URL(u).hostname)) { act("bloqueado", `petición del navegador a un proveedor de pago: ${new URL(u).hostname}`); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  const page = await context.newPage();
  let consoleErrors = 0;
  page.on("console", (m: { type(): string }) => { if (m.type() === "error") consoleErrors++; });
  page.on("response", (r: { url(): string; headers(): Record<string, string> }) => { const s = r.headers()["x-vercel-git-commit-sha"]; if (s && !observedSha) observedSha = s; });

  let n = 0;
  const shotName = (label: string) => `${String(n).padStart(2, "0")}-${label.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "paso"}.png`;
  const metrics = async (status: number | null, loadMs: number): Promise<PageMetrics> => {
    const m = await page.evaluate(() => {
      const overflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
      const controls = [...document.querySelectorAll("a, button, select, input:not([type=hidden]):not([type=radio]):not([type=checkbox])")];
      const small = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; }).length;
      const unlabeled = [...document.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea")].filter((el) => {
        const id = el.getAttribute("id"); const r = el.getBoundingClientRect(); if (r.width === 0) return false;
        return !(id && document.querySelector(`label[for="${id}"]`)) && !el.getAttribute("aria-label") && !el.closest("label") && !el.getAttribute("aria-labelledby");
      }).length;
      const text = document.body.innerText;
      const errs = [...document.querySelectorAll('[role="alert"]')].map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
      return { overflow, small, unlabeled, text: text.slice(0, 20000), errs };
    });
    const pm: PageMetrics = {
      url: page.url(), viewport: { width: vp.width, height: vp.height }, horizontalOverflowPx: m.overflow, smallTargets: m.small, unlabeledFields: m.unlabeled,
      technicalTerms: technicalTerms(m.text), costVisible: /USD\s?\d|US\$\s?\d|\$\s?\d+[.,]\d{2}|costo|presupuesto/i.test(m.text), errorsVisible: m.errs.map(redact),
      consoleErrors, loadMs, httpStatus: status,
    };
    pages.push(pm);
    return pm;
  };
  const step = async (name: string, fn: () => Promise<{ state: LiveStep["state"]; detail: string }>): Promise<LiveStep> => {
    n++;
    const t0 = Date.now();
    await save({ stage: `Paso ${n}: ${name}` }).catch(() => {});
    let r: { state: LiveStep["state"]; detail: string };
    try { r = await fn(); } catch (e) { r = { state: "FAIL", detail: e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : String(e) }; }
    let shot: string | null = null;
    try {
      const name2 = shotName(name); const buf = await page.screenshot({ fullPage: true });
      await writeFile(path.join(out, name2), buf); await store.putEvidence(jobId, name2, buf, "image/png"); shot = name2;
    } catch { /* sin captura: se dice en el paso */ }
    const s: LiveStep = { n, name, state: r.state, detail: redact(r.detail), screenshot: shot, ms: Date.now() - t0, url: page.url() || null };
    steps.push(s);
    act(`paso ${n}`, `${name}: ${r.state} — ${s.detail}`);
    return s;
  };
  const goto = async (p: string) => {
    const t0 = Date.now();
    const res = await page.goto(`${job.target.url}${p}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const m = await metrics(res?.status() ?? null, Date.now() - t0);
    await dismissOverlays();
    return m;
  };
  const impatient = job.profile === "impaciente";
  /** Como un cliente: si un recorrido de bienvenida tapa la pantalla, lo omite. Se registra como hallazgo medido. */
  const overlayNotes: { url: string; text: string }[] = [];
  const dismissOverlays = async () => {
    const skip = page.getByRole("button", { name: "Omitir" }).first();
    if (await skip.isVisible().catch(() => false)) {
      const text = ((await page.locator('[role="dialog"]').first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 120);
      overlayNotes.push({ url: page.url(), text });
      act("ventana", `recorrido de bienvenida visible («${text}»): se pulsa «Omitir»`);
      await skip.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  };

  try {
    // 1. Acceso
    const access = await step("Abrir ATOMIVID", async () => {
      const m = await goto("/login");
      if (!m.httpStatus || m.httpStatus >= 400) {
        if (job.target.kind === "preview" && (m.httpStatus === 401 || m.httpStatus === 403)) { humanGate = "El Preview está protegido por Vercel: falta el secreto VERCEL_AUTOMATION_BYPASS_SECRET en el worker."; return { state: "BLOCKED", detail: `HTTP ${m.httpStatus}: Preview protegido.` }; }
        return { state: "FAIL", detail: `HTTP ${m.httpStatus}` };
      }
      return { state: "PASS", detail: `HTTP ${m.httpStatus} en ${(m.loadMs / 1000).toFixed(1)} s` };
    });
    // 2. Autenticación real con la cuenta QA (o bloqueo explícito si no existe)
    const email = env.MYSTERY_SHOPPER_QA_EMAIL, password = env.MYSTERY_SHOPPER_QA_PASSWORD;
    const doLogin = async () => {
      await page.getByLabel("Correo electrónico").fill(email!);
      await page.getByLabel("Contraseña").fill(password!);
      await page.getByRole("button", { name: "Iniciar sesión" }).click();
      await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    };
    if (access.state === "PASS") {
      await step("Iniciar sesión con la cuenta QA", async () => {
        if (!email || !password) { humanGate = "Falta la cuenta QA: crear un usuario de prueba en ATOMIVID y guardar MYSTERY_SHOPPER_QA_EMAIL y MYSTERY_SHOPPER_QA_PASSWORD como secretos del repositorio."; return { state: "BLOCKED", detail: "No hay cuenta QA configurada. No se inventa una sesión." }; }
        await doLogin(); authenticated = true;
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await metrics(200, 0);
        await dismissOverlays();
        return { state: "PASS", detail: "Sesión iniciada; panel visible." };
      });
    }
    if (!authenticated) {
      critical = critical ?? (humanGate ? null : "No se pudo entrar a ATOMIVID.");
    } else {
      await runMission();
      // Cierre de sesión y recuperación controlada
      await step("Cerrar sesión", async () => {
        await goto("/dashboard");
        const btn = page.getByRole("button", { name: "Cerrar sesión" }).or(page.getByLabel("Cerrar sesión")).first();
        if (!(await btn.isVisible().catch(() => false))) { const menu = page.getByRole("button", { name: /menú/i }).first(); if (await menu.isVisible().catch(() => false)) await menu.click(); }
        await btn.click();
        await page.waitForURL(/\/login|\/$/, { timeout: 20_000 });
        const back = await page.goto(`${job.target.url}/dashboard`, { waitUntil: "domcontentloaded" });
        const outside = /\/login/.test(page.url());
        return outside ? { state: "PASS", detail: "Sesión cerrada: /dashboard vuelve al login." } : { state: "FAIL", detail: `Tras cerrar sesión /dashboard respondió ${back?.status()} sin pedir login.` };
      });
      await step("Volver a entrar (recuperación)", async () => {
        await goto("/login"); await doLogin();
        return { state: "PASS", detail: "La cuenta vuelve a entrar y ve su panel." };
      });
    }
  } catch (e) {
    act("error", e instanceof Error ? e.message : String(e));
  }

  async function runMission() {
    const cIdx = (re: RegExp) => criteria.findIndex((c) => re.test(c.text));
    switch (mission.id) {
      case "cuenta-navegacion": {
        mark(cIdx(/Inicia sesión/), true, "Sesión iniciada con la cuenta QA.");
        await step("Ver el menú principal", async () => {
          const m = await goto("/dashboard");
          const links = await page.locator("header a[href^='/dashboard'], nav a[href^='/dashboard']").evaluateAll((as: Element[]) => [...new Set(as.map((a) => a.getAttribute("href")))]);
          mark(cIdx(/menú muestra/), links.length >= 2, `${links.length} enlaces: ${links.join(", ")}`);
          mark(cIdx(/desbordamiento/), m.horizontalOverflowPx <= 1, `${m.horizontalOverflowPx}px a ${vp.width}px`);
          const bad: string[] = [];
          for (const href of links.slice(0, 8)) {
            const r = await page.goto(`${job.target.url}${href}`, { waitUntil: "domcontentloaded" }).catch(() => null);
            const st = r?.status() ?? 0; if (!st || st >= 400) bad.push(`${href} → ${st}`);
            if (impatient) { await page.goBack().catch(() => {}); await page.goForward().catch(() => {}); }
          }
          mark(cIdx(/Cada enlace/), bad.length === 0, bad.length ? bad.join("; ") : "todos abren");
          return bad.length ? { state: "FAIL", detail: bad.join("; ") } : { state: "PASS", detail: `${links.length} enlaces abren` };
        });
        // los dos últimos criterios se marcan tras cerrar sesión y volver a entrar
        break;
      }
      case "audio-proyecto-prueba": {
        const title = `QA cliente misterioso ${jobId.slice(-6)}`;
        await step("Encontrar Audio Podcast en el menú", async () => {
          await goto("/dashboard");
          const link = page.locator('a[href="/dashboard/audio-studio"]:visible').first();
          const visible = await link.isVisible().catch(() => false);
          mark(cIdx(/Encuentra Audio/), visible, visible ? "Enlace visible en el menú." : "No hay enlace visible a Audio Podcast.");
          if (!visible) return { state: "FAIL", detail: "No se ve «Audio Podcast» en el menú." };
          await link.click(); await page.waitForURL(/audio-studio/); await metrics(200, 0);
          return { state: "PASS", detail: "Audio Podcast abierto desde el menú." };
        });
        let projectUrl = "";
        await step("Crear un episodio de prueba", async () => {
          await page.getByLabel("Título").first().fill(title);
          const create = page.getByRole("button", { name: "Crear episodio" });
          if (impatient) await create.dblclick(); else await create.click();
          await page.waitForURL(/audio-studio\/[0-9a-f-]{36}/, { timeout: 30_000 });
          projectUrl = page.url();
          mark(cIdx(/Crea un episodio/), true, projectUrl.replace(job.target.url, ""));
          await metrics(200, 0);
          return { state: "PASS", detail: "Episodio creado y abierto." };
        });
        if (projectUrl) {
          const script = "Ana: Hola, esto es una prueba del cliente misterioso de ATOMIVID.\nLeo: No se genera voz; solo se guarda y se recupera el guion.";
          await step("Escribir y guardar el guion", async () => {
            await page.getByLabel("Guion").first().fill(script);
            await page.getByRole("button", { name: "Guardar" }).first().click();
            await page.waitForTimeout(1500);
            const m = await metrics(200, 0);
            mark(cIdx(/presupuesto o costo/), m.costVisible, m.costVisible ? "Se ve un costo o presupuesto en la pantalla del episodio." : "No se ve ningún costo antes de generar.");
            mark(cIdx(/Escribe y guarda/), m.errorsVisible.length === 0, m.errorsVisible[0] ?? "Guardado sin error visible.");
            return m.errorsVisible.length ? { state: "FAIL", detail: m.errorsVisible[0] } : { state: "PASS", detail: "Guion guardado." };
          });
          await step("Recargar y comprobar que el guion sigue", async () => {
            await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForLoadState("networkidle").catch(() => {});
            const v = await page.getByLabel("Guion").first().inputValue().catch(() => "");
            const ok = v.includes("cliente misterioso");
            mark(cIdx(/Tras recargar/), ok, ok ? "El guion recargado coincide." : "El guion no se recuperó tras recargar.");
            if (!ok) critical = "El guion se pierde al recargar.";
            return ok ? { state: "PASS", detail: "Guion recuperado tras recargar." } : { state: "FAIL", detail: "El guion no está tras recargar." };
          });
          await step("Encontrar el episodio en la biblioteca", async () => {
            await goto("/dashboard/audio-studio");
            const item = page.getByTestId("audio-library-item").filter({ hasText: title });
            const ok = (await item.count()) > 0;
            mark(cIdx(/biblioteca/), ok, ok ? "Aparece en «Biblioteca de audio»." : "No aparece en la biblioteca.");
            if (ok) { await item.first().click(); await page.waitForURL(/audio-studio\/[0-9a-f-]{36}/); }
            return ok ? { state: "PASS", detail: "Recuperado desde la biblioteca." } : { state: "FAIL", detail: "No aparece en la biblioteca." };
          });
        }
        break;
      }
      case "video-podcast-costo": {
        await step("Encontrar Podcast en el menú", async () => {
          await goto("/dashboard");
          const link = page.locator('a[href="/dashboard/podcast"]:visible').first();
          const ok = await link.isVisible().catch(() => false);
          mark(cIdx(/Encuentra Podcast/), ok, ok ? "Enlace visible." : "Sin enlace a Podcast.");
          if (!ok) return { state: "FAIL", detail: "No se ve «Podcast» en el menú." };
          await link.click(); await page.waitForURL(/\/dashboard\/podcast/); await page.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 30_000 });
          await metrics(200, 0);
          return { state: "PASS", detail: "Asistente abierto." };
        });
        await step("Avanzar el asistente hasta Producir", async () => {
          const W = page.getByTestId("podcast-wizard");
          const title = W.getByTestId("wizard-step-title");
          for (let i = 0; i < 6 && !/Producir/.test((await title.textContent()) ?? ""); i++) {
            const next = W.getByRole("button", { name: "Siguiente", exact: true });
            if (impatient) await next.dblclick().catch(() => {}); else await next.click().catch(() => {});
            await page.waitForTimeout(700);
            const t = (await title.textContent()) ?? "";
            if (/Contenido/.test(t)) {
              const tt = W.getByLabel("Título del episodio"); if (await tt.isVisible().catch(() => false) && !(await tt.inputValue())) await tt.fill("QA cliente misterioso");
              const g = W.getByLabel("Guion"); if (await g.isVisible().catch(() => false) && !(await g.inputValue())) await g.fill("Ana: Hola, prueba del cliente misterioso.\nLeo: Sin generar nada.");
            }
            if (/Estilo/.test(t)) { const only = W.getByLabel("Solo estudio y anfitriones (sin imágenes)"); if (await only.isVisible().catch(() => false)) await only.check().catch(() => {}); }
          }
          const t = (await title.textContent()) ?? "";
          mark(cIdx(/asistente avanza/), /Producir/.test(t), t);
          await metrics(200, 0);
          return /Producir/.test(t) ? { state: "PASS", detail: t } : { state: "FAIL", detail: `Se quedó en «${t}».` };
        });
        await step("Recargar y conservar el borrador", async () => {
          await page.reload(); await page.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 30_000 });
          const t = (await page.getByTestId("wizard-step-title").textContent()) ?? "";
          mark(cIdx(/Recargar conserva/), /Producir|Paso 4/.test(t), t);
          return /Producir|Paso 4/.test(t) ? { state: "PASS", detail: t } : { state: "FAIL", detail: `Tras recargar: «${t}».` };
        });
        await step("Ver el costo antes de autorizar", async () => {
          const est = page.getByTestId("wizard-estimate");
          await est.locator("table").waitFor({ timeout: 30_000 }).catch(() => {});
          const txt = (await est.textContent().catch(() => "")) ?? "";
          const providers = ["ElevenLabs", "HeyGen", "GitHub Actions"].filter((p) => txt.includes(p));
          mark(cIdx(/costo por proveedor/), providers.length >= 2 && /Total/.test(txt), providers.join(", ") || "sin tabla de costos");
          const gen = page.getByRole("button", { name: "Generar episodio" });
          const disabled = await gen.isDisabled().catch(() => null);
          mark(cIdx(/Sin autorización/), disabled === true, disabled === true ? "«Generar episodio» deshabilitado sin la casilla." : "El botón no está deshabilitado.");
          if (disabled === false) critical = "Se puede generar sin autorizar el cargo.";
          await metrics(200, 0);
          return { state: providers.length >= 2 ? "PASS" : "FAIL", detail: `Proveedores en la tabla: ${providers.join(", ") || "ninguno"}. No se marcó «Autorizo el cargo».` };
        });
        break;
      }
      case "reel-formulario":
      case "longform-formulario": {
        const reel = mission.id === "reel-formulario";
        await step(reel ? "Abrir Nuevo video y elegir Reel" : "Abrir Nuevo video de YouTube", async () => {
          const m = await goto(reel ? "/dashboard/new" : "/dashboard/long-form/new");
          const ok = !!m.httpStatus && m.httpStatus < 400;
          mark(0, ok, `HTTP ${m.httpStatus} ${new URL(m.url).pathname}`);
          if (reel) { const r = page.getByText("Reel", { exact: true }).first(); const v = await r.isVisible().catch(() => false); if (v) await r.click().catch(() => {}); mark(1, v, v ? "Opción Reel visible." : "No se ve la opción Reel."); }
          return ok ? { state: "PASS", detail: new URL(m.url).pathname } : { state: "FAIL", detail: `HTTP ${m.httpStatus}` };
        });
        await step("Escribir la idea sin crear nada", async () => {
          const field = page.getByLabel(/¿De qué trata tu video\?|Tu idea|Tema/).first();
          const v = await field.isVisible().catch(() => false);
          if (v) await field.fill(reel ? "Tres misterios del universo" : "Las líneas de Nazca");
          mark(reel ? 2 : 1, v, v ? "El campo acepta texto." : "No se encontró el campo de idea.");
          const m = await metrics(200, 0);
          mark(reel ? 3 : 2, m.costVisible, m.costVisible ? "Hay costo o presupuesto visible antes de crear." : "No se ve costo antes de crear.");
          return { state: v ? "PASS" : "FAIL", detail: `Costo visible: ${m.costVisible ? "sí" : "no"}. No se pulsó crear ni generar (gratuito).` };
        });
        break;
      }
      case "biblioteca-recuperar": {
        await step("Abrir Mis proyectos", async () => {
          const m = await goto("/dashboard");
          const list = page.locator("#proyectos, [aria-label='Filtro de la biblioteca']").first();
          const ok = await list.isVisible().catch(() => false) || /Mis proyectos/.test(await page.locator("body").innerText());
          mark(0, ok, ok ? "Se ve «Mis proyectos»." : "No se ve la lista.");
          return { state: ok ? "PASS" : "FAIL", detail: `HTTP ${m.httpStatus}` };
        });
        await step("Abrir un proyecto", async () => {
          const link = page.locator("a[href^='/dashboard/videos/'], a[href^='/dashboard/podcast/'], a[href^='/dashboard/audio-studio/']").first();
          if (!(await link.isVisible().catch(() => false))) { mark(1, false, "La cuenta QA no tiene proyectos que abrir."); return { state: "SKIP", detail: "Sin proyectos en la cuenta QA." }; }
          await link.click(); await page.waitForLoadState("domcontentloaded");
          const m = await metrics(200, 0);
          mark(1, m.errorsVisible.length === 0, page.url().replace(job.target.url, ""));
          const mediaEl = page.locator("video, audio").first();
          if (!(await mediaEl.count())) { mark(2, false, "El proyecto abierto no tiene archivo."); mark(3, false, "Sin archivo que descargar."); return { state: "PASS", detail: "Proyecto abierto (sin archivo)." }; }
          const played = await mediaEl.evaluate(async (el: HTMLMediaElement) => { el.muted = true; try { await el.play(); await new Promise((r) => setTimeout(r, 1500)); return { ok: el.currentTime > 0 && !el.error, t: el.currentTime, d: el.duration }; } catch (e) { return { ok: false, t: 0, d: el.duration, err: String(e) }; } });
          mark(2, played.ok, JSON.stringify(played));
          const dl = page.getByRole("link", { name: /Descargar/ }).first();
          if (await dl.isVisible().catch(() => false)) {
            const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), dl.click()]);
            const file = path.join(out, `descarga-${(d.suggestedFilename() || "archivo").replace(/[^\w.-]/g, "_")}`);
            await d.saveAs(file);
            media.push(await probe(file, mission.requestedSeconds ?? null, true));
            mark(3, true, path.basename(file));
          } else mark(3, false, "No hay enlace de descarga.");
          return { state: "PASS", detail: "Proyecto abierto y revisado." };
        });
        break;
      }
      case "command-center-panel": {
        await step("Abrir el Command Center", async () => {
          const m = await goto("/dashboard/command-center");
          mark(0, !!m.httpStatus && m.httpStatus < 500, `HTTP ${m.httpStatus}`);
          const text = await page.locator("body").innerText();
          const clear = /Command Center|acceso|permiso|no autorizado/i.test(text);
          mark(1, clear, clear ? "Panel o mensaje de acceso visible." : "Pantalla sin explicación.");
          return { state: clear ? "PASS" : "FAIL", detail: `HTTP ${m.httpStatus}` };
        });
        break;
      }
      default:
        await step("Misión no soportada por el worker real", async () => ({ state: "SKIP", detail: `La misión ${mission.id} todavía no tiene recorrido real; queda NO EVALUADA.` }));
    }
  }

  async function probe(file: string, requested: number | null, inLibrary: boolean | null): Promise<MediaCheck> {
    const ffprobe = env.MS_FFPROBE || "ffprobe", ffmpeg = env.MS_FFMPEG || "ffmpeg";
    let container: string | null = null, duration: number | null = null, decodeOk = false, mean: number | null = null;
    try {
      const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", file]);
      const f = JSON.parse(stdout).format ?? {}; container = f.format_name ?? null; duration = f.duration ? Number(f.duration) : null;
      const dec = await run(ffmpeg, ["-v", "error", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { maxBuffer: 1 << 24 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "error" }));
      const m = /mean_volume:\s*(-?[\d.]+) dB/.exec((dec as { stderr: string }).stderr ?? ""); mean = m ? Number(m[1]) : null;
      decodeOk = !/error/i.test(((dec as { stderr: string }).stderr ?? "").replace(/mean_volume|max_volume/g, ""));
    } catch (e) { act("medición", e instanceof Error ? e.message : String(e)); }
    return mediaCheck({ file: path.basename(file), container, durationSeconds: duration, decodeOk, requestedSeconds: requested, meanVolumeDb: mean, inLibrary });
  }

  // Criterios de la misión de cuenta que dependen del cierre y la vuelta.
  if (mission.id === "cuenta-navegacion") {
    const s = (re: RegExp) => steps.find((x) => re.test(x.name));
    const logout = s(/Cerrar sesión/), back = s(/Volver a entrar/);
    if (logout) mark(criteria.findIndex((c) => /Cerrar sesión/.test(c.text)), logout.state === "PASS", logout.detail);
    if (back) mark(criteria.findIndex((c) => /Volver a entrar/.test(c.text)), back.state === "PASS", back.detail);
  }

  clearInterval(beat);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  act("navegador", "cerrado");

  const findings = findingsFrom(mission.product, job.profile, pages, steps, media);
  if (overlayNotes.length) findings.push({ severity: "P2", product: mission.product, screen: new URL(overlayNotes[0].url).pathname,
    fact: `Un recorrido de bienvenida cubre toda la pantalla (también «Salir» y el menú) y no deja pulsar nada hasta omitirlo; apareció ${overlayNotes.length} vez/veces.`,
    interpretation: "Un cliente que solo quiere salir o ir a otro producto queda atrapado; parece que la página no responde.",
    recommendation: "Dejar la cabecera (menú y «Salir») utilizable mientras se muestra el recorrido, o mostrarlo como un aviso que no bloquee.",
    evidence: steps.find((x) => x.screenshot)?.screenshot ?? null });
  const verdict = verdictFor(mission.product, criteria, findings, critical);
  const worked = steps.filter((s) => s.state === "PASS").map((s) => s.name);
  const failed = steps.filter((s) => s.state === "FAIL").map((s) => `${s.name}: ${s.detail}`);
  const report: LiveReport = {
    version: LIVE_VERSION, jobId, scope: "atomivid-real", target: job.target, observedSha, missionId: mission.id, product: mission.product, profile: job.profile, mode: job.mode, authenticated,
    browser: { sessionId, version: browser.version(), freshContext: fresh, viewport: { width: vp.width, height: vp.height } },
    startedAt, finishedAt: nowIso(), spendUsd: 0, steps, pages, media, findings, verdict,
    plain: {
      doing: `Un cliente «${job.profile}» recorrió ${PRODUCT_LABEL[mission.product]} en ${job.target.url} con un navegador nuevo (${vp.width}×${vp.height}).`,
      found: findings.length ? `${findings.length} problema(s): ${findings.filter((f) => f.severity <= "P1").length} importantes.` : verdict.coverage === "EVALUADO" ? "No encontró problemas medibles." : "No pudo completar la misión, así que no califica el producto.",
      worked, failed,
      simplify: findings.filter((f) => f.severity !== "P0").map((f) => f.recommendation).filter((x, i, a) => a.indexOf(x) === i).slice(0, 6),
      needsAuthorization: [humanGate, job.mode === "real" ? "El modo real necesita presupuesto aprobado por Hans (hoy USD 0)." : null].filter((x): x is string => !!x),
    },
    humanGate,
    actionsLog: "actions.log",
  };
  const logText = redact(log.map((e) => `${e.t}\t${e.action}\t${e.detail}`).join("\n"));
  await store.putEvidence(jobId, "actions.log", logText, "text/plain").catch(() => "");
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await store.putReport(jobId, JSON.parse(redact(JSON.stringify(report))));
  const state: JobStatus["state"] = !authenticated && humanGate ? "bloqueada" : steps.length === 0 ? "error" : "terminada";
  await save({ state, stage: state === "bloqueada" ? `Bloqueada: ${humanGate}` : "Informe listo", finishedAt: nowIso(), error: state === "error" ? "El recorrido no llegó a ningún paso." : null,
    result: { verdict: verdict.verdict, score: verdict.score, coverage: verdict.coverage, findings: findings.length, critical: verdict.criticalBlock, humanGate } });
  console.log(`[mystery-shopper] ${jobId}: ${state} · ${verdict.verdict} · nota ${verdict.score ?? "NO EVALUADO"} · ${steps.length} pasos · ${findings.length} hallazgos`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error("[mystery-shopper] fallo del worker", redact(e instanceof Error ? e.stack ?? e.message : String(e))); process.exit(1); });

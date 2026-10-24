/**
 * Aceptación de usuario desde la interfaz (T-20261024 QA-INTERFAZ, Claude). USD 0, todo en 127.0.0.1: Next local + PostgREST
 * + gateway + mocks del arnés (scripts/harness/e2e/infra). next-intercept.cjs rechaza y registra toda salida no local.
 * Dos dispositivos: Samsung (390x844, táctil) y escritorio (1440x900). Flujos: Reel, Podcast estándar, YouTube Long Form.
 * Cada comprobación es una aserción; «NO PROBADO» se declara aparte (nunca cuenta como PASS). Exit ≠ 0 si falla alguna.
 *
 *   E2E_OUT=<dir> E2E_DIR=<dir del arnés> HARNESS_PG_URL=… node acceptance.cjs
 */
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { Client } = require(process.env.HARNESS_PG_MODULE ?? "pg");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "qa-aceptacion-out"); const HD = path.resolve(process.env.E2E_DIR ?? "."); const LOGS = path.join(HD, "logs"), STORE = path.join(HD, "storage");
fs.mkdirSync(OUT, { recursive: true });
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const DEVICES = {
  samsung: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36" },
  desktop: { viewport: { width: 1440, height: 900 } },
};
const checks = [], untested = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
/** Defecto conocido y documentado (docs/qa-aceptacion/RECRAFT-MOVIL-P1.md): XFAIL mientras exista, sin bloquear la batería;
 * XPASS cuando se corrija (avisa de retirarlo de aquí). La prueba que FALLA mientras exista es recraft-mobile-repro.cjs. */
const known = [];
const knownDefect = (id, name, ok, detail) => { known.push({ id, name, fixed: !!ok, detail }); console.log(`${ok ? "XPASS" : "XFAIL"}  [${id}] ${name}${ok ? "  (corregido: retirar de los defectos conocidos)" : "  " + JSON.stringify(detail ?? null).slice(0, 300)}`); };
const notTested = (name, why) => { untested.push({ name, why }); console.log(`NO PROBADO  ${name} — ${why}`); };
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const jsonl = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FALSE_SUCCESS = /(video|episodio|guion)\s+(está\s+)?list[oa]|¡listo!|completad[oa] con éxito/i;
let db, browser;

async function ctxFor(dev, tag) {
  const ctx = await browser.newContext({ ...DEVICES[dev], acceptDownloads: true, locale: "es-MX" });
  const p = await ctx.newPage(); p.setDefaultTimeout(90000); p.tag = `${dev}-${tag}`; return { ctx, p };
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${p.tag}-${n}.png`), fullPage: true }).catch(() => {});
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 4000 }).catch(() => {});
/** Sin desbordamiento horizontal (el texto no queda cortado a la derecha en el teléfono). */
const overflow = (p) => p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
async function login(p) {
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
}
const count = async (sql, args) => Number((await db.query(sql, args)).rows[0].n);

async function publicPages(dev) {
  const { ctx, p } = await ctxFor(dev, "publico");
  for (const [route, name] of [["/", "inicio"], ["/login", "login"], ["/register", "registro"]]) {
    const r = await p.goto(`${BASE}${route}`); await shot(p, name); const o = await overflow(p);
    check(`[${dev}] ${route} responde 2xx y sin scroll horizontal`, r && r.status() < 400 && o.sw <= o.iw + 1, { status: r?.status(), ...o });
  }
  await p.goto(`${BASE}/dashboard`); await p.waitForLoadState("networkidle").catch(() => {});
  check(`[${dev}] /dashboard sin sesión redirige a login (no muestra datos)`, /\/login/.test(p.url()), { url: p.url() });
  // Error de autenticación visible y sin revelar si la cuenta existe.
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", "contraseña-incorrecta");
  await p.locator("form button[type=submit]").last().click(); await sleep(2500); await shot(p, "login-error");
  const body = await p.locator("body").innerText();
  check(`[${dev}] login con contraseña incorrecta: queda en login con mensaje de error`, /\/login/.test(p.url()) && /incorrect|inválid|no válid|error|credenciales/i.test(body), { url: p.url(), body: body.slice(0, 300) });
  await ctx.close();
}

async function reel(dev, full) {
  const { ctx, p } = await ctxFor(dev, "reel"); await login(p); await skipTour(p);
  await shot(p, "01-panel"); let o = await overflow(p);
  check(`[${dev}] panel: sin scroll horizontal`, o.sw <= o.iw + 1, o);
  await p.goto(`${BASE}/dashboard/new`); await skipTour(p);
  await p.getByText("Reel / Short").click();
  const topic = `QA aceptación ${dev} pulpo tres corazones ${Date.now()}`;
  // (a) Validación: sin tema no se crea nada.
  const n0 = await count("select count(*) n from public.video_requests where user_id=$1", [OWNER.id]);
  await p.getByRole("button", { name: "Crear solicitud" }).click().catch(() => {}); await sleep(1500); await shot(p, "02-sin-tema");
  check(`[${dev}] Reel sin tema: no se crea ninguna solicitud`, (await count("select count(*) n from public.video_requests where user_id=$1", [OWNER.id])) === n0);
  // (b) Opción por defecto Recraft sin estilo: error claro, sin solicitud ni cobro.
  await p.fill("#topic", topic); await p.selectOption("#style", { label: "Curiosidades" }).catch(() => {}); await p.getByText("30s", { exact: true }).click().catch(() => {});
  const recraftDefault = await p.locator("input[name=reel_image_source][value=recraft]").isChecked().catch(() => false);
  if (recraftDefault) {
    const w = await overflow(p);
    const name = `[${dev}] Reel con Recraft visible: el ancho de diseño sigue siendo el del dispositivo (sin zoom-out en el teléfono)`;
    if (dev === "samsung") { await shot(p, "02b-recraft-ancho"); knownDefect("P1-1", name, w.iw === DEVICES[dev].viewport.width, { innerWidth: w.iw, device: DEVICES[dev].viewport.width }); }
    else check(name, w.iw === DEVICES[dev].viewport.width, { innerWidth: w.iw, device: DEVICES[dev].viewport.width });
  }
  if (recraftDefault && dev === "desktop") {
    await p.getByRole("button", { name: "Crear solicitud" }).click(); await sleep(2500); await shot(p, "03-recraft-sin-estilo");
    const t = await p.locator("body").innerText();
    check(`[${dev}] Reel con Recraft (opción por defecto) sin estilo: error explicado, 0 solicitudes`, /style_id|referencia/.test(t) && (await count("select count(*) n from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])) === 0, { url: p.url() });
    await p.goto(`${BASE}/dashboard/new`); await skipTour(p); await p.getByText("Reel / Short").click();
    await p.fill("#topic", topic); await p.selectOption("#style", { label: "Curiosidades" }).catch(() => {}); await p.getByText("30s", { exact: true }).click().catch(() => {});
  }
  await p.locator("input[name=reel_image_source][value=default]").check().catch(() => {});
  const w2 = await overflow(p);
  check(`[${dev}] Reel con «Material de archivo»: ancho de diseño = dispositivo`, w2.iw === DEVICES[dev].viewport.width, w2);
  await p.getByRole("button", { name: "Crear solicitud" }).click(); await p.waitForURL(/created=1/); await shot(p, "04-creada");
  const rows = (await db.query("select * from public.video_requests where user_id=$1 and topic=$2", [OWNER.id, topic])).rows;
  check(`[${dev}] Reel: el formulario crea exactamente 1 solicitud`, rows.length === 1, rows.length);
  const id = rows[0]?.id; if (!id) { await ctx.close(); return null; }
  await skipTour(p);
  await p.getByRole("button", { name: "Generar guion" }).first().click(); await p.waitForURL(new RegExp(`/dashboard/review/${id}`));
  await p.getByRole("button", { name: "Generar video final" }).waitFor(); await shot(p, "05-revision"); o = await overflow(p);
  check(`[${dev}] Reel: revisión del guion visible (preflight antes de render), sin scroll horizontal`, o.sw <= o.iw + 1, o);
  if (!full) { await ctx.close(); return id; }
  await p.getByRole("button", { name: "Generar video final" }).click(); await sleep(3000); await shot(p, "06-en-proceso");
  const mid = await p.locator("main").innerText().catch(() => "");
  // Solo la tarjeta de ESTE Reel: el historial muestra también videos anteriores ya terminados.
  const at = mid.indexOf(topic), card = at >= 0 ? mid.slice(at, at + topic.length + 120) : mid;
  check(`[${dev}] Reel en proceso: su tarjeta no anuncia «listo» antes de tiempo`, !FALSE_SUCCESS.test(card) || (await db.query("select status from public.video_requests where id=$1", [id])).rows[0].status === "completed", card.slice(0, 200));
  let v; const t0 = Date.now(); while (Date.now() - t0 < 15 * 60000) { v = (await db.query("select * from public.video_requests where id=$1", [id])).rows[0]; if (["completed", "failed"].includes(v.status)) break; await sleep(4000); }
  check(`[${dev}] Reel: termina «completed» con el worker de prueba`, v.status === "completed", { status: v.status, err: v.error_message });
  await ctx.close(); return v.status === "completed" ? id : null;
}

async function result(dev, id) {
  const { ctx, p } = await ctxFor(dev, "resultado"); await login(p);
  await p.goto(`${BASE}/dashboard/videos/${id}`); await skipTour(p); await shot(p, "01-resultado"); const o = await overflow(p);
  check(`[${dev}] resultado: <video> presente y sin scroll horizontal`, (await p.locator("video").count()) > 0 && o.sw <= o.iw + 1, o);
  const st = await p.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; try { await v.play(); } catch (e) { return { err: String(e) }; } const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 2500)); return { adv: v.currentTime - t0, err: v.error && v.error.code, w: v.videoWidth, h: v.videoHeight }; });
  if (st.err || !(st.adv > 1)) notTested(`[${dev}] reproducción H.264 en el navegador`, `el Chromium local no decodifica H.264 (${JSON.stringify(st)}); la reproducción se valida con ffprobe del archivo descargado`);
  else check(`[${dev}] reproducción: el tiempo avanza`, st.adv > 1, st);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("link", { name: /Descargar video/ }).click()]);
  const f = path.join(OUT, `${dev}-descarga-${id}.mp4`); await dl.saveAs(f);
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f]).toString());
  const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio");
  const stored = path.join(STORE, "videos", id, "attempt-1", "final.mp4");
  check(`[${dev}] descarga desde la UI: MP4 H.264 + AAC idéntico al almacenado`, vs?.codec_name === "h264" && as?.codec_name === "aac" && fs.existsSync(stored) && sha(f) === sha(stored), { v: vs?.codec_name, a: as?.codec_name });
  // Enlace firmado: caduca (token con exp) y la página genera uno nuevo al volver a abrirla.
  const href = await p.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
  await p.reload(); await skipTour(p); const href2 = await p.getByRole("link", { name: /Descargar video/ }).getAttribute("href");
  check(`[${dev}] enlace de descarga firmado y renovado al recargar`, /token=|sign/.test(href ?? "") && href !== href2, { href: (href ?? "").slice(0, 80) });
  await ctx.close();
}

async function longForm(dev) {
  const { ctx, p } = await ctxFor(dev, "longform"); await login(p);
  await p.goto(`${BASE}/dashboard/long-form/new`); await skipTour(p); await shot(p, "01-formulario");
  let o = await overflow(p); check(`[${dev}] Long Form: formulario sin scroll horizontal`, o.sw <= o.iw + 1, o);
  const n0 = await count("select count(*) n from public.video_requests where user_id=$1", [OWNER.id]);
  await p.getByRole("button", { name: "Crear y revisar guion" }).click().catch(() => {}); await sleep(1500);
  check(`[${dev}] Long Form sin tema: no se crea nada`, (await count("select count(*) n from public.video_requests where user_id=$1", [OWNER.id])) === n0);
  const topic = `QA aceptación ${dev} el canal de Panamá ${Date.now()}`;
  await p.fill("input[name=topic]", topic); await p.selectOption("select[name=language]", "es"); await p.fill("input[name=duration_minutes]", "10");
  await p.getByRole("button", { name: "Crear y revisar guion" }).click(); await p.waitForURL((u) => !String(u).includes("/long-form/new"), { timeout: 60000 }).catch(() => {});
  await sleep(4000); await shot(p, "02-tras-crear");
  const text = await p.locator("main").innerText().catch(() => "");
  // Solo la tarjeta de ESTE documental (el historial muestra también videos anteriores ya terminados).
  const at = text.indexOf(topic), card = at >= 0 ? text.slice(at, at + topic.length + 120) : "";
  check(`[${dev}] Long Form: tras crear, su tarjeta muestra un estado en curso y ningún «listo» falso`, at >= 0 && !FALSE_SUCCESS.test(card) && /cola|prepar|guion|proceso/i.test(card), card || text.slice(0, 300));
  o = await overflow(p); check(`[${dev}] Long Form: página siguiente sin scroll horizontal`, o.sw <= o.iw + 1, o);
  notTested(`[${dev}] Long Form: confirmación de presupuesto → render → descarga`, "el guion documental real requiere el modelo (mock-anthropic no lo cubre); el ensayo completo con guion inyectado existe en scripts/harness/e2e/longform-rehearsal (e-run.cjs)");
  await ctx.close();
}

async function podcast(dev) {
  const { ctx, p } = await ctxFor(dev, "podcast"); await login(p);
  const r = await p.goto(`${BASE}/dashboard/podcast`); await skipTour(p); await shot(p, "01-formulario"); const o = await overflow(p);
  check(`[${dev}] Podcast: página disponible y sin scroll horizontal`, r && r.status() < 400 && o.sw <= o.iw + 1, { status: r?.status(), ...o });
  const n0 = await count("select count(*) n from public.podcast_episodes where user_id=$1", [OWNER.id]);
  await p.getByRole("button", { name: /Crear episodio/ }).click().catch(() => {}); await sleep(1500);
  check(`[${dev}] Podcast vacío: no se crea episodio`, (await count("select count(*) n from public.podcast_episodes where user_id=$1", [OWNER.id])) === n0);
  const title = `QA aceptación ${dev} ${Date.now()}`;
  await p.getByLabel("Título").fill(title).catch(() => {});
  const voicesAlert = await p.getByRole("alert").first().innerText({ timeout: 2000 }).catch(() => "");
  if (voicesAlert) {
    await p.locator("textarea").first().fill("Hola. Este es un episodio de prueba de aceptación. No se usa ningún proveedor real.").catch(() => {});
    const disabled = await p.getByRole("button", { name: /Crear episodio/ }).isDisabled();
    check(`[${dev}] Podcast sin voces disponibles (proveedor inalcanzable): aviso visible y creación bloqueada (falla cerrada)`, disabled, { alert: voicesAlert.slice(0, 160) });
    notTested(`[${dev}] Podcast: crear → narrar → descargar`, "en este banco no hay mock de ElevenLabs; se cubre con QA_BASE del arnés de podcast (scripts/harness/e2e/podcast/start.sh, puerto 3300)");
    await ctx.close(); return;
  }
  await p.locator("textarea").first().fill("Hola. Este es un episodio de prueba de aceptación. No se usa ningún proveedor real.").catch(() => {});
  await p.getByRole("button", { name: /Crear episodio/ }).click().catch(() => {});
  const created = await p.waitForURL(/\/dashboard\/podcast\/[0-9a-f-]{36}$/, { timeout: 30000 }).then(() => true).catch(() => false);
  // La estimación se pinta tras hidratar la página del episodio: se espera al texto, no se lee al instante.
  const estimate = created && await p.getByText(/USD|costo estimado|estimaci/i).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  await shot(p, "02-episodio");
  check(`[${dev}] Podcast: el formulario crea el episodio y muestra su estimación`, created && estimate, { url: p.url(), main: (await p.locator("main").innerText().catch(() => "")).slice(0, 200) });
  if (created) {
    const btn = p.getByRole("button", { name: /Generar narración/ });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click(); await sleep(6000); await p.reload(); await shot(p, "03-tras-generar");
      const id = p.url().split("/").pop(); const e = (await db.query("select status, audio_path, error from public.podcast_episodes where id=$1", [id])).rows[0];
      const t = await p.locator("main").innerText().catch(() => "");
      const consistent = e.status === "ready" ? !!e.audio_path : !/Descargar episodio/.test(t);
      check(`[${dev}] Podcast: la UI coincide con el estado real (sin falso éxito); estado=${e.status}`, consistent, { status: e.status, error: (e.error ?? "").slice(0, 160) });
      if (e.status === "ready") {
        const [d] = await Promise.all([p.waitForEvent("download"), p.getByText(/Descargar episodio/).first().click()]);
        const f = path.join(OUT, `${dev}-podcast-${id}.m4a`); await d.saveAs(f);
        const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "json", f]).toString());
        check(`[${dev}] Podcast: descarga desde la UI con audio válido`, Number(pr.format?.duration) > 1 && pr.streams?.some((s) => s.codec_name), pr);
      }
    } else notTested(`[${dev}] Podcast: generar narración`, "el botón no está disponible en esta configuración local");
  }
  await ctx.close();
}

(async () => {
  db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  const egress0 = jsonl(path.join(LOGS, "egress.jsonl")).length;
  const anth0 = jsonl(path.join(LOGS, "anthropic.jsonl")).length;
  try {
    const FLOWS = (process.env.QA_FLOWS ?? "public,reel,longform,podcast").split(",");
    if (FLOWS.includes("public")) for (const dev of ["samsung", "desktop"]) await publicPages(dev);
    if (FLOWS.includes("reel")) {
      const id = await reel("desktop", true).catch((e) => { check("[desktop] Reel completo sin excepción", false, String(e).slice(0, 300)); return null; });
      await reel("samsung", false).catch((e) => check("[samsung] Reel hasta la revisión sin excepción", false, String(e).slice(0, 300)));
      if (id) for (const dev of ["samsung", "desktop"]) await result(dev, id).catch((e) => check(`[${dev}] resultado/descarga sin excepción`, false, String(e).slice(0, 300)));
    }
    if (FLOWS.includes("longform")) for (const dev of ["samsung", "desktop"]) await longForm(dev).catch((e) => check(`[${dev}] Long Form sin excepción`, false, String(e).slice(0, 300)));
    if (FLOWS.includes("podcast")) for (const dev of ["samsung", "desktop"]) await podcast(dev).catch((e) => check(`[${dev}] Podcast sin excepción`, false, String(e).slice(0, 300)));
  } finally {
    const egress = jsonl(path.join(LOGS, "egress.jsonl")).slice(egress0);
    // next-intercept.cjs: «dispatch» = despacho al worker local; «egress_refused» = salida externa BLOQUEADA (nunca enviada).
    const refused = egress.filter((e) => e.kind === "egress_refused"), other = egress.filter((e) => e.kind !== "egress_refused" && e.kind !== "dispatch");
    const PROVIDERS = /anthropic|openai|elevenlabs|heygen|fal\.(ai|run)|recraft|pexels|pixabay|runway|googleapis|beatoven|stripe/i;
    check("0 peticiones a proveedores pagos (ninguna salió; las salidas externas se bloquean y registran)", refused.filter((e) => PROVIDERS.test(e.host ?? "")).length === 0 && other.length === 0, { refused: [...new Set(refused.map((e) => e.host))], other: other.slice(0, 3) });
    check("render: solo despachos al worker LOCAL de prueba (0 renders pagados)", egress.filter((e) => e.kind === "dispatch").every((e) => e.body?.event_type), egress.filter((e) => e.kind === "dispatch").length);
    notTested("producción atomicvid.app con sesión", "sin credenciales autorizadas; ver la auditoría pública de solo lectura (workflow qa-aceptacion-publica)");
    const summary = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length, untestedCount: untested.length, knownDefects: known, anthropicMockCalls: jsonl(path.join(LOGS, "anthropic.jsonl")).length - anth0, checks, untested };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`RESULTADO ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.untestedCount} NO PROBADO / ${known.filter((k) => !k.fixed).length} XFAIL`);
    await browser.close(); await db.end(); process.exit(summary.fail ? 1 : 0);
  }
})();

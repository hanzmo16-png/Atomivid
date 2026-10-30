/**
 * M3 — auditoría de experiencia móvil + escritorio (USD 0, todo en 127.0.0.1; mismo arnés que acceptance.cjs).
 * Recorre las pantallas del producto en 4 viewports (Android 360x800 y 412x915 con UA móvil y táctil; escritorio 1366x768
 * y 1440x900) y mide, por pantalla:
 *   - ancho de diseño (innerWidth) = ancho del dispositivo (si crece, el teléfono aleja la página: «zoom-out»);
 *   - sin scroll horizontal del documento;
 *   - elementos visibles que se salen por la derecha (fuera de contenedores con scroll propio);
 *   - objetivos táctiles < 24x24 CSS px (WCAG 2.5.8; informativo, no falla).
 * Solo lectura: abre páginas y formularios, no envía nada (los flujos que crean datos están en acceptance.cjs).
 * Los defectos conocidos y fuera de este carril (P1-1 Recraft) se registran como XFAIL y no bloquean.
 *
 *   E2E_OUT=<dir> HARNESS_PG_URL=… node m3-mobile-audit.cjs     (lanzado por infra/run-e2e.sh con E2E_SCRIPT)
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { Client } = require(process.env.HARNESS_PG_MODULE ?? "pg");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "m3-out"); fs.mkdirSync(OUT, { recursive: true });
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "android-360": { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: ANDROID_UA },
  "android-412": { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: ANDROID_UA },
  "desktop-1366": { viewport: { width: 1366, height: 768 } },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
};
const ONLY = (process.env.M3_DEVICES ?? Object.keys(DEVICES).join(",")).split(",");
const SHOTS = process.env.M3_SHOTS !== "0";
const checks = [], known = [], untested = [], tapInfo = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 500)}`); return !!ok; };
const knownDefect = (id, name, ok, detail) => { known.push({ id, name, fixed: !!ok, detail }); console.log(`${ok ? "XPASS" : "XFAIL"}  [${id}] ${name}${ok ? "  (corregido)" : "  " + JSON.stringify(detail ?? null).slice(0, 300)}`); };
const notTested = (name, why) => { untested.push({ name, why }); console.log(`NO PROBADO  ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 2500 }).catch(() => {});

/** Mide el desbordamiento horizontal y quién lo causa. */
const measure = (p) => p.evaluate(() => {
  const iw = window.innerWidth, sw = document.documentElement.scrollWidth;
  const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };
  const els = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const s = getComputedStyle(el); if (s.visibility === "hidden" || s.display === "none" || s.position === "fixed") continue;
    if (r.right > iw + 1 && !clipped(el)) els.push([el, r]);
  }
  // Solo los más profundos (los que no contienen otro elemento que también se sale), para no listar sus ancestros.
  const leaves = els.filter(([el]) => !els.some(([x]) => x !== el && el.contains(x))).slice(0, 6).map(([el, r]) => ({
    el: el.tagName.toLowerCase() + (el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : "") + (el.id ? `#${el.id}` : ""),
    cls: (el.getAttribute("class") || "").slice(0, 80), right: Math.round(r.right), w: Math.round(r.width), text: (el.textContent || "").trim().slice(0, 60) }));
  return { iw, sw, offenders: leaves, n: els.length };
});
const taps = (p) => p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("a[href],button,select,input:not([type=hidden]),[role=button],summary")) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const s = getComputedStyle(el); if (s.visibility === "hidden" || s.display === "none") continue;
    // Excepción WCAG 2.5.8 «en línea»: enlaces dentro de un párrafo de texto.
    if (el.tagName === "A" && el.closest("p,li") && s.display === "inline") continue;
    // Radios y casillas: cuenta su <label> si la tiene (área real de toque).
    let w = r.width, h = r.height; const lab = el.closest("label"); if (lab && /^(radio|checkbox)$/.test(el.type)) { const lr = lab.getBoundingClientRect(); w = lr.width; h = lr.height; }
    if (w < 24 || h < 24) out.push({ el: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ""), text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 40), w: Math.round(w), h: Math.round(h) });
  }
  return out;
});

/** Hit-test en 5 puntos de cada control visible dentro de la pantalla; se ignora <nextjs-portal> (indicador de `next dev`). */
const occluded = (p) => p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("a[href],button,select,input:not([type=hidden]),summary")) {
    const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
    const s = getComputedStyle(el); if (s.visibility === "hidden" || s.display === "none" || s.pointerEvents === "none") continue;
    const y = r.top + r.height / 2;
    for (const [x, yy] of [[r.left + r.width / 2, y], [r.left + 4, y], [r.right - 4, y], [r.left + r.width / 2, r.top + 3], [r.left + r.width / 2, r.bottom - 3]]) {
      const h = document.elementFromPoint(x, yy); if (!h || el.contains(h) || h.contains(el) || h.tagName === "NEXTJS-PORTAL") continue;
      // Solo cuenta lo que FLOTA (position: fixed) encima: una cabecera o barra sticky que tapa contenido al desplazarse es lo esperado.
      let fixed = false; for (let a = h; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).position === "fixed") { fixed = true; break; }
      if (!fixed) continue;
      const lab = el.closest("label"); if (lab && lab.contains(h)) continue;
      out.push({ el: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40), by: `${h.tagName.toLowerCase()}「${(h.getAttribute("aria-label") || h.textContent || "").trim().slice(0, 30)}」` }); break;
    }
  }
  return out;
});

async function audit(p, dev, label, opts = {}) {
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}); await sleep(400);
  const m = await measure(p); const vw = DEVICES[dev].viewport.width;
  if (SHOTS) await p.screenshot({ path: path.join(OUT, `${dev}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`) }).catch(() => {});
  const ok = m.iw === vw && m.sw <= m.iw + 1 && m.n === 0;
  const name = `[${dev}] ${label}: ancho de diseño = dispositivo, sin scroll horizontal ni contenido cortado`;
  const detail = { device: vw, innerWidth: m.iw, scrollWidth: m.sw, offenders: m.offenders, url: p.url().replace(BASE, "") };
  if (opts.known && DEVICES[dev].isMobile) knownDefect(opts.known, name, ok, detail); else check(name, ok, detail);
  if (DEVICES[dev].isMobile) { const t = await taps(p); if (t.length) tapInfo.push({ dev, page: label, small: t.slice(0, 8), n: t.length }); }
  // Ningún botón/enlace visible queda tapado por un elemento flotante (fixed) en arriba, medio y final de la página.
  const covered = [];
  for (const frac of [0, 0.5, 1]) {
    await p.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), frac); await sleep(250);
    covered.push(...await occluded(p));
  }
  await p.evaluate(() => window.scrollTo(0, 0));
  const uniq = [...new Map(covered.map((c) => [c.el + c.text + c.by, c])).values()];
  check(`[${dev}] ${label}: ningún botón o enlace visible queda tapado por un elemento flotante`, uniq.length === 0, uniq.slice(0, 4));
  return m;
}

async function login(p) {
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
  await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
}

(async () => {
  const db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  const q1 = async (sql, a = []) => (await db.query(sql, a)).rows[0];
  // Datos ya creados por acceptance.cjs / ensayos previos del arnés (no se crea nada aquí).
  const done = await q1("select id from public.video_requests where user_id=$1 and status='completed' and mode='visual' order by created_at desc limit 1", [OWNER.id]).catch(() => null);
  const review = await q1("select id from public.video_requests where user_id=$1 and mode='visual' order by created_at desc limit 1", [OWNER.id]).catch(() => null);
  const lf = await q1("select id from public.video_requests where user_id=$1 and mode='long_form' order by created_at desc limit 1", [OWNER.id]).catch(() => null);
  const ep = await q1("select id from public.podcast_episodes where user_id=$1 order by created_at desc limit 1", [OWNER.id]).catch(() => null);
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  try {
    for (const dev of ONLY) {
      const ctx = await browser.newContext({ ...DEVICES[dev], locale: "es-MX", acceptDownloads: true }); const p = await ctx.newPage(); p.setDefaultTimeout(60000);
      for (const [route, label] of [["/", "inicio"], ["/login", "login"], ["/register", "registro"], ["/forgot-password", "recuperar contraseña"], ["/terms", "términos"], ["/privacy", "privacidad"]]) {
        await p.goto(`${BASE}${route}`); await audit(p, dev, label);
      }
      await login(p); await skipTour(p);
      await audit(p, dev, "panel / historial");
      if (DEVICES[dev].isMobile) {
        // Navegación móvil (Simple UX 1.0): «Crear» siempre a la vista y un menú compacto con Mis proyectos, Facturación,
        // Mi cuenta y Ayuda (sin barra horizontal cortada ni herramientas internas).
        const visible = () => p.evaluate(() => [...document.querySelectorAll("header a[href]")].filter((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== "hidden"; }).map((a) => a.getAttribute("href")));
        const crear = (await visible()).includes("/dashboard#crear");
        await p.locator('[data-testid="menu-movil"] summary').click(); await sleep(300);
        const nav = await visible();
        check(`[${dev}] navegación móvil: «Crear» visible y el menú abre Mis proyectos, Facturación, Mi cuenta y Ayuda`, crear && ["/dashboard", "/dashboard/billing", "/dashboard/cuenta", "/dashboard/ayuda"].every((h) => nav.includes(h)), nav);
        check(`[${dev}] navegación móvil: sin herramientas internas en el menú`, !nav.some((h) => /visual-test|command-center|admin/.test(h || "")), nav);
        await p.locator('[data-testid="menu-movil"] summary').click();
      }
      await p.goto(`${BASE}/dashboard/new`); await skipTour(p); await audit(p, dev, "nuevo video: tipo de contenido");
      const types = await p.evaluate(() => [...document.querySelectorAll("button,[role=radio],label")].map((b) => (b.textContent || "").trim()).filter((t) => /Reel|Avatar|Long|Podcast|Documental/i.test(t)).slice(0, 10));
      console.log(`INFO  [${dev}] tipos de contenido ofrecidos: ${JSON.stringify(types)}`);
      // Reel: Material de archivo (camino de producción hoy) y Recraft (P1-1, carril de Grok).
      if (await p.getByText("Reel / Short").count()) {
        await p.getByText("Reel / Short").first().click(); await sleep(600);
        await p.locator("input[name=reel_image_source][value=default]").check().catch(() => {});
        await audit(p, dev, "reel: formulario (material de archivo)");
        if (await p.locator("input[name=reel_image_source][value=recraft]").count()) { await p.locator("input[name=reel_image_source][value=recraft]").check(); await audit(p, dev, "reel: formulario (Recraft)", { known: "P1-1" }); }
      } else notTested(`[${dev}] formulario Reel`, "la opción «Reel / Short» no aparece para esta cuenta");
      await p.goto(`${BASE}/dashboard/new`); await skipTour(p);
      const avatar = p.getByText(/Video con avatar/i).first();
      if (await avatar.count()) {
        await avatar.click().catch(() => {}); await sleep(600); await audit(p, dev, "avatar: formulario");
      } else notTested(`[${dev}] formulario Avatar`, "la opción Avatar no aparece para esta cuenta en el entorno local");
      await p.goto(`${BASE}/dashboard/avatar/prepare`); await skipTour(p); await audit(p, dev, "avatar: preparar");
      await p.goto(`${BASE}/dashboard/long-form/new`); await skipTour(p); await audit(p, dev, "long form: formulario");
      if (lf) { await p.goto(`${BASE}/dashboard/long-form/configure/${lf.id}`); await skipTour(p); await audit(p, dev, "long form: configurar / presupuesto (Recraft por defecto)", { known: "P1-1" });
        if (await p.locator("input[name=image_source][value=default]").count()) { await p.locator("input[name=image_source][value=default]").check(); await audit(p, dev, "long form: configurar / presupuesto (material de archivo)"); } }
      else notTested(`[${dev}] Long Form configurar`, "no hay solicitud long_form en la BD local (correr antes acceptance.cjs)");
      await p.goto(`${BASE}/dashboard/podcast`); await skipTour(p); await audit(p, dev, "podcast: formulario");
      if (ep) { await p.goto(`${BASE}/dashboard/podcast/${ep.id}`); await skipTour(p); await audit(p, dev, "podcast: episodio (estimación)"); }
      else notTested(`[${dev}] Podcast episodio`, "no hay episodio en la BD local");
      await p.goto(`${BASE}/dashboard/billing`); await skipTour(p); await audit(p, dev, "facturación");
      if (review) { await p.goto(`${BASE}/dashboard/review/${review.id}`); await skipTour(p); await audit(p, dev, "reel: revisión del guion"); }
      if (done) {
        await p.goto(`${BASE}/dashboard/videos/${done.id}`); await skipTour(p); await audit(p, dev, "resultado del video");
        // Reproducción: el <video> cabe en la pantalla y su control de descarga es pulsable.
        const v = await p.evaluate(() => { const v = document.querySelector("video"); if (!v) return null; const r = v.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), vh: innerHeight, iw: innerWidth }; });
        check(`[${dev}] resultado: el reproductor cabe a lo ancho`, v && v.right <= v.iw + 1 && v.w > 0, v);
        const st = await p.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; try { await v.play(); } catch (e) { return { err: String(e).slice(0, 120) }; } const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 2000)); return { adv: v.currentTime - t0, code: v.error && v.error.code }; });
        if (st.err || !(st.adv > 0.5)) notTested(`[${dev}] reproducción H.264 en el navegador`, `el Chromium headless local no decodifica H.264 (${JSON.stringify(st)}); acceptance.cjs valida el MP4 descargado con ffprobe + sha256`);
        else check(`[${dev}] reproducción: el tiempo avanza`, true, st);
        const dl = p.getByRole("link", { name: /Descargar video/ });
        const box = await dl.boundingBox().catch(() => null);
        check(`[${dev}] resultado: «Descargar video» visible, dentro de la pantalla y de al menos 24 px de alto`, box && box.x >= 0 && box.x + box.width <= DEVICES[dev].viewport.width + 1 && box.height >= 24, box);
        const [d] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }).catch(() => null), dl.click().catch(() => null)]);
        check(`[${dev}] resultado: la descarga del MP4 se inicia desde la UI`, d && /\.mp4$/i.test(d.suggestedFilename()), d && d.suggestedFilename());
        if (d) await d.cancel().catch(() => {});
      } else notTested(`[${dev}] resultado / reproducción / descarga`, "no hay Reel completado en la BD local (correr antes acceptance.cjs)");
      await ctx.close();
    }
  } finally {
    const s = { pass: checks.filter((c) => c.ok).length, fail: checks.filter((c) => !c.ok).length, known, untested, tapTargets: tapInfo, checks };
    fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(s, null, 2));
    for (const t of tapInfo) console.log(`INFO  [${t.dev}] ${t.page}: ${t.n} objetivos táctiles < 24 px — ${JSON.stringify(t.small.slice(0, 4))}`);
    console.log(`RESULTADO ${s.pass} PASS / ${s.fail} FAIL / ${untested.length} NO PROBADO / ${known.filter((k) => !k.fixed).length} XFAIL`);
    await browser.close(); await db.end(); process.exit(s.fail ? 1 : 0);
  }
})();

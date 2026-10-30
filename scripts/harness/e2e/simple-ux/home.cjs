/**
 * Simple UX — portada «¿Qué quieres crear hoy?» (T-20261030-1313-chatgpt-01). USD 0, todo en 127.0.0.1 (mismo arnés que
 * qa-aceptacion). Samsung 390x844 y escritorio 1440x900: tres formatos, idea, Automático por defecto, «Continuar» a las
 * rutas reales, cero desbordamiento horizontal, sin herramientas internas y sin envíos (POST) desde la portada.
 * Solo abre páginas y formularios: no crea solicitudes ni autoriza nada.
 *
 *   E2E_OUT=<dir> node home.cjs     (lanzado por infra/run-e2e.sh con E2E_SCRIPT=simple-ux/home.cjs)
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100";
const OUT = path.resolve(process.env.E2E_OUT ?? "simple-ux-out"); fs.mkdirSync(OUT, { recursive: true });
const OWNER = { email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-A155M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  "samsung-390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75, userAgent: ANDROID_UA },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
};
const IDEA = "La leyenda urbana del fantasma del metro de la Ciudad de México";
let fails = 0, passes = 0;
const check = (name, ok, detail) => { ok ? passes++ : fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(detail ?? null).slice(0, 400)}`); return !!ok; };
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined });
  try {
    for (const [dev, opts] of Object.entries(DEVICES)) {
      const ctx = await browser.newContext({ ...opts, locale: "es-MX" });
      await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
      const p = await ctx.newPage(); p.setDefaultTimeout(60000);
      await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password);
      await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
      const home = async () => { await p.goto(`${BASE}/dashboard`); await p.getByTestId("crear-inicio").waitFor(); };
      // Envíos hechos MIENTRAS se está en la portada (/dashboard); lo que hagan otras pantallas no cuenta aquí.
      const posts = []; p.on("request", (r) => { if (r.method() !== "GET" && new URL(p.url()).pathname === "/dashboard" && !/_next|__nextjs|webpack|hmr/.test(r.url())) posts.push(`${r.method()} ${r.url()}`); });

      await home();
      await p.screenshot({ path: path.join(OUT, `${dev}-01-portada.png`), fullPage: true });
      const root = p.getByTestId("crear-inicio");
      check(`[${dev}] pregunta «¿Qué quieres crear hoy?»`, (await root.getByRole("heading", { level: 1 }).innerText()).includes("¿Qué quieres crear hoy?"));
      const titles = (await root.locator('[role="radio"]').allInnerTexts()).map((t) => t.split("\n")[0]);
      check(`[${dev}] solo tres opciones: Reel, Podcast y Video de YouTube`, titles.join("|") === "Reel|Podcast|Video de YouTube", titles);
      check(`[${dev}] campo «Describe tu idea…»`, (await p.getByTestId("crear-idea").getAttribute("placeholder")) === "Describe tu idea…");
      check(`[${dev}] Automático elegido por defecto; Personalizado disponible`, await p.getByTestId("crear-modo-auto").isChecked() && !(await p.getByTestId("crear-modo-custom").isChecked()));
      check(`[${dev}] una sola acción principal «Continuar», deshabilitada con motivo hasta elegir`, (await root.locator("button:not([role=radio])").count()) === 1 && await p.getByTestId("crear-continuar").isDisabled() && /Elige/.test(await p.getByTestId("crear-motivo").innerText()));
      const ov = await overflow(p); check(`[${dev}] sin desplazamiento horizontal en la portada`, ov <= 1, `${ov}px`);
      const hrefs = await root.locator("a[href]").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
      check(`[${dev}] accesos secundarios solo a rutas existentes, sin herramientas internas`, hrefs.every((h) => ["#proyectos", "/dashboard/billing"].includes(h)), hrefs);
      const text = await root.innerText();
      check(`[${dev}] sin lenguaje técnico en la portada`, !/dry run|command center|log|github|visual-test|webhook|worker/i.test(text), text.slice(0, 200));
      check(`[${dev}] «Mis proyectos» sigue en la misma pantalla`, await p.locator("#proyectos").count() === 1);

      // Reel en Automático: abre el formulario real con la idea y un estilo ya elegido.
      await p.getByTestId("crear-reel").click(); await p.getByTestId("crear-idea").fill(IDEA);
      await p.screenshot({ path: path.join(OUT, `${dev}-02-reel-elegido.png`), fullPage: true });
      await p.getByTestId("crear-continuar").click(); await p.waitForURL(/\/dashboard\/new\?formato=reel/);
      await p.locator("textarea#topic, input#topic").first().waitFor();
      check(`[${dev}] Reel abre /dashboard/new con la idea escrita`, (await p.locator("#topic").inputValue()) === IDEA);
      check(`[${dev}] Reel Automático: estilo elegido según la idea`, (await p.locator("select#style").inputValue()) === "Historias de terror", await p.locator("select#style").inputValue());
      const ov2 = await overflow(p); check(`[${dev}] formulario del Reel sin desplazamiento horizontal`, ov2 <= 1, `${ov2}px`);
      await p.screenshot({ path: path.join(OUT, `${dev}-03-reel-formulario.png`), fullPage: true });
      await p.goBack(); await p.getByTestId("crear-inicio").waitFor();
      check(`[${dev}] volver atrás regresa a la portada`, /\/dashboard$|\/dashboard\?|\/dashboard#/.test(p.url()) || p.url().endsWith("/dashboard"), p.url());

      // Reel en Personalizado: sin estilo automático.
      await home(); await p.getByTestId("crear-reel").click(); await p.getByTestId("crear-idea").fill(IDEA); await p.getByTestId("crear-modo-custom").check();
      await p.getByTestId("crear-continuar").click(); await p.waitForURL(/modo=personalizado/); await p.locator("select#style").waitFor();
      check(`[${dev}] Reel Personalizado: el estilo lo elige la persona`, (await p.locator("select#style").inputValue()) === "");

      // Entrada directa a /dashboard/new: igual que antes (sin estilo automático).
      await p.goto(`${BASE}/dashboard/new`);
      check(`[${dev}] /dashboard/new directo sin cambios`, await p.getByTestId("crear-inicio").count() === 0);

      // Podcast y YouTube: ruta real o «Disponible pronto».
      for (const [id, re, field] of [["podcast", /\/dashboard\/podcast/, null], ["youtube", /\/dashboard\/long-form\/new/, "input[name=topic]"]]) {
        await home(); const card = p.getByTestId(`crear-${id}`);
        if ((await card.getAttribute("aria-disabled")) === "true") {
          await card.click(); check(`[${dev}] ${id}: sin acceso se explica y no avanza`, await p.getByTestId("crear-continuar").isDisabled() && /Disponible pronto/.test(await p.getByTestId("crear-motivo").innerText()));
          continue;
        }
        await card.click(); await p.getByTestId("crear-idea").fill(IDEA);
        if (id === "podcast") check(`[${dev}] podcast: avisa que el tema se escribe en el primer paso`, /primer paso/.test(await p.getByTestId("crear-nota").innerText()));
        await p.getByTestId("crear-continuar").click(); await p.waitForURL(re);
        if (field) check(`[${dev}] ${id}: abre su formulario con la idea como tema`, (await p.locator(field).inputValue()) === IDEA.slice(0, 200));
        else check(`[${dev}] ${id}: abre la ruta real`, re.test(p.url()), p.url());
        await p.screenshot({ path: path.join(OUT, `${dev}-04-${id}.png`), fullPage: true });
      }
      check(`[${dev}] la portada no envía nada (cero POST/PUT/PATCH/DELETE)`, posts.length === 0, posts.slice(0, 5));
      await ctx.close();
    }
  } catch (e) { check("sin errores inesperados", false, String(e?.stack ?? e).slice(0, 600)); }
  finally { await browser.close(); }
  console.log(`RESULTADO ${fails === 0 ? "OK" : "FALLA"} pass=${passes} fail=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})();

// Recorrido REAL en navegador (Chromium) de un cliente nuevo contra la app Next local + Supabase simulado.
// No es producción, no hay Stripe real, no hay cobro: el Checkout no puede salir a la red y debe mostrar un
// error claro. Uso: APP=http://127.0.0.1:3111 MOCK=http://127.0.0.1:54329 MODE=open|closed OUT=dir node journey.mjs
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright del sistema (NODE_PATH) o del proyecto; no se añade como dependencia.
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.env.APP ?? "http://127.0.0.1:3111";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:54329";
const MODE = process.env.MODE ?? "open";
const OUT = process.env.OUT ?? "./journey-out";
mkdirSync(`${OUT}/capturas`, { recursive: true });
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const rows = [];
const check = (name, ok, detail = {}) => { rows.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 240)}`); };
const external = [];
const known = [];

/** La bienvenida de 5 pasos aparece sola a una cuenta nueva (se monta tarde); el cliente la cierra con «Omitir». */
async function dismissTour(page) {
  const skip = page.getByRole("button", { name: "Omitir" });
  if (await skip.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false)) { await skip.click(); return true; }
  return false;
}

async function audit(page, label, vp) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })));
  writeFileSync(`${OUT}/axe-${label}-${vp}.json`, JSON.stringify(axe, null, 2));
  await page.screenshot({ path: `${OUT}/capturas/${label}-${vp}.png`, fullPage: true });
  // El contraste de los tokens globales (text-ink-faint y texto blanco sobre el botón violeta) ya falla en
  // producción en todo el sitio: se informa aparte como P1 conocido, sin ocultarlo. Cualquier otra
  // violación critical/serious sí hace fallar el recorrido.
  const KNOWN = new Set(["color-contrast", "link-in-text-block"]);
  const serious = axe.filter((v) => (v.impact === "critical" || v.impact === "serious") && !KNOWN.has(v.id));
  const contrast = axe.filter((v) => KNOWN.has(v.id));
  check(`[${vp}] ${label}: sin desbordamiento horizontal`, overflow <= 0, { overflow });
  check(`[${vp}] ${label}: axe sin critical/serious (fuera del contraste conocido)`, serious.length === 0, { serious, total: axe.length });
  if (contrast.length) { known.push({ page: label, vp, contrast }); console.log(`AVISO P1-CONTRASTE [${vp}] ${label} ${JSON.stringify(contrast)}`); }
}

const browser = await chromium.launch();
for (const [vp, size] of [["390x844", { width: 390, height: 844 }], ["412x915", { width: 412, height: 915 }]]) {
  const ctx = await browser.newContext({ viewport: size, isMobile: true, hasTouch: true, locale: "es-MX" });
  // Cortafuegos: el navegador solo habla con la app local; nada sale a internet.
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
    external.push(route.request().url().slice(0, 120)); return route.abort();
  });
  const page = await ctx.newPage();
  const stamp = `${vp.replace("x", "")}${Date.now() % 100000}`;

  // 1. Portada
  await page.goto(`${APP}/`, { waitUntil: "networkidle" });
  const registerLinks = await page.locator('a[href="/register"]').count();
  const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  if (MODE !== "closed") check(`[${vp}] portada con ventas abiertas invita a crear cuenta`, registerLinks > 0, { registerLinks });
  else check(`[${vp}] portada con ventas cerradas no invita a registrarse y lo dice`, registerLinks === 0 && /Apertura de pagos pendiente|todavía no aceptamos pagos/i.test(bodyText), { registerLinks });
  await audit(page, `portada-${MODE}`, vp);

  // 2. Registro: reproducción del 9 de octubre (cuota de correo agotada)
  await page.goto(`${APP}/register`, { waitUntil: "networkidle" });
  if (MODE === "closed") check(`[${vp}] registro avisa que aún no hay pagos`, /Todavía no aceptamos pagos/.test(await page.locator("body").innerText()));
  await audit(page, `registro-${MODE}`, vp);
  const quotaEmail = `cliente+cuota${stamp}@correo.test`;
  await page.fill('input[name="email"]', quotaEmail);
  await page.fill('input[name="password"]', "Secreto-12345");
  await Promise.all([page.waitForURL(/\/register\?error=/, { timeout: 30000 }), page.click('button[type="submit"]')]);
  const quotaMsg = await page.locator('[role="alert"], .text-danger, body').first().innerText();
  check(`[${vp}] cuota de correo agotada (429) → mensaje claro, no genérico`, /No pudimos enviar el correo de confirmación/.test(quotaMsg) && !/No se pudo completar la solicitud/.test(quotaMsg));
  await page.screenshot({ path: `${OUT}/capturas/registro-error-cuota-${MODE}-${vp}.png`, fullPage: true });

  // 3. Registro correcto con doble toque: una sola alta, botón bloqueado mientras envía
  {
    const email = `cliente${stamp}@correo.test`;
    await page.goto(`${APP}/register`, { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "Secreto-12345");
    const btn = page.locator('button[type="submit"]');
    await btn.tap();
    await page.waitForTimeout(250);
    const pendingText = await btn.innerText().catch(() => "");
    const disabled = await btn.isDisabled().catch(() => false);
    await page.screenshot({ path: `${OUT}/capturas/registro-enviando-${vp}.png` });
    await btn.tap({ force: true, timeout: 2000 }).catch(() => undefined);
    await page.waitForURL(/\/login\?message=/, { timeout: 30000 });
    const stats = await (await fetch(`${MOCK}/__stats`)).json();
    check(`[${vp}] durante el envío el botón dice «Creando tu cuenta…» y está bloqueado`, /Creando tu cuenta/.test(pendingText) && disabled, { pendingText, disabled });
    check(`[${vp}] doble toque = una sola alta en Supabase`, stats.signups[email] === 1, { signups: stats.signups[email] });
    check(`[${vp}] enlace del correo apunta a la dirección pública /auth/callback`, stats.redirects[email] === `${process.env.SITE ?? "http://127.0.0.1:3111"}/auth/callback`, { redirectTo: stats.redirects[email] });
    check(`[${vp}] tras registrarse ve «Revisa tu correo»`, /Revisa tu correo/.test(await page.locator("body").innerText()));
    await audit(page, "login-revisa-correo", vp);

    // 4. Inicio de sesión → panel
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "Secreto-12345");
    await Promise.all([page.waitForURL((u) => u.pathname.startsWith("/dashboard"), { timeout: 60000 }), page.click('button[type="submit"]')]);
    check(`[${vp}] login → panel`, new URL(page.url()).pathname.startsWith("/dashboard"), { path: new URL(page.url()).pathname });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.screenshot({ path: `${OUT}/capturas/panel-bienvenida-${vp}.png` });
    check(`[${vp}] la bienvenida de cuenta nueva se puede omitir`, await dismissTour(page));
    await audit(page, "panel", vp);

    // 5. Facturación: tres planes con su precio y botón de compra; checkout sin red → error claro
    await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" });
    await dismissTour(page);
    const billing = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(`[${vp}] facturación muestra Starter $19, Pro $49, Business $129`, /\$19/.test(billing) && /\$49/.test(billing) && /\$129/.test(billing));
    if (MODE === "closed") {
      const disabledBuy = await page.getByRole("button", { name: "Pagos aún no habilitados" }).count();
      check(`[${vp}] sin Stripe: tres botones «Pagos aún no habilitados» desactivados y ningún «Elegir»`, disabledBuy === 3 && !/Elegir (Starter|Pro|Business)/.test(billing), { disabledBuy });
      await audit(page, "facturacion-cerrada", vp);
    } else if (MODE === "paid") {
      // 5b. Suscripción en MODO PRUEBA (Stripe simulado local, webhook firmado con el SDK real) → plan activo
      check(`[${vp}] con Price IDs configurados se ofrece «Elegir Starter/Pro/Business»`, ["Starter", "Pro", "Business"].every((p) => billing.includes(`Elegir ${p}`)));
      await audit(page, "facturacion", vp);
      await Promise.all([page.waitForURL(/\/pay\/cs_test_sim_/, { timeout: 60000 }), page.getByRole("button", { name: "Elegir Pro" }).tap()]);
      check(`[${vp}] «Elegir Pro» abre el Checkout de prueba`, /Checkout de PRUEBA/.test(await page.locator("body").innerText()));
      await page.screenshot({ path: `${OUT}/capturas/checkout-prueba-${vp}.png` });
      await Promise.all([page.waitForURL(/\/dashboard\/billing\?checkout=success/, { timeout: 60000 }), page.getByRole("button", { name: "Pagar (modo prueba)" }).tap()]);
      const sstats = await (await fetch(`${process.env.MOCK_STRIPE ?? "http://127.0.0.1:54330"}/__stats`)).json();
      check(`[${vp}] el webhook firmado se aceptó (200)`, sstats.webhooks.at(-1)?.status === 200, { webhook: sstats.webhooks.at(-1) });
      await page.reload({ waitUntil: "networkidle" }); await dismissTour(page);
      const after = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      check(`[${vp}] tras pagar: «Plan actual Atomicvid Pro», activa y con fecha de renovación`, /Plan actual/i.test(after) && /Atomicvid Pro/.test(after) && /Activa/.test(after) && /Se renueva el/.test(after));
      check(`[${vp}] con plan activo ya no se ofrece otro plan (sin doble suscripción)`, !/Elegir (Starter|Pro|Business)/.test(after) && /Administrar suscripción/.test(after));
      await audit(page, "facturacion-activa", vp);
    } else {
    check(`[${vp}] con Price IDs configurados se ofrece «Elegir Starter/Pro/Business»`, ["Starter", "Pro", "Business"].every((p) => billing.includes(`Elegir ${p}`)));
    check(`[${vp}] clave de prueba → aviso «Entorno de prueba de Stripe»`, /Entorno de prueba de Stripe/.test(billing));
    await audit(page, "facturacion", vp);
    const choose = page.getByRole("button", { name: "Elegir Starter" });
    await choose.tap();
    await page.waitForTimeout(150);
    const choosing = await page.locator('button[aria-busy="true"]').first().innerText().catch(() => "");
    await page.waitForURL(/\/dashboard\/billing\?error=/, { timeout: 60000 });
    const err = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(`[${vp}] «Elegir Starter» muestra «Abriendo el pago seguro…» mientras espera`, /Abriendo el pago seguro/.test(choosing), { choosing });
    check(`[${vp}] Stripe inalcanzable → «No se pudo conectar con Stripe… Intenta de nuevo», sin salir del sitio ni cobrar`, /No se pudo conectar con Stripe/.test(err) && new URL(page.url()).host === new URL(APP).host, { url: page.url().slice(0, 120) });
    await page.screenshot({ path: `${OUT}/capturas/facturacion-error-stripe-${vp}.png`, fullPage: true });
    }

    // 6. Sin suscripción: el panel lo dice y enlaza a Facturación
    await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
    await dismissTour(page);
    const panel = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    if (MODE === "paid") {
      check(`[${vp}] con suscripción, el panel ya no pide «suscripción activa»`, !/necesitas una suscripción activa/i.test(panel));
      // 7. Crear un Reel y elegir el proveedor de imágenes (FLUX/Recraft habilitados SOLO en este entorno de prueba)
      await page.goto(`${APP}/dashboard/new`, { waitUntil: "networkidle" }); await dismissTour(page);
      // Un cliente sin accesos beta va directo al Reel; con más formatos, primero elige «Reel / Short».
      const reelCard = page.getByRole("button", { name: /Reel \/ Short/ });
      if (await reelCard.count()) await reelCard.tap();
      const radios = { def: page.locator('input[name="reel_image_source"][value="default"]'), recraft: page.locator('input[name="reel_image_source"][value="recraft"]'), flux: page.locator('input[name="reel_image_source"][value="flux"]') };
      check(`[${vp}] el Reel ofrece 3 fuentes de imágenes: archivo, Recraft y FLUX`, (await radios.def.count()) === 1 && (await radios.recraft.count()) === 1 && (await radios.flux.count()) === 1);
      await radios.flux.check();
      check(`[${vp}] FLUX muestra su costo por escena antes de crear`, /USD 0,025 por escena/.test(await page.locator("body").innerText()));
      await audit(page, "nuevo-reel-flux", vp);
      await page.fill('textarea[name="topic"]', `5 datos curiosos del océano ${stamp}`);
      await page.selectOption('select[name="style"]', { label: "Curiosidades" });
      const submit = page.getByRole("button", { name: "Crear solicitud" });
      await Promise.all([page.waitForURL((u) => !(u.pathname === "/dashboard/new" && !u.searchParams.get("error")) || u.searchParams.has("error"), { timeout: 60000 }), submit.tap()]);
      const landed = new URL(page.url());
      const vstats = await (await fetch(`${MOCK}/__stats`)).json();
      const mine = vstats.video_requests.filter((v) => v.reel_image_source === "flux" && v.user_id === (vstats.subscriptions.at(-1)?.user_id));
      check(`[${vp}] «Crear solicitud» guarda el Reel con reel_image_source=flux (sin cobrar)`, !landed.searchParams.has("error") && mine.length >= 1 && mine.every((v) => v.mode === "visual" && v.status === "pending"), { url: `${landed.pathname}${landed.search}`.slice(0, 140), flux: mine.length });
      await page.screenshot({ path: `${OUT}/capturas/reel-creado-${vp}.png`, fullPage: true });
      // 8. Impago (Stripe marca past_due): sin acceso, se ofrece «Actualizar método de pago» y NUNCA otro plan
      const myId = mine.at(-1)?.user_id;
      await fetch(`${MOCK}/rest/v1/subscriptions?user_id=eq.${myId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "past_due" }) });
      await page.goto(`${APP}/dashboard/billing`, { waitUntil: "networkidle" }); await dismissTour(page);
      const due = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      check(`[${vp}] con pago pendiente: aviso + «Actualizar método de pago», sin «Elegir» otro plan`, /pago pendiente/i.test(due) && /Actualizar método de pago/.test(due) && !/Elegir (Starter|Pro|Business)/.test(due));
      await audit(page, "facturacion-pago-pendiente", vp);
      await page.goto(`${APP}/dashboard`, { waitUntil: "networkidle" }); await dismissTour(page);
      check(`[${vp}] con pago pendiente el panel vuelve a pedir una suscripción activa`, /necesitas una suscripción activa/i.test((await page.locator("body").innerText()).replace(/\s+/g, " ")));
    } else {
      check(`[${vp}] sin suscripción, el panel dice «necesitas una suscripción activa» con «Ver planes»`, /necesitas una suscripción activa/i.test(panel) && (await page.getByRole("link", { name: "Ver planes" }).count()) > 0);
    }
  }
  await ctx.close();
}
await browser.close();
check("el navegador no salió a internet (cortafuegos)", true, { bloqueadas: external.length, ejemplos: [...new Set(external)].slice(0, 5) });
const fails = rows.filter((r) => !r.ok).length;
writeFileSync(`${OUT}/resultados.json`, JSON.stringify({ mode: MODE, rows, external: [...new Set(external)], p1Contraste: known }, null, 2));
console.log(`RESULTADO ${rows.length - fails} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);

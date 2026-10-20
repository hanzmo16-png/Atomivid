/**
 * Auditoría de accesibilidad y fricción (T-20261019-1602). axe-core (WCAG 2.1 A/AA) en las pantallas del flujo Reel +
 * comprobaciones de formulario inválido y teclado. Sin escrituras salvo lo que un formulario inválido dejara pasar (que es el defecto buscado).
 */
const path = require("node:path"), fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright"); const { Client } = require(process.env.HARNESS_PG_MODULE ?? "pg");
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3100"; const OUT = path.resolve(process.env.E2E_OUT ?? "a11y-out"); fs.mkdirSync(OUT, { recursive: true });
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js", { paths: [process.env.AXE_DIR ?? process.cwd()] }), "utf8");
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", password: "local-pass-owner-1" };
const res = { pages: [], form: {}, keyboard: {} };
(async () => {
  const db = new Client({ connectionString: process.env.HARNESS_PG_URL }); await db.connect();
  const b = await chromium.launch({ executablePath: process.env.E2E_CHROME || undefined }); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage(); p.setDefaultTimeout(60000);
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", OWNER.email); await p.fill("input[name=password]", OWNER.password); await p.locator("form button[type=submit]").last().click(); await p.waitForURL(/\/dashboard/);
  const failed = (await db.query("select id from public.video_requests where user_id=$1 and status='failed' order by created_at desc limit 1", [OWNER.id])).rows[0];
  const done = (await db.query("select id from public.video_requests where user_id=$1 and status='completed' order by created_at desc limit 1", [OWNER.id])).rows[0];
  const pages = [["login", "/login", false], ["dashboard", "/dashboard"], ["nuevo", "/dashboard/new"], ["revision-fallido", failed && `/dashboard/review/${failed.id}`], ["video", done && `/dashboard/videos/${done.id}`]];
  for (const [name, url, auth = true] of pages) { if (!url) continue;
    const pg = auth ? p : await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await pg.goto(BASE + url); await pg.getByRole("button", { name: "Omitir" }).click({ timeout: 5000 }).catch(() => {}); await pg.waitForTimeout(1200);
    await pg.addScriptTag({ content: AXE }); const r = await pg.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
    await pg.screenshot({ path: path.join(OUT, `a11y-${name}.png`), fullPage: true });
    res.pages.push({ name, url, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(" ")) })) });
  }
  // formulario inválido: tema vacío / demasiado corto ⇒ no debe crear solicitud y debe explicar por qué
  const before = Number((await db.query("select count(*) from public.video_requests where user_id=$1", [OWNER.id])).rows[0].count);
  await p.goto(`${BASE}/dashboard/new`); await p.getByRole("button", { name: "Omitir" }).click({ timeout: 5000 }).catch(() => {});
  await p.getByText("Reel / Short").click(); await p.fill("#topic", "");
  const btn = p.getByRole("button", { name: "Crear solicitud" }); const disabledEmpty = await btn.isDisabled();
  if (!disabledEmpty) await btn.click().catch(() => {}); await p.waitForTimeout(2000);
  const msgEmpty = (await p.locator("[role=alert], [aria-live], .text-red-500, .text-red-400, [aria-invalid=true]").allInnerTexts()).join(" | ");
  const validity = await p.locator("#topic").evaluate((e) => ({ valid: e.validity?.valid, msg: e.validationMessage, required: e.required, minLength: e.minLength }));
  await p.fill("#topic", "ab"); const disabledShort = await btn.isDisabled(); if (!disabledShort) await btn.click().catch(() => {}); await p.waitForTimeout(2000);
  const after = Number((await db.query("select count(*) from public.video_requests where user_id=$1", [OWNER.id])).rows[0].count);
  await p.screenshot({ path: path.join(OUT, "form-invalido.png"), fullPage: true });
  const sel = await p.locator("#style").evaluate((e) => ({ required: e.required, value: e.value }));
  res.form = { styleRequired: sel, note: "con tema «ab» el envío lo frena solo la validación nativa del estilo vacío; ver form-invalido.png", disabledEmpty, disabledShort, validity, messages: msgEmpty.slice(0, 300), created: after - before, url: p.url() };
  // teclado: el CTA principal es alcanzable con Tab y tiene foco visible
  await p.goto(`${BASE}/dashboard/new`); await p.getByRole("button", { name: "Omitir" }).click({ timeout: 5000 }).catch(() => {});
  await p.getByText("Reel / Short").click(); await p.fill("#topic", "Prueba de teclado: los tres corazones del pulpo"); await p.selectOption("#style", { label: "Curiosidades" });
  const t0 = Date.now(); while (Date.now() - t0 < 60000 && await p.getByRole("button", { name: "Crear solicitud" }).isDisabled()) await p.waitForTimeout(500);
  const ctaEnableMs = Date.now() - t0; const ctaDisabledValid = await p.getByRole("button", { name: "Crear solicitud" }).isDisabled(); await p.focus("#topic");
  let reached = false, steps = 0, focusVisible = null;
  for (; steps < 60 && !reached; steps++) { await p.keyboard.press("Tab"); const f = await p.evaluate(() => { const e = document.activeElement; const cs = e && getComputedStyle(e); return { t: e?.textContent?.trim().slice(0, 40), outline: cs && (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px" || cs.boxShadow !== "none") }; });
    if (/Crear solicitud/.test(f.t ?? "")) { reached = true; focusVisible = f.outline; } }
  res.keyboard = { ctaReachable: reached, tabs: steps, focusVisible, ctaDisabledValid, ctaEnableMs };
  fs.writeFileSync(path.join(OUT, "a11y-report.json"), JSON.stringify(res, null, 2));
  for (const pg of res.pages) console.log(`${pg.name}: ${pg.violations.length} reglas violadas ${pg.violations.map((v) => `${v.id}(${v.impact},${v.nodes})`).join(" ")}`);
  console.log("form:", JSON.stringify(res.form)); console.log("keyboard:", JSON.stringify(res.keyboard));
  await db.end(); await b.close();
})().catch((e) => { console.error(e); process.exit(1); });

// USD 0, SIN ESCRITURAS: reproduce en PRODUCCIÓN «0 % → 100 % al instante sin episodio nuevo». El asistente guarda su
// borrador en localStorage; tras producir un episodio el borrador conserva `episodeId`. Si el usuario vuelve atrás,
// arma otro podcast y llega a «Generación», el indicador muestra el episodio ANTERIOR (ya listo). Se siembra el borrador
// que dejó la producción real de ec30c594, se recorre como un usuario y se mide. Solo se permite el POST de estimación
// (gratis, no escribe); cualquier otro POST a la API del podcast se bloquea. Conteos antes/después.
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const APP = process.env.POD_UI_URL || "https://atomivid.vercel.app", EVID = process.env.EVID;
const HOST = new URL(APP).hostname;
const PREV = "ec30c594-21ca-49f8-8d09-817a07147fd8";
const KEY = "atomivid.podcast.asistente.v2";
const stateFor = () => { const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = []; return st; };
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!cond) fails++; return cond; };
const count = async (table) => { const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=*`, { method: "HEAD", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" } }); return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN); };
const ledger = async () => ({ studioEpisodes: await count("podcast_studio_episodes"), studioOps: await count("podcast_studio_operations"), paidOps: await count("pi_paid_operations"), podcastEpisodes: await count("podcast_episodes") });
const BEFORE = await ledger();
console.log(`LEDGER_BEFORE ${JSON.stringify(BEFORE)}`);
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
for (const [label, opts] of [["escritorio", { viewport: { width: 1366, height: 900 } }], ["movil", { ...devices["iPhone 13"] }]]) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `borrador-${label}-${n}.png`), fullPage: true }).catch(() => {});
  const W = () => p.getByTestId("podcast-wizard");
  const title = () => W().getByTestId("wizard-step-title").innerText();
  const posts = [], gets = [];
  await p.route("**/api/podcast/**", async (route) => {
    const req = route.request(); const url = new URL(req.url()).pathname;
    if (req.method() === "GET") { gets.push(url); return route.continue(); }
    const body = req.postData() ?? "";
    posts.push({ url, action: /"action":"(\w+)"/.exec(body)?.[1] ?? (/"confirm":true/.test(body) ? "authorize" : "?") });
    if (url === "/api/podcast/v3" && /"action":"estimate"/.test(body)) return route.continue(); // gratis, no escribe
    return route.abort("failed");
  });
  try {
    await p.goto(`${APP}/dashboard/podcast`);
    if (!ok(`${label}: abre el estudio`, new URL(p.url()).hostname === HOST)) { await ctx.close(); continue; }
    // Borrador tal como lo deja una producción terminada desde el asistente (la de ec30c594, 2026-10-29).
    await p.evaluate(([k, id]) => { const d = JSON.parse(localStorage.getItem(k) || "{}"); localStorage.setItem(k, JSON.stringify({ ...d, step: 9, episodeId: id, draftId: id, authorized: true, title: "Cosmonautas mito o realidad" })); }, [KEY, PREV]);
    await p.reload(); await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 60000 });
    await p.getByTestId("wizard-progress").waitFor({ timeout: 30000 }); await p.waitForTimeout(5000);
    await shot("1-generacion-anterior");
    // El usuario vuelve al inicio para crear OTRO podcast (Atrás hasta el paso 1) y cambia título y tema.
    for (let i = 0; i < 12 && !/Paso 1 de/.test(await title()); i++) { await W().getByRole("button", { name: "Atrás" }).click(); await p.waitForTimeout(300); }
    const draftAtStart = await p.evaluate((k) => { const d = JSON.parse(localStorage.getItem(k) || "{}"); return { episodeId: d.episodeId ?? null, draftId: d.draftId ?? null, authorized: d.authorized ?? null }; }, KEY);
    console.log(`DRAFT_AT_STEP1 ${label} ${JSON.stringify(draftAtStart)}`);
    await W().getByTestId("modalidad-dialogo").click().catch(() => {});
    await W().getByRole("button", { name: "Siguiente", exact: true }).click(); await p.waitForTimeout(500);
    await W().getByLabel("Título del episodio").fill("Podcast nuevo de prueba (no se genera)");
    await W().getByLabel("Tema", { exact: true }).fill("Las pirámides de Egipto");
    await W().getByLabel("Guion").fill(["Valeria Montclair: Hoy hablamos de las pirámides de Egipto.", "Víctor Albarrán: Se construyeron hace más de cuatro mil quinientos años.", "Valeria Montclair: ¿Cómo movían esos bloques?", "Víctor Albarrán: Con rampas, trineos y mucha organización."].join("\n"));
    // Avanza como el usuario hasta «Generación».
    for (let i = 0; i < 12 && !/Generación/.test(await title()); i++) {
      if (/Participantes/.test(await title())) {
        await W().getByRole("radiogroup", { name: /Participante A/ }).getByTestId("anfitrion-valeria").getByRole("radio").click().catch(() => {});
        await W().getByRole("radiogroup", { name: /Participante B/ }).getByTestId("anfitrion-victor").getByRole("radio").click().catch(() => {});
      }
      await W().getByRole("button", { name: "Siguiente", exact: true }).click(); await p.waitForTimeout(1500);
      const al = await W().getByRole("alert").innerText().catch(() => ""); if (al) console.log(`ALERT ${label} ${await title()}: ${al.slice(0, 160)}`);
    }
    console.log(`STEP ${label} ${await title()}`);
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const s = await p.evaluate(() => { const el = document.querySelector('[data-testid="atom-progress"]'); return { gen: [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Generar episodio"),
        state: el?.getAttribute("data-state") ?? null, pct: el?.querySelector('[data-testid="atom-progress-pct"]')?.textContent ?? null, player: !!document.querySelector('[data-testid="wizard-player"]'), cost: [...document.querySelectorAll("p")].map((x) => x.textContent).find((t) => /Costo registrado/.test(t ?? "")) ?? null }; });
      samples.push(s); await p.waitForTimeout(1000);
    }
    await shot("2-generacion-nuevo");
    console.log(`AT_GENERACION ${label} ${JSON.stringify({ first: samples[0], last: samples[samples.length - 1] })}`);
    console.log(`REQUESTS ${label} ${JSON.stringify({ posts, getsPrev: gets.filter((g) => g.includes(PREV)).length })}`);
    const fin = samples[samples.length - 1];
    ok(`${label}: REPRODUCE — en «Generación» del podcast nuevo no hay botón y el indicador marca 100 % (episodio anterior)`, !fin.gen && fin.state === "listo" && fin.pct === "100%", JSON.stringify(fin));
    ok(`${label}: no se envió ninguna creación ni autorización (solo estimaciones)`, posts.every((x) => x.action === "estimate"), JSON.stringify(posts));
    await p.evaluate((k) => { try { localStorage.removeItem(k); } catch {} }, KEY);
  } catch (e) { ok(`${label}: recorrido sin errores`, false, String(e).slice(0, 200)); await shot("error"); }
  await ctx.close();
}
await browser.close();
const AFTER = await ledger();
console.log(`LEDGER_AFTER ${JSON.stringify(AFTER)}`);
ok("nada creado ni cobrado", JSON.stringify(AFTER) === JSON.stringify(BEFORE), `${JSON.stringify(BEFORE)} → ${JSON.stringify(AFTER)}`);
console.log(`RESULT pod-borrador: ${fails} FAIL`);
process.exit(fails ? 1 : 0);

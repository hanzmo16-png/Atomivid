// USD 0, SOLO LECTURA: valida en PRODUCCIÓN el indicador de progreso del estudio tras #250, sin generar nada.
// 1) API real desplegada: el GET del episodio ec30c594 (ya terminado) responde con los campos nuevos (`activity`, `output`).
// 2) Interfaz desplegada: el paso «Generación» del asistente consulta un episodio FICTICIO cuyas respuestas se sirven
//    dentro del navegador (page.route) con una secuencia basada en el libro real de ec30c594, incluida una respuesta
//    vieja (retroceso). Se comprueba que los hitos se ven, que el % nunca baja y que el 100 % solo llega con «listo».
//    Ningún POST sale hacia la API del podcast (se bloquea y se cuenta). Conteos antes/después: nada creado ni cobrado.
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const APP = process.env.POD_UI_URL || "https://atomivid.vercel.app", EVID = process.env.EVID;
const HOST = new URL(APP).hostname;
const REAL = "ec30c594-21ca-49f8-8d09-817a07147fd8";
const FAKE = "00000000-0000-4000-8000-00000000c0de";
const stateFor = () => { const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = []; return st; };
fs.mkdirSync(EVID, { recursive: true });
let fails = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!cond) fails++; return cond; };
const count = async (table, filter = "") => {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?select=*${filter}`, { method: "HEAD", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN);
};
const ledger = async () => ({ studioEpisodes: await count("podcast_studio_episodes"), studioOps: await count("podcast_studio_operations"), paidOps: await count("pi_paid_operations"), podcastEpisodes: await count("podcast_episodes") });
const BEFORE = await ledger();
console.log(`LEDGER_BEFORE ${JSON.stringify(BEFORE)}`);

// Secuencia (basada en el libro real de ec30c594 del 2026-10-29). Las horas se rehacen respecto de «ahora» para que la
// página no lo vea como «sin respuesta».
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const st = (stages) => Object.fromEntries(Object.entries(stages).map(([k, [d, t]]) => [k, { done: d, total: t, at: iso(60_000) }]));
const ep = (status, progress, extra = {}) => ({ episode: { id: FAKE, title: "Validación (ficticio)", status, progress, updated_at: iso(30_000), error: null, cost_usd: null, output: "video", audio_path: null, ...extra }, video_url: null, audio_url: null });
const prog = (stage, pct, done, total, stages, text) => ({ stage, pct, done, total, estimate: true, updatedAt: iso(20_000), stages: st(stages), activity: [{ at: iso(20_000), text }] });
const SEQ = [
  { tag: "espera", body: { ...ep("authorized", null), activity: null } },
  // Avance guardado nulo (como ec30c594 con el worker anterior): el libro pone el mínimo comprobable.
  { tag: "libro-voces", body: { ...ep("generating", null, { updated_at: iso(3 * 3600_000) }), activity: { lastAt: iso(15_000), counts: { voces: 20 }, stage: "voces", recent: [{ at: iso(15_000), text: "Voz lista 20" }] } } },
  { tag: "voces", body: { ...ep("generating", prog("voces", 13, 43, 43, { preparacion: [1, 1], voces: [43, 43] }, "Voz 43 de 43")), activity: { lastAt: iso(10_000), counts: { voces: 43 }, stage: "voces", recent: [] } } },
  { tag: "imagenes", body: { ...ep("generating", prog("imagenes", 23, 10, 21, { preparacion: [1, 1], voces: [43, 43], imagenes: [10, 21] }, "Imagen 10 de 21")), activity: { lastAt: iso(8_000), counts: { voces: 43, imagenes: 10 }, stage: "imagenes", recent: [] } } },
  // Respuesta vieja (retroceso): la página no debe bajar.
  { tag: "retroceso", body: { ...ep("generating", prog("voces", 10, 30, 43, { preparacion: [1, 1], voces: [30, 43] }, "Voz 30 de 43")), activity: null } },
  { tag: "avatares", body: { ...ep("generating", prog("avatares", 47, 7, 12, { preparacion: [1, 1], voces: [43, 43], imagenes: [21, 21], avatares: [7, 12] }, "Clip de avatar 7 de 12")), activity: { lastAt: iso(5_000), counts: { voces: 43, imagenes: 21, avatares: 7 }, stage: "avatares", recent: [{ at: iso(5_000), text: "Generando clip de avatar 8" }] } } },
  { tag: "guardado", body: { ...ep("generating", prog("guardado", 99, 1, 2, { preparacion: [1, 1], voces: [43, 43], imagenes: [21, 21], avatares: [12, 12], montaje: [40, 40], guardado: [1, 2] }, "Guardando el archivo final")), activity: null } },
  { tag: "listo", body: { ...ep("ready", prog("guardado", 99, 1, 1, { preparacion: [1, 1], voces: [43, 43], imagenes: [21, 21], avatares: [12, 12], montaje: [40, 40], guardado: [1, 1] }, "Archivo final guardado"), { audio_path: "ficticio/episodio.mp3" }), activity: null } },
];

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
for (const [label, opts] of [["escritorio", { viewport: { width: 1366, height: 900 } }], ["movil", { ...devices["iPhone 13"] }]]) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `progreso-${label}-${n}.png`), fullPage: true }).catch(() => {});
  let blocked = 0, served = -1;
  // Nunca escribir: cualquier POST/PUT/PATCH/DELETE hacia la API del podcast se aborta.
  await p.route("**/api/podcast/**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") { blocked++; return route.abort(); }
    if (req.url().includes(FAKE)) { served = Math.min(served + 1, SEQ.length - 1); return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SEQ[served].body) }); }
    return route.continue();
  });
  try {
    await p.goto(`${APP}/dashboard/podcast`);
    if (!ok(`${label}: abre el estudio con la sesión del dueño`, new URL(p.url()).hostname === HOST && /\/dashboard\/podcast/.test(p.url()), p.url().slice(0, 80))) { await ctx.close(); continue; }
    // 1) API real desplegada (solo GET del episodio ya terminado).
    if (label === "escritorio") {
      const real = await p.evaluate(async (id) => { const r = await fetch(`/api/podcast/v3/${id}`); const b = await r.json().catch(() => null); return { status: r.status, hasActivity: !!b && "activity" in b, activity: b?.activity ?? null, output: b?.episode?.output ?? null, epStatus: b?.episode?.status ?? null, stages: Object.keys(b?.episode?.progress?.stages ?? {}) }; }, REAL);
      console.log(`API_REAL ${JSON.stringify(real)}`);
      ok("API desplegada: GET del episodio con los campos nuevos (activity, output)", real.status === 200 && real.hasActivity && real.output === "video" && real.epStatus === "ready", JSON.stringify(real));
    }
    // 2) Interfaz desplegada con el episodio ficticio en el paso «Generación».
    await p.evaluate((fake) => { localStorage.setItem("atomivid.podcast.asistente.v2", JSON.stringify({ step: 9, episodeId: fake, authorized: true, title: "Validación (ficticio)" })); }, FAKE);
    await p.reload();
    await p.getByTestId("wizard-progress").waitFor({ timeout: 60000 });
    const samples = [];
    const seen = new Set();
    for (let i = 0; i < 70 && !(samples.length && samples[samples.length - 1].state === "listo"); i++) {
      const s = await p.getByTestId("atom-progress").first().evaluate((el) => ({
        state: el.getAttribute("data-state"), pct: Number((el.querySelector('[data-testid="atom-progress-pct"]')?.textContent ?? "").replace("%", "")),
        stage: el.querySelector('[data-testid="atom-progress-stage"]')?.textContent ?? "", activity: el.querySelector('[data-testid="atom-progress-activity"]')?.textContent ?? "",
        rows: [...el.querySelectorAll('[data-testid="atom-progress-stages"] li')].map((li) => `${li.getAttribute("data-state")}:${li.textContent}`) })).catch(() => null);
      if (s) { s.served = SEQ[served]?.tag ?? "-"; samples.push(s); if (!seen.has(s.served)) { seen.add(s.served); await shot(s.served); console.log(`SAMPLE ${label} ${JSON.stringify(s)}`); } }
      await p.waitForTimeout(1000);
    }
    const live = samples.filter((s) => s.state !== "espera" && s.state !== "listo").map((s) => s.pct);
    const mono = live.every((v, i) => i === 0 || v >= live[i - 1]);
    const at = (tag) => samples.filter((s) => s.served === tag).pop();
    ok(`${label}: «espera» antes de que un procesador lo tome`, samples.some((s) => s.state === "espera" && s.pct === 0));
    ok(`${label}: sin avance guardado, el libro pone la etapa real (no 0 %)`, (at("libro-voces")?.pct ?? 0) > 0 && /Voces/.test(at("libro-voces")?.stage ?? ""), JSON.stringify(at("libro-voces")));
    ok(`${label}: una respuesta vieja no hace retroceder el %`, (at("retroceso")?.pct ?? -1) >= (at("imagenes")?.pct ?? 99), `${at("imagenes")?.pct} → ${at("retroceso")?.pct}`);
    ok(`${label}: el % nunca baja durante la producción`, mono && live.length >= 4, JSON.stringify(live));
    ok(`${label}: nunca 100 % antes de «listo»`, live.every((v) => v < 100));
    const av = at("avatares");
    if (label === "escritorio") ok(`${label}: hitos por etapa visibles (Voces 43/43, Imágenes 21/21, Avatares 7/12)`, !!av && av.rows.some((r) => /^hecha:✓ Voces 43\/43$/.test(r)) && av.rows.some((r) => /^hecha:✓ Imágenes 21\/21$/.test(r)) && av.rows.some((r) => /^activa:Avatares 7\/12$/.test(r)), JSON.stringify(av?.rows));
    else ok(`${label}: hitos por etapa visibles en móvil`, !!av && av.rows.length >= 5 && av.rows.some((r) => /Voces 43\/43/.test(r)), JSON.stringify(av?.rows));
    ok(`${label}: actividad reciente visible`, /Última actividad/.test(av?.activity ?? ""), av?.activity ?? "");
    const fin = samples[samples.length - 1];
    ok(`${label}: 100 % solo con «listo» (archivo guardado)`, fin?.state === "listo" && fin.pct === 100, JSON.stringify(fin));
    const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    ok(`${label}: sin desplazamiento horizontal`, sw <= iw + 1, `${sw}/${iw}`);
    ok(`${label}: ningún POST salió hacia la API del podcast`, blocked === 0, `bloqueados=${blocked}`);
    await p.evaluate(() => { try { localStorage.removeItem("atomivid.podcast.asistente.v2"); } catch {} });
  } catch (e) { ok(`${label}: recorrido sin errores`, false, String(e).slice(0, 200)); await shot("error"); }
  await ctx.close();
}
await browser.close();
const AFTER = await ledger();
console.log(`LEDGER_AFTER ${JSON.stringify(AFTER)}`);
ok("nada creado ni cobrado (episodios, operaciones del estudio, operaciones pagadas)", JSON.stringify(AFTER) === JSON.stringify(BEFORE), `${JSON.stringify(BEFORE)} → ${JSON.stringify(AFTER)}`);
console.log(`RESULT pod-progreso: ${fails} FAIL`);
process.exit(fails ? 1 : 0);

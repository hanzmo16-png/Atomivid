// USD 0, SIN GENERAR NADA: cierre de Podcast Studio (#272, #269 y #273) en PRODUCCIÓN con la sesión de la cuenta dueña.
// Comprueba lo DESPLEGADO, no una simulación local:
//  1) esquema real: archived_at en las dos tablas de episodios (archivar/restaurar), lectura con service role;
//  2) libro real: operaciones del guion largo (studio-script:*) agrupadas por paso; ninguna clave nueva duplicada;
//  3) API real: GET /api/podcast/v3 devuelve la cuenta con sesión; un script-step con un trabajo de OTRA configuración
//     responde 409 OTRO_TRABAJO (o 503 si la IA está apagada) ANTES de cualquier llamada a la IA: cero operaciones nuevas;
//  4) interfaz real (escritorio e iPhone 13), con borradores SOLO en el localStorage de este navegador efímero:
//     trabajo a medias → «Continuar (bloque k de n)» + aviso «Retomaste…»; cambio de tema → «trabajo-distinto» →
//     «Volver a esa configuración» con el MISMO jobId; «Empezar de nuevo» lo aparca; «Recuperar» lo devuelve;
//     un borrador CRUDO antiguo (formato 16ab4473) se recupera con su jobId;
//     fase 269 además: la entrada «Personalizado» de la portada abre una configuración nueva y aparca la anterior.
//  Nunca se pulsa «Generar», «Autorizar» ni nada que cobre. Todo POST a la API del podcast se bloquea salvo la sonda
//  OTRO_TRABAJO (marcada). Conteos de episodios y del libro antes/después: deben ser iguales.
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "playwright";

const APP = "https://atomivid.vercel.app", EVID = process.env.EVID, OWNER = process.env.OWNER_ID, FASE = process.env.POD_CIERRE_FASE || "272";
const HOST = new URL(APP).hostname, KEY = "atomivid.podcast.asistente.v2", REC = `${KEY}.recuperable`;
const JOB = "0c1e0000-0000-4000-8000-00000000c1e0";
const stateFor = () => { const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, "utf8")); st.cookies = (st.cookies ?? []).map((c) => ({ ...c, domain: HOST })); st.origins = []; return st; };
fs.mkdirSync(EVID, { recursive: true });
let fails = 0, passes = 0;
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${String(info).slice(0, 300)}` : ""}`); cond ? passes++ : fails++; return cond; };
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
const rest = (q, extra = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${q}`, { headers: { ...H, ...extra } });
const count = async (t) => { const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${t}`, { method: "HEAD", headers: { ...H, Prefer: "count=exact" } }); return Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN); };
const counts = async () => ({ studio: await count(`podcast_studio_episodes?select=id&user_id=eq.${OWNER}`), v2: await count(`podcast_episodes?select=id&user_id=eq.${OWNER}`), guion: await count("pi_paid_operations?select=idempotency_key&project_id=like.studio-script:*"), podcast: await count("pi_paid_operations?select=idempotency_key&project_id=like.podcast-*") });

const BEFORE = await counts();
console.log(`COUNTS_BEFORE ${JSON.stringify(BEFORE)}`);

// 1) Esquema real para archivar/restaurar (solo lectura).
for (const t of ["podcast_studio_episodes", "podcast_episodes"]) {
  const r = await rest(`${t}?select=id,archived_at&limit=1`);
  ok(`esquema: ${t}.archived_at existe en producción`, r.status === 200, `HTTP ${r.status}`);
}
{
  const r = await rest(`podcast_studio_episodes?select=archived_at&user_id=eq.${OWNER}&archived_at=not.is.null`, { Prefer: "count=exact" });
  const n = Number((r.headers.get("content-range") ?? "").split("/")[1] ?? NaN);
  console.log(`ARCHIVADOS_ESTUDIO_DUENO ${JSON.stringify({ http: r.status, n })}`);
}

// 1b) Conteos agregados por fuente × estado × archivado (todas las cuentas; sin IDs, títulos ni dueños) y estados
// imposibles: un episodio en producción (authorized/generating) marcado como archivado.
for (const t of ["podcast_studio_episodes", "podcast_episodes"]) {
  const r = await rest(`${t}?select=status,archived_at`, { Range: "0-49999" });
  const rows = r.status === 200 || r.status === 206 ? await r.json() : [];
  const agg = {}; let imposibles = 0;
  for (const o of rows) { const k = `${o.status}|${o.archived_at ? "archivado" : "visible"}`; agg[k] = (agg[k] ?? 0) + 1; if (o.archived_at && ["authorized", "generating"].includes(o.status)) imposibles++; }
  console.log(`AGREGADO ${t} ${JSON.stringify({ http: r.status, filas: rows.length, porEstado: agg })}`);
  ok(`estados imposibles en ${t}: ninguno en producción y archivado`, imposibles === 0, `n=${imposibles}`);
}

// 2) Libro real del guion largo: por proyecto y nombre de paso. Claves nuevas («script:<paso>:paso») nunca duplicadas.
{
  const r = await rest(`pi_paid_operations?select=project_id,shot_id,status,committed_usd,created_at&project_id=like.studio-script:*&order=created_at.asc&limit=1000`);
  const rows = r.status === 200 ? await r.json() : [];
  const byStep = new Map(); let nuevas = 0, viejas = 0, usd = 0;
  for (const o of rows) {
    const step = String(o.shot_id).split(":")[1] ?? "?";
    if (String(o.shot_id).endsWith(":paso")) nuevas++; else viejas++;
    usd += Number(o.committed_usd ?? 0);
    const k = `${o.project_id}|${step}`; byStep.set(k, [...(byStep.get(k) ?? []), o]);
  }
  const dupNuevas = [...byStep.values()].filter((v) => v.filter((o) => String(o.shot_id).endsWith(":paso")).length > 1).length;
  const dupPagadas = [...byStep.values()].filter((v) => v.filter((o) => o.status === "COMMITTED").length > 1).length;
  console.log(`LIBRO_GUION ${JSON.stringify({ http: r.status, filas: rows.length, claveNueva: nuevas, claveAntigua: viejas, trabajos: new Set(rows.map((o) => o.project_id)).size, usdComprometido: Math.round(usd * 1e4) / 1e4, pasosConMasDeUnCobro: dupPagadas, estados: rows.reduce((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {}) })}`);
  ok("libro: ninguna clave por paso («:paso») duplicada", dupNuevas === 0, `duplicadas=${dupNuevas}`);
}

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const input = (d) => {
  const minutes = Math.round(Math.min(60, Math.max(1, Number(d.minutes) || 5)));
  return { topic: String(d.topic ?? "").trim().slice(0, 2000), minutes, hostName: String(d.participants?.[0]?.name ?? "").slice(0, 60) || "Anfitrión", guestName: String(d.participants?.[1]?.name ?? "").slice(0, 60) || "Invitado",
    guestRole: String(d.participants?.[1]?.role ?? "").slice(0, 120), hostPersonality: String(d.participants?.[0]?.personality ?? "").slice(0, 300), guestPersonality: String(d.participants?.[1]?.personality ?? "").slice(0, 300) };
};
for (const [label, opts] of [["escritorio", { viewport: { width: 1366, height: 900 } }], ["movil", { ...devices["iPhone 13"] }]]) {
  const ctx = await browser.newContext({ ...opts, storageState: stateFor() });
  await ctx.addInitScript(() => { try { localStorage.setItem("atomivid_onboarding_completed_v1", "1"); } catch {} });
  const p = await ctx.newPage();
  const shot = (n) => p.screenshot({ path: path.join(EVID, `cierre-${FASE}-${label}-${n}.png`), fullPage: true }).catch(() => {});
  const W = () => p.getByTestId("podcast-wizard");
  const posts = [], writes = [];
  // Toda petición que no sea GET (cualquier destino), solo método + host + ruta, sin cuerpo: identifica escrituras al cargar.
  p.on("request", (req) => { if (req.method() !== "GET") { try { const u = new URL(req.url()); writes.push(`${req.method()} ${u.host}${u.pathname}`); } catch {} } });
  await p.route("**/api/podcast/**", async (route) => {
    const req = route.request(); if (req.method() === "GET") return route.continue();
    const body = req.postData() ?? "";
    posts.push(/"action":"(\w[\w-]*)"/.exec(body)?.[1] ?? "?");
    if (/"__sonda":"otro-trabajo"/.test(body)) return route.continue(); // sonda marcada: el servidor la rechaza antes de la IA
    return route.abort("failed");
  });
  const hydrated = () => p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 60000 });
  const draft = () => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "{}"), KEY);
  try {
    await p.goto(`${APP}/dashboard/podcast`);
    if (!ok(`${label}: abre el estudio con la sesión del dueño`, new URL(p.url()).hostname === HOST && /\/dashboard\/podcast/.test(p.url()), p.url())) { await ctx.close(); continue; }
    await hydrated(); await p.waitForTimeout(3000);
    console.log(`CARGA_NO_GET ${label} ${JSON.stringify(writes)}`);
    ok(`${label}: al cargar /dashboard/podcast no hay escrituras a la app (POST/PUT/PATCH/DELETE a ${HOST})`, writes.filter((w) => w.split(" ")[1].startsWith(HOST)).length === 0, JSON.stringify(writes));
    // 3a) Cuenta con sesión (GET de solo lectura).
    const who = await p.evaluate(async () => { const r = await fetch("/api/podcast/v3", { cache: "no-store" }); return { status: r.status, body: await r.json().catch(() => null) }; });
    ok(`${label}: GET /api/podcast/v3 devuelve la cuenta con sesión`, who.status === 200 && who.body?.ownerId === OWNER, `HTTP ${who.status}`);
    // Borrador de prueba con un trabajo a medias de la configuración actual (solo en este navegador).
    await W().getByTestId("modalidad-dialogo").click().catch(() => {});
    const topic = "Cierre QA: Base Dulce (prueba sin generar)";
    const dd = { ...(await draft()), topic, title: "Cierre QA (no se genera)", mode: "dialogo", minutes: 30, step: 1 };
    const inp = input(dd); const n = 3;
    dd.scriptJob = { v: 1, jobId: JOB, input: inp, plan: { title: "t", segments: Array.from({ length: n }, (_, j) => ({ title: `B${j + 1}`, points: ["a", "b"] })) }, segments: [[{ speaker: "A", text: "Hola." }]], attempts: { plan: 1, s0: 1 }, partial: null };
    await p.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(dd)]);
    await p.reload(); await hydrated();
    for (let i = 0; i < 6 && !(await W().getByLabel("Tema", { exact: true }).isVisible().catch(() => false)); i++) { await W().getByRole("button", { name: "Siguiente", exact: true }).click().catch(() => {}); await p.waitForTimeout(400); }
    await shot("1-retomado");
    const btn = await W().getByTestId("generar-guion").innerText().catch(() => "");
    ok(`${label}: trabajo a medias → «Continuar la conversación (bloque 2 de 3)»`, /Continuar la conversación \(bloque 2 de 3\)/.test(btn), btn);
    ok(`${label}: aviso «Retomaste tu borrador»`, (await p.getByTestId("borrador-retomado").count()) === 1);
    if (FASE === "273") {
      // #273 desplegado: el progreso guardado se ve (antes, «0 caracteres» con bloques guardados).
      const g = await W().getByTestId("progreso-guardado").innerText().catch(() => "");
      ok(`${label}: #273 en producción: panel «Guardado en este navegador: 1 de 3 bloques»`, /Guardado en este navegador: 1 de 3 bloques/.test(g), g.slice(0, 160));
    }
    // 3b) Sonda de servidor: el MISMO trabajo con OTRA configuración → 409 OTRO_TRABAJO sin IA (o 503 si la IA está apagada).
    const probe = await p.evaluate(async ([st]) => {
      const r = await fetch("/api/podcast/v3", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "script-step", __sonda: "otro-trabajo", topic: "Otra configuración (sonda de cierre)", minutes: 20, hostName: "X", guestName: "Y", state: st }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [dd.scriptJob]);
    ok(`${label}: servidor: trabajo de otra configuración → 409 OTRO_TRABAJO, sin jobId nuevo (o 503 IA apagada)`, (probe.status === 409 && probe.body?.code === "OTRO_TRABAJO" && probe.body?.state === undefined) || (probe.status === 503 && probe.body?.code === "IA_NO_DISPONIBLE"), JSON.stringify({ s: probe.status, code: probe.body?.code }));
    // 4) Cambio de tema → aviso → volver con el MISMO jobId.
    await W().getByLabel("Tema", { exact: true }).fill(`${topic} (cambiado)`);
    const stale = await W().getByTestId("trabajo-distinto").waitFor({ timeout: 10000 }).then(() => true, () => false);
    await shot("2-trabajo-distinto");
    ok(`${label}: con otra configuración aparece «trabajo-distinto» y no «Generar»`, stale && (await W().getByTestId("generar-guion").count()) === 0);
    if (stale) {
      await W().getByTestId("volver-configuracion").click();
      await W().getByTestId("generar-guion").waitFor({ timeout: 10000 });
      const back = await draft();
      ok(`${label}: «Volver a esa configuración» restaura el tema y conserva el MISMO jobId`, back.topic === topic && back.scriptJob?.jobId === JOB, JSON.stringify({ t: back.topic === topic, j: back.scriptJob?.jobId === JOB }));
      ok(`${label}: el borrador activo lleva su cuenta`, back.ownerId === OWNER);
    }
    // «Empezar de nuevo» aparca; «Recuperar» devuelve.
    await W().getByTestId("empezar-de-nuevo").click();
    await p.waitForTimeout(800);
    const parked = await p.evaluate(([k, r]) => { const l = JSON.parse(localStorage.getItem(r) || "null"); return { v: l?.v, first: l?.items?.[0]?.raw ? JSON.parse(l.items[0].raw) : null, active: JSON.parse(localStorage.getItem(k) || "{}") }; }, [KEY, REC]);
    ok(`${label}: «Empezar de nuevo» aparca el trabajo (sobre v1) y abre uno vacío`, parked.v === 1 && parked.first?.scriptJob?.jobId === JOB && !parked.active.scriptJob, JSON.stringify({ v: parked.v, j: parked.first?.scriptJob?.jobId === JOB }));
    await W().getByTestId("recuperar-borrador").click();
    await p.waitForTimeout(800);
    ok(`${label}: «Recuperar el borrador anterior» devuelve el mismo trabajo`, (await draft()).scriptJob?.jobId === JOB);
    await shot("3-recuperado");
    // Borrador CRUDO antiguo (formato 16ab4473) en la clave de recuperación.
    const raw = JSON.stringify({ ...dd, title: "Crudo antiguo QA", ownerId: undefined });
    await p.evaluate(([k, r, v]) => { localStorage.setItem(r, v); localStorage.removeItem(k); }, [KEY, REC, raw]);
    await p.reload(); await hydrated();
    const canRecover = await W().getByTestId("recuperar-borrador").waitFor({ timeout: 10000 }).then(() => true, () => false);
    if (ok(`${label}: un borrador crudo antiguo ofrece «Recuperar»`, canRecover)) {
      await W().getByTestId("recuperar-borrador").click(); await p.waitForTimeout(800);
      const got = await draft();
      ok(`${label}: el crudo antiguo vuelve con su jobId`, got.title === "Crudo antiguo QA" && got.scriptJob?.jobId === JOB);
    }
    // Fase 269: la entrada «Personalizado» desde la portada abre configuración nueva y aparca la actual.
    if (FASE === "269") {
      const tok = `nueva-${crypto.randomUUID()}`;
      await p.goto(`${APP}/dashboard/podcast?modo=personalizado&entrada=${tok}&idea=${encodeURIComponent("Idea desde la portada QA")}`); await hydrated();
      const st = await p.evaluate(([k, r]) => ({ active: JSON.parse(localStorage.getItem(k) || "{}"), list: JSON.parse(localStorage.getItem(r) || "null") }), [KEY, REC]);
      const topics = (st.list?.items ?? []).map((x) => { try { return JSON.parse(x.raw).title; } catch { return null; } });
      ok(`${label}: Personalizado abre una configuración nueva con la idea y sin trabajo`, st.active.topic === "Idea desde la portada QA" && !st.active.scriptJob, st.active.topic);
      ok(`${label}: Personalizado aparca el borrador anterior en la MISMA lista (parser único)`, st.list?.v === 1 && topics.includes("Crudo antiguo QA"), JSON.stringify(topics));
      await shot("4-personalizado");
    }
    ok(`${label}: la interfaz no envió ninguna escritura (solo la sonda marcada)`, posts.every((a) => a === "script-step") && posts.length <= 1, JSON.stringify(posts));
  } catch (e) { ok(`${label}: recorrido sin excepciones`, false, String(e?.message ?? e)); await shot("error"); }
  await ctx.close();
}
await browser.close();
const AFTER = await counts();
console.log(`COUNTS_AFTER ${JSON.stringify(AFTER)}`);
ok("nada creado ni cobrado (episodios y libro iguales)", JSON.stringify(AFTER) === JSON.stringify(BEFORE), JSON.stringify({ BEFORE, AFTER }));
console.log(`RESULT pod-cierre fase ${FASE}: ${passes} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);

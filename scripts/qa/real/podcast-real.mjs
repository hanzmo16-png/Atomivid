// Real validation of Podcast Studio from the OWNER's account in PRODUCTION (closure 2026-10-27, authorized by the owner).
// CASO=preflight: USD 0 — studio visible, El Duro selectable, avatars, estimate shown; nothing is authorized.
// CASO=p1 (≤ USD 1): 1-minute narration with El Duro + stock images → MP4. CASO=p2 (≤ USD 3): 2-avatar conversation.
// The budget is the per-episode authorization the database cap trigger enforces; the run STOPS before authorizing if the
// estimate exceeds it. Prints only non-sensitive facts; screenshots go to $EVID (encrypted afterwards by the workflow).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";

const APP = process.env.APP_URL || "https://atomivid.vercel.app";
const CASO = process.env.CASO, BUDGET = Number(process.env.BUDGET_USD || 0), OWNER = process.env.OWNER_ID, EVID = process.env.EVID;
const STATE = process.env.STATE_FILE, STATE2 = process.env.STATE_FILE_2, DURO = "CeFSZuaHs4SxcBxb9nCr";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let fails = 0; const facts = {};
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!cond) fails++; return cond; };
const stop = (why) => { console.log(`STOP ${why}`); finish(); };
function finish() { fs.writeFileSync(path.join(EVID, "facts.json"), JSON.stringify(facts, null, 1)); console.log(`RESULT podcast-real ${CASO}: ${fails} FAIL`); process.exit(fails ? 1 : 0); }
fs.mkdirSync(EVID, { recursive: true });
const shot = async (p, n) => { await p.screenshot({ path: path.join(EVID, `${CASO}-${n}.png`), fullPage: true }).catch(() => {}); };

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const desktop = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const p = await desktop.newPage();
const W = () => p.getByTestId("podcast-wizard");
const next = () => W().getByRole("button", { name: "Siguiente" }).click();
const stepTitle = async () => (await W().getByTestId("wizard-step-title").textContent()) ?? "";
const atStep = async (n) => { await p.waitForFunction((k) => (document.querySelector('[data-testid="wizard-step-title"]')?.textContent ?? "").includes(`Paso ${k}`), n, { timeout: 30000 }).catch(() => {}); return (await stepTitle()).includes(`Paso ${n}`); };

// Bienvenida/tour u otros modales del panel: se cierran como lo haría el usuario («Omitir» o Escape).
const dismiss = async (pg) => { for (const n of ["Omitir", "Cerrar", "Entendido", "Saltar"]) await pg.getByRole("button", { name: n }).first().click({ timeout: 2500 }).catch(() => {}); await pg.keyboard.press("Escape").catch(() => {}); };
await p.goto(`${APP}/dashboard/podcast`); await dismiss(p);
ok("owner session: /dashboard/podcast opens (not redirected to login)", !/\/login/.test(p.url()), new URL(p.url()).pathname);
await p.evaluate(() => localStorage.removeItem("atomivid.podcast.asistente.v2")); await p.reload(); await dismiss(p);
const hydrated = await p.locator('[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ timeout: 60000 }).then(() => true, () => false);
ok("studio wizard visible and hydrated for the owner", hydrated); await shot(p, "00-estudio");
if (!hydrated) stop("studio not available for the owner");

const mode = CASO === "p2" ? "dialogo" : "visual";
await W().getByTestId(`modalidad-${mode}`).click(); await next();
const title = `Prueba real ${CASO.toUpperCase()} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
facts.title = title;
await W().getByLabel("Título del episodio").fill(title);
const P1 = "El cometa interestelar que cruzó nuestro sistema solar dejó a los astrónomos con más preguntas que respuestas. Viajaba demasiado rápido para estar atado al Sol, y su brillo cambiaba de una forma que nadie esperaba. En este episodio repasamos qué se observó, qué se descartó y qué sigue abierto. Primero, la velocidad: más de cincuenta kilómetros por segundo al entrar. Segundo, la forma: alargada, quizá aplanada. Tercero, el gas: casi invisible. Cada dato cuenta una parte de la historia, y juntos dibujan un visitante que no se parece a nada de lo que conocíamos. Lo que sí sabemos es que vino de otra estrella y que ya se aleja para siempre.";
const P2 = "Ana: ¿De verdad un cometa puede venir de otra estrella?\nLuis: Sí, y lo sabemos por su velocidad: ningún objeto ligado al Sol va tan rápido.\nAna: ¿Y no podría ser un error de medición?\nLuis: Lo midieron varios observatorios durante semanas. Los datos coinciden.\nAna: Entonces, ¿qué nos dice de su origen?\nLuis: Que los sistemas planetarios expulsan restos, y algunos cruzan el espacio durante millones de años.\nAna: Me cuesta imaginarlo. ¿Volverá?\nLuis: No. Va de salida, y nunca más lo veremos.";
await W().getByLabel("Guion").fill(CASO === "p2" ? P2 : P1); await shot(p, "02-guion"); await next();
await atStep(3);
if (CASO === "p2") { for (const [l, v] of [["Personalidad A", "Curiosa, pregunta"], ["Personalidad B", "Experto, responde con datos"]]) { const f = W().getByLabel(l); if (await f.count()) await f.fill(v); } }
await shot(p, "03-participantes"); await next();
ok("step 4 voices", await atStep(4), await stepTitle());
const duro = await W().locator(`option[value="${DURO}"]`).evaluateAll((os) => os.map((o) => ({ disabled: o.disabled, text: (o.textContent || "").trim() })));
facts.elDuro = duro;
ok("El Duro offered and selectable for the owner (private grant)", duro.length > 0 && duro.some((o) => !o.disabled), JSON.stringify(duro));
if (!duro.some((o) => !o.disabled)) { await shot(p, "04-voces"); stop("El Duro not available"); }
await W().getByLabel("Voz A").selectOption(DURO);
if (CASO === "p2") {
  const others = await W().getByLabel("Voz B").locator("option:not([disabled])").evaluateAll((os) => os.map((o) => o.value).filter((v) => v && v !== "CeFSZuaHs4SxcBxb9nCr"));
  ok("a second voice exists for B", others.length > 0, `${others.length} options`); if (!others.length) stop("no second voice");
  await W().getByLabel("Voz B").selectOption(others[0]);
}
await shot(p, "04-voces"); await next();
ok("step 5 avatars", await atStep(5), await stepTitle());
if (CASO === "p2") {
  for (const t of ["A", "B"]) {
    const sel = W().getByLabel(`Avatar ${t}`);
    const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, d: o.disabled })).filter((o) => o.v && !o.d));
    facts[`avatars${t}`] = opts.length;
    if (!ok(`owner has a ready avatar for ${t}`, opts.length > (t === "B" ? 1 : 0) || opts.length > 0, `${opts.length}`)) stop(`no avatar for ${t}`);
    await sel.selectOption(opts[t === "B" && opts.length > 1 ? 1 : 0].v);
  }
}
await shot(p, "05-avatares"); await next();
ok("step 6 music", await atStep(6), await stepTitle()); await W().getByLabel("Ambiente musical").selectOption("auto"); await shot(p, "06-musica"); await next();
ok("step 7 visuals", await atStep(7), await stepTitle());
const pexels = W().getByLabel("Fotos de archivo (Pexels)"); if (await pexels.count()) await pexels.check();
const rc = await W().getByTestId("proveedor-recraft").textContent().catch(() => "");
ok("Recraft shown as not available (out of scope, not offered as working)", /No disponible/.test(rc || ""), (rc || "").slice(0, 80));
await shot(p, "07-visuales"); await next();
ok("step 8 budget and estimate", await atStep(8), await stepTitle());
await W().getByTestId("wizard-estimate").locator("table").waitFor({ timeout: 60000 });
await W().getByLabel("Presupuesto máximo").fill(String(BUDGET || 1));
const estText = (await W().getByTestId("wizard-estimate").textContent()) || "";
facts.estimateText = estText.replace(/\s+/g, " ").slice(0, 400);
await shot(p, "08-presupuesto"); await next();
ok("step 9 preview", await atStep(9), await stepTitle()); await shot(p, "09-vista-previa"); await next();
ok("step 10 authorize", await atStep(10), await stepTitle());
const confirmText = (await W().textContent()) || "";
const m = confirmText.match(/Costo estimado:\s*([^\s.]*?\$\s?[\d.,]+|[\d.,]+\s?US\$)/);
const est = m ? Number(m[1].replace(/[^\d.,]/g, "").replace(",", ".")) : NaN;
facts.estimateUsd = est; facts.budgetUsd = BUDGET;
ok("estimate shown before authorizing", Number.isFinite(est), m ? m[1] : confirmText.slice(0, 120));
await shot(p, "10a-confirmar");
const disabledBefore = await W().getByRole("button", { name: "Generar episodio" }).isDisabled();
ok("cannot generate without the explicit authorization checkbox", disabledBefore);
if (CASO === "preflight") { console.log("INFO preflight: stopped at the authorization step; nothing authorized or charged"); await browser.close(); finish(); }
if (!(Number.isFinite(est) && est <= BUDGET)) stop(`estimate ${est} exceeds the authorized budget ${BUDGET}: not authorizing`);

await W().getByLabel("Autorizo el cargo").check(); await W().getByRole("button", { name: "Generar episodio" }).click();
await W().getByTestId("wizard-progress").waitFor({ timeout: 60000 }); await shot(p, "10b-progreso");
let row; for (let i = 0; i < 30 && !row; i++) { const { data } = await db.from("podcast_studio_episodes").select("id,status,authorized_usd").eq("user_id", OWNER).eq("title", title).order("created_at", { ascending: false }).limit(1); row = data?.[0]; if (!row) await p.waitForTimeout(2000); }
if (!ok("episode created and authorized from the account", !!row && ["authorized", "generating", "ready"].includes(row.status), row?.status)) stop("no episode");
facts.episode = row.id; facts.authorizedUsd = Number(row.authorized_usd);
ok("authorized amount == budget chosen in the wizard", Math.abs(Number(row.authorized_usd) - BUDGET) < 1e-6, `${row.authorized_usd}`);
const t0 = Date.now(); let ep;
while (Date.now() - t0 < 50 * 60_000) { const { data } = await db.from("podcast_studio_episodes").select("id,status,progress,error,cost_usd,authorized_usd,video_path,audio_path,result").eq("id", row.id).single(); ep = data; if (["ready", "failed"].includes(ep?.status)) break; await new Promise((r) => setTimeout(r, 20000)); }
facts.status = ep?.status; facts.minutes = Math.round((Date.now() - t0) / 6000) / 10; facts.costUsd = Number(ep?.cost_usd); facts.error = ep?.error ?? null;
ok("episode generated with real providers (status ready)", ep?.status === "ready", `${ep?.status} ${ep?.error ?? ""} in ${facts.minutes} min`);
const { data: ops } = await db.from("podcast_studio_operations").select("key,provider,op,state,reserved_usd,actual_usd").eq("episode_id", row.id);
const keys = (ops || []).map((o) => o.key); facts.ops = (ops || []).reduce((a, o) => { const k = `${o.provider}/${o.op}/${o.state}`; a[k] = (a[k] || 0) + 1; return a; }, {});
const settled = (ops || []).reduce((s, o) => s + (o.state === "settled" ? Number(o.actual_usd ?? o.reserved_usd) : 0), 0);
facts.settledUsd = Math.round(settled * 10000) / 10000;
ok("no duplicated provider operation (idempotency key unique)", new Set(keys).size === keys.length, `${keys.length} ops`);
ok("no uncertain or still-reserved charge left", !(ops || []).some((o) => o.state === "uncertain" || o.state === "reserved"), JSON.stringify(facts.ops));
ok("spend within the authorization (ledger and episode cost)", settled <= facts.authorizedUsd + 1e-6 && (Number.isNaN(facts.costUsd) || facts.costUsd <= facts.authorizedUsd + 1e-6), `ledger ${facts.settledUsd} / episode ${facts.costUsd} / authorized ${facts.authorizedUsd}`);
if (ep?.status !== "ready") { await browser.close(); finish(); }

async function checkCard(page, tag) {
  await page.goto(`${APP}/dashboard/podcast`); await dismiss(page); const card = page.getByTestId(`studio-episode-${row.id}`);
  const seen = await card.waitFor({ timeout: 60000 }).then(() => true, () => false);
  ok(`${tag}: episode listed in «Tus episodios»`, seen); if (!seen) return null;
  const player = card.getByTestId(ep.video_path ? "studio-player" : "studio-audio-player");
  const play = await player.evaluate(async (v) => { v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 4000)); const o = { rs: v.readyState, t: v.currentTime, d: v.duration, err: v.error?.code ?? null }; v.pause(); return o; });
  ok(`${tag}: plays in the browser`, play.rs >= 2 && play.t > 0.5 && !play.err, JSON.stringify(play));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${tag}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
  await shot(page, `${tag}-lista`);
  return card.getByTestId(ep.video_path ? "studio-download-mp4" : "studio-download-audio").getAttribute("href");
}
const href = await checkCard(p, "escritorio");
if (href) {
  const res = await fetch(href); const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(EVID, "..", `descarga-${CASO}${ep.video_path ? ".mp4" : ".mp3"}`); fs.writeFileSync(file, buf);
  const sha = crypto.createHash("sha256").update(buf).digest("hex"); facts.download = { http: res.status, bytes: buf.length, sha256: sha };
  const stored = ep.video_path || ep.audio_path; const { data: blob } = await db.storage.from("videos").download(stored);
  const sha2 = blob ? crypto.createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex") : null;
  ok("download from the account == stored file (sha256)", res.ok && sha === sha2, `${buf.length} bytes`);
  try {
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file]).toString());
    facts.media = pr; const v = pr.streams.find((s) => s.codec_type === "video"), a = pr.streams.find((s) => s.codec_type === "audio");
    ok("media: audio stream present and duration ≥ 30 s", !!a && Number(pr.format.duration) >= 30, `${pr.format.duration}s ${v ? `${v.codec_name} ${v.width}x${v.height}` : "audio only"} / ${a?.codec_name}`);
    if (ep.video_path) {
      ok("media: video stream present", !!v);
      const loud = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
      facts.loudness = (loud.match(/I:\s*(-?[\d.]+) LUFS/g) || []).slice(-1)[0] ?? null;
    }
  } catch (e) { ok("media probe", false, String(e).slice(0, 120)); }
}
const mobile = await browser.newContext({ ...devices["Pixel 7"], storageState: STATE }); await checkCard(await mobile.newPage(), "movil-emulado");
const again = await browser.newContext({ storageState: STATE2, viewport: { width: 1280, height: 800 } }); await checkCard(await again.newPage(), "nueva-sesion");
await browser.close(); finish();

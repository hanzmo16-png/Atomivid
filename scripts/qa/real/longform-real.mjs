// Real validation of YouTube Long Form from the OWNER's account in PRODUCTION (closure 2026-10-27, authorized by the owner).
// One 5–8 minute video with stock footage: topic → script (real LLM, with editorial review and sources) → visual plan →
// budget confirmation → full production → playback and download. CAP_USD is the hard ceiling for the whole case: the run
// STOPS before confirming if the script spend plus the production limit shown by the app exceeds it.
// Prints only non-sensitive facts; screenshots go to $EVID (encrypted by the workflow).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium, devices } from "playwright";

const APP = process.env.APP_URL || "https://atomivid.vercel.app";
const CAP = Number(process.env.BUDGET_USD || 0), AUTO_PRIOR = process.env.LF_PRIOR_USD === "auto", PRIOR = AUTO_PRIOR ? 0 : Number(process.env.LF_PRIOR_USD || 0), OWNER = process.env.OWNER_ID, EVID = process.env.EVID, MIN = Number(process.env.LF_MINUTES || 5);
const STATE = process.env.STATE_FILE, STATE2 = process.env.STATE_FILE_2, REUSE = process.env.LF_REQUEST_ID || "";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let fails = 0; const facts = { capUsd: CAP };
const ok = (n, c, i = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${i ? ` — ${i}` : ""}`); if (!c) fails++; return c; };
function finish() { fs.writeFileSync(path.join(EVID, "facts.json"), JSON.stringify(facts, null, 1)); console.log(`RESULT longform-real: ${fails} FAIL`); process.exit(fails ? 1 : 0); }
const stop = (why) => { console.log(`STOP ${why}`); finish(); };
fs.mkdirSync(EVID, { recursive: true });
const shot = async (p, n) => { await p.screenshot({ path: path.join(EVID, `lf-${n}.png`), fullPage: true }).catch(() => {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skipTour = (p) => p.getByRole("button", { name: "Omitir" }).click({ timeout: 4000 }).catch(() => {});
const spent = async (R) => {
  const { data } = await db.from("pi_paid_operations").select("*").eq("project_id", R);
  const ops = data || [];
  const usd = ops.reduce((s, o) => s + Math.max(Number(o.committed_usd ?? 0), ["RESERVED", "SUBMITTED", "RECONCILIATION_REQUIRED"].includes(o.status) ? Number(o.reserved_usd ?? 0) : 0), 0);
  return { ops, usd: Math.round(usd * 10000) / 10000 };
};

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage(); const main = () => p.locator("main").innerText();
let R = REUSE;
// «hash:<6>»: the request is named in reports by the sha256 prefix of its id (ids are not printed); resolve it among the
// owner's own requests so a retry keeps the SAME request (and its paid script responses) instead of creating a new one.
if (R.startsWith("hash:")) {
  // Same table and hashing as the read-only diagnostics that named it (documentary_script_jobs.request_id).
  const want = R.slice(5); const { data: jobs, error: je } = await db.from("documentary_script_jobs").select("request_id").eq("user_id", OWNER).order("created_at", { ascending: false }).limit(200);
  if (je) console.log(`INFO script jobs lookup error: ${je.message}`);
  const hits = [...new Set((jobs || []).map((x) => x.request_id).filter(Boolean))].filter((id) => crypto.createHash("sha256").update(id).digest("hex").startsWith(want)).map((id) => ({ id }));
  if (!ok("reuse: the referenced request exists in the owner's account (unique)", hits.length === 1, `${hits.length} match(es)`)) stop("request reference not unique");
  R = hits[0].id; facts.reusedRequest = R.slice(0, 8);
}
if (!R) {
  const topic = process.env.LF_TOPIC || `La sonda Voyager 1 y el límite del sistema solar (prueba real ${new Date().toISOString().slice(0, 10)})`;
  facts.topic = topic;
  await p.goto(`${APP}/dashboard/long-form/new`); await skipTour(p);
  ok("owner session: Long Form form opens", /long-form\/new/.test(p.url()), new URL(p.url()).pathname);
  await p.fill("input[name=topic]", topic); await p.selectOption("select[name=language]", "es"); await p.fill("input[name=duration_minutes]", String(MIN));
  await shot(p, "A01-formulario");
  await p.getByRole("button", { name: "Crear y revisar guion" }).click(); await p.waitForURL((u) => !String(u).includes("/long-form/new"), { timeout: 60000 });
  let job; for (let i = 0; i < 30 && !job; i++) { const { data } = await db.from("documentary_script_jobs").select("id,request_id,status").eq("user_id", OWNER).order("created_at", { ascending: false }).limit(1); job = data?.[0]?.request_id ? data[0] : null; if (!job) await sleep(2000); }
  if (!ok("request and durable script job created from the account", !!job)) stop("no request");
  R = job.request_id;
}
facts.request = R;
// A reused request that stopped before spending for lack of stock (#238): reopen it from the account with the
// app's own button («Volver a configurar la producción»); the server proves $0 production spend first.
if (REUSE) {
  const { data: vr } = await db.from("video_requests").select("status,error_message").eq("id", R).single();
  if (vr?.status === "failed") {
    await p.goto(`${APP}/dashboard/videos/${R}`, { timeout: 180000 }); await skipTour(p); await shot(p, "R0-fallido");
    const btn = p.getByRole("button", { name: "Volver a configurar la producción" });
    const shown = await btn.waitFor({ timeout: 60000 }).then(() => true, () => false);
    if (!ok("reconfigure offered on the failed request (material stop, $0)", shown, (vr.error_message || "").slice(0, 80))) stop("no reconfigure button");
    await btn.click(); await p.waitForURL(/long-form\/configure\//, { timeout: 120000 }).catch(() => {});
    const { data: after } = await db.from("video_requests").select("status,long_form_confirmed_at").eq("id", R).single();
    ok("request back to script_ready, confirmation cleared, paid script kept", after?.status === "script_ready" && !after?.long_form_confirmed_at, JSON.stringify(after));
    facts.reopened = true;
  }
}
// A reused request whose script job is QUEUED (waiting for the provider's next period) is woken with the same event the
// app sends (prepare-documentary-script + jobId): no requeue, no state change; the worker replays saved paid responses.
if (REUSE) {
  const { data: q } = await db.from("documentary_script_jobs").select("id,status").eq("request_id", R).order("created_at", { ascending: false }).limit(1);
  if (q?.[0]?.status === "queued" && process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/dispatches`, { method: "POST", headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json" }, body: JSON.stringify({ event_type: "prepare-documentary-script", client_payload: { jobId: q[0].id } }) });
    ok("reuse: queued script job woken with the app's own worker event", res.status === 204, `HTTP ${res.status}`); facts.wokeJob = q[0].id.slice(0, 8);
  }
}
// Script generation (real LLM, editorial review): wait for the job to finish.
let jobDone; const t0 = Date.now();
while (Date.now() - t0 < 40 * 60000) { const { data } = await db.from("documentary_script_jobs").select("id,status,error_message").eq("request_id", R).order("created_at", { ascending: false }).limit(1); jobDone = data?.[0]; if (["completed", "failed"].includes(jobDone?.status)) break; await sleep(20000); }
facts.scriptJob = { status: jobDone?.status, minutes: Math.round((Date.now() - t0) / 6000) / 10, error: jobDone?.error_message ?? null };
if (!ok("script generated with editorial review (job completed)", jobDone?.status === "completed", JSON.stringify(facts.scriptJob))) stop("script job not completed");
const s1 = await spent(R); facts.scriptSpendUsd = s1.usd;
// LF_PRIOR_USD=auto: ledger reconciliation of EVERYTHING Long Form since the case started (2026-10-27): script calls
// (documentary:* projects) + paid production of the owner's requests, settled at cost and open rows at their reservation.
// Includes this request's script spend, so the check is total + production ceiling ≤ case cap.
let lfTotal = null;
if (AUTO_PRIOR) {
  const { data: reqs } = await db.from("video_requests").select("id").eq("user_id", OWNER).gte("created_at", "2026-10-26T00:00:00Z");
  const ids = new Set((reqs || []).map((x) => x.id));
  const { data: ops } = await db.from("pi_paid_operations").select("project_id,status,reserved_usd,committed_usd").gte("created_at", "2026-10-27T00:00:00Z");
  const mine = (ops || []).filter((o) => String(o.project_id).startsWith("documentary:") || ids.has(o.project_id));
  lfTotal = Math.round(mine.reduce((a, o) => a + (o.status === "COMMITTED" ? Number(o.committed_usd ?? o.reserved_usd) : ["RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED"].includes(o.status) ? Number(o.reserved_usd ?? 0) : o.status === "REFUNDED" ? 0 : Number(o.committed_usd ?? 0)), 0) * 10000) / 10000;
  facts.lfSpendSinceCaseStartUsd = lfTotal; facts.lfOpsSinceCaseStart = mine.length;
  console.log(`INFO Long Form ledger since 2026-10-27: USD ${lfTotal} over ${mine.length} paid operations (case cap ${CAP})`);
}
const base = (pageScript) => (lfTotal ?? PRIOR + pageScript);
await p.goto(`${APP}/dashboard/long-form/configure/${R}`, { timeout: 180000 }); await skipTour(p);
for (const t of ["Ver estructura narrativa", "Ver referencias recuperadas"]) await p.getByText(t).first().click().catch(() => {});
await p.getByText(/Revisar el guion \(/).first().click().catch(() => {});
let txt = await main(); await shot(p, "C01-configurar");
ok("review: editorial review completed and shown", /Revisión editorial completada/.test(txt), txt.slice(0, 160));
ok("review: sources listed", /Referencias|Fuentes/.test(txt));
ok("visual plan shown (strategy, production plan, preflight)", /Estrategia visual/.test(txt) && /Plan de producción/.test(txt) && /Comprobación previa/.test(txt));
ok("nothing is generated or charged before confirming (stated)", /Nada se genera ni se cobra hasta que confirmes/.test(txt));
// Imágenes del proveedor actual (Recraft es opcional y no debe condicionar la prueba); estrategia: la primera que pase la
// comprobación previa sin tocar ningún control (Equilibrado → Económico → Cinemático).
await p.getByLabel(/Proveedor actual/).check().catch(() => {}); await sleep(1500);
const isBlocked = (t) => /IMPEDIMENTO DE ENTREGA|No se puede iniciar todavía|no puede iniciar todavía|Impedimento: |Material de archivo: /.test(t);
let blocked = true; facts.strategies = {};
const usdOf = (re) => Number(((txt.match(re) || [])[1] || "NaN").replace(",", "."));
const money = () => ({ script: usdOf(/Guion ya gastado\s*USD\s*([0-9]+[.,][0-9]+)/), ceiling: usdOf(/Techo que se autorizaría\s*USD\s*([0-9]+[.,][0-9]+)/), limit: usdOf(/Límite autorizado por producción\s*USD\s*([0-9]+[.,][0-9]+)/) });
// La primera estrategia que pasa la comprobación previa Y cuyo techo cabe en lo que queda del tope del caso.
for (const st of ["Económico / archivo", "Equilibrado", "Cinemático / IA"]) {
  await p.getByText(st, { exact: true }).first().click().catch(() => {}); await sleep(2000);
  txt = await main(); const b = isBlocked(txt), m = money(), fits = base(m.script) + m.ceiling <= CAP + 1e-6;
  facts.strategies[st] = b ? (txt.match(/(Esta producción no puede iniciar[^\n]*)/) || [""])[0] : `OK ceiling ${m.ceiling}${fits ? "" : " (does not fit the case cap)"}`;
  if (!b) blocked = false;
  if (!b && fits) { facts.strategy = st; break; }
}
await shot(p, "C01b-estrategia");
ok("no delivery impediment before confirming (some strategy, current image provider)", !blocked, JSON.stringify(facts.strategies));
const scriptUsd = usdOf(/Guion ya gastado\s*USD\s*([0-9]+[.,][0-9]+)/), ceiling = usdOf(/Techo que se autorizaría\s*USD\s*([0-9]+[.,][0-9]+)/), limit = usdOf(/Límite autorizado por producción\s*USD\s*([0-9]+[.,][0-9]+)/);
Object.assign(facts, { priorAttemptsUsd: PRIOR, scriptSpendUsdPage: scriptUsd, ceilingUsd: ceiling, productionLimitUsd: limit });
ok("budget: script spend and authorization ceiling visible before confirming", Number.isFinite(scriptUsd) && Number.isFinite(ceiling) && ceiling > 0, `script ${scriptUsd} / ceiling ${ceiling} / limit ${limit}`);
const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok("configure page: no horizontal overflow", overflow <= 1, `${overflow}px`);
if (blocked || !Number.isFinite(ceiling)) stop("cannot confirm (impediment or no ceiling)");
if (base(scriptUsd) + ceiling > CAP + 1e-6) stop(`spent so far ${base(scriptUsd)} + production ceiling ${ceiling} exceed the case cap ${CAP}: not confirming`);
await p.getByRole("button", { name: "Confirmar y generar video" }).click(); await sleep(6000); await shot(p, "C02-confirmado");
let r; const t1 = Date.now();
while (Date.now() - t1 < 150 * 60000) { const { data } = await db.from("video_requests").select("status,long_form_stage,video_path,error_message,duration_seconds,aspect_ratio").eq("id", R).single(); r = data; if (["completed", "failed"].includes(r?.status)) break; await sleep(30000); }
facts.production = { status: r?.status, stage: r?.long_form_stage ?? null, minutes: Math.round((Date.now() - t1) / 6000) / 10, error: r?.error_message ?? null };
ok("full video produced (status completed)", r?.status === "completed" && !!r?.video_path, JSON.stringify(facts.production));
const s2 = await spent(R); facts.totalSpendUsd = s2.usd;
const keys = s2.ops.map((o) => o.idempotency_key).filter(Boolean);
facts.ops = s2.ops.reduce((a, o) => { const k = `${o.provider}/${o.status}`; a[k] = (a[k] || 0) + 1; return a; }, {});
ok("no duplicated paid operation (idempotency keys unique)", new Set(keys).size === keys.length, `${keys.length} ops`);
ok("no uncertain charge left", !s2.ops.some((o) => ["RECONCILIATION_REQUIRED", "SUBMITTED"].includes(o.status)), JSON.stringify(facts.ops));
ok("total spend within the case cap and the confirmed limit", s2.usd <= CAP + 1e-6 && s2.usd - s1.usd <= limit + 1e-6, `${s2.usd} (script ${s1.usd} + production ${Math.round((s2.usd - s1.usd) * 10000) / 10000}) / cap ${CAP}, limit ${limit}`);
if (r?.status !== "completed") { await browser.close(); finish(); }

async function result(page, tag) {
  await page.goto(`${APP}/dashboard/videos/${R}`); await skipTour(page); await sleep(3000); await shot(page, `F-${tag}-resultado`);
  const v = page.locator("video").first();
  const play = await v.evaluate(async (el) => { el.muted = true; await el.play().catch(() => {}); await new Promise((x) => setTimeout(x, 5000)); const o = { rs: el.readyState, t: el.currentTime, d: el.duration, err: el.error?.code ?? null, tracks: el.textTracks?.length ?? 0 }; el.pause(); return o; }).catch((e) => ({ err: String(e).slice(0, 80) }));
  ok(`${tag}: plays from the account`, play.rs >= 2 && play.t > 0.5 && !play.err, JSON.stringify(play));
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(`${tag}: no horizontal overflow`, ov <= 1, `${ov}px`);
  return page;
}
const pd = await result(p, "escritorio");
const dl = await Promise.all([pd.waitForEvent("download", { timeout: 300000 }), pd.getByText("Descargar video").first().click()]).then(([d]) => d).catch(() => null);
if (ok("download offered from the account", !!dl)) {
  const file = path.join(EVID, "..", "descarga-lf.mp4"); await dl.saveAs(file);
  const buf = fs.readFileSync(file), sha = crypto.createHash("sha256").update(buf).digest("hex");
  const { data: blob } = await db.storage.from("videos").download(r.video_path);
  const sha2 = blob ? crypto.createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex") : null;
  facts.download = { bytes: buf.length, sha256: sha };
  ok("download == stored file (sha256)", sha === sha2, `${buf.length} bytes`);
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", file]).toString());
  const vs = pr.streams.find((s) => s.codec_type === "video"), as = pr.streams.find((s) => s.codec_type === "audio"); facts.media = pr;
  ok("media: 1920x1080 H.264 + AAC", vs?.width === 1920 && vs?.height === 1080 && vs?.codec_name === "h264" && as?.codec_name === "aac", `${vs?.codec_name} ${vs?.width}x${vs?.height} / ${as?.codec_name}`);
  ok(`media: full length (≥ ${Math.round(MIN * 0.8)} min)`, Number(pr.format.duration) >= MIN * 60 * 0.8, `${Math.round(Number(pr.format.duration))} s`);
  const loud = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const I = Number(((loud.match(/I:\s*(-?[\d.]+) LUFS/g) || []).slice(-1)[0] || "").replace(/[^\d.-]/g, "")); facts.lufs = I;
  ok("audio loudness near −16 LUFS (±2)", Number.isFinite(I) && Math.abs(I + 16) <= 2, `${I} LUFS`);
  fs.mkdirSync(path.join(EVID, "frames"), { recursive: true });
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "fps=1/20,scale=640:-2", path.join(EVID, "frames", "f%03d.jpg")]);
  const black = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vf", "blackdetect=d=2:pix_th=0.10", "-an", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
  const gaps = (black.match(/black_start/g) || []).length; facts.blackGaps = gaps;
  ok("no black gaps ≥ 2 s (every block has images)", gaps === 0, `${gaps}`);
}
const { data: subs } = await db.from("video_requests").select("*").eq("id", R).single();
const subKey = Object.keys(subs || {}).find((k) => /caption|subtit|srt|vtt/i.test(k) && subs[k]);
facts.subtitlesField = subKey ?? null;
ok("subtitles produced for the video", !!subKey, subKey || "none");
const mob = await browser.newContext({ ...devices["Pixel 7"], storageState: STATE }); await result(await mob.newPage(), "movil-emulado");
const fresh = await browser.newContext({ storageState: STATE2, viewport: { width: 1280, height: 800 } }); await result(await fresh.newPage(), "nueva-sesion");
await browser.close(); finish();

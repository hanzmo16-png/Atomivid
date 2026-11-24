// Generación de pago del fondo cinematográfico (autorizada por Hans el 2026-11-24). Se ejecuta en GitHub Actions con los
// secretos FAL_KEY / VEO_API_KEY (nunca se imprimen). Lee ops/cinematic-bg/job.json:
//   { "stage": "keyframes" | "video", "capUsd": n, "keyframes": [...], "videos": [...] }
// - keyframes: FLUX 1.1 Pro Ultra (fal) → ops/cinematic-bg/out/<id>.jpg
// - video: Veo 3.1 Fast 1080p 8 s, imagen inicial (y final, para bucle) → ops/cinematic-bg/out/<id>.mp4
// Sin reintentos. Antes de llamar a nada calcula el coste máximo y se niega si supera capUsd. Escribe report-<stage>.json.
import fs from "node:fs"; import path from "node:path";
const OUT = "ops/cinematic-bg/out"; fs.mkdirSync(OUT, { recursive: true });
const job = JSON.parse(fs.readFileSync("ops/cinematic-bg/job.json", "utf8"));
const FLUX_MODEL = "fal-ai/flux-pro/v1.1-ultra", FLUX_USD = 0.06;
// Veo: el nombre exacto del modelo cambia (el «-preview» se retiró); se elige de ListModels. Precio prudente por segundo:
// variantes «fast» USD 0,15/s; las completas USD 0,40/s (tarifas públicas de Veo 3.x, se toma la más alta conocida).
const veoUsdPerSecond = (m) => (/fast/.test(m) ? 0.15 : 0.4);
let VEO_MODEL = null;
const report = { stage: job.stage, startedAt: new Date().toISOString(), items: [], estimatedMaxUsd: 0 };
const save = () => fs.writeFileSync(path.join(OUT, `report-${job.stage}.json`), JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(url, init = {}) { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }); const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 600); } return { ok: r.ok, status: r.status, body: b }; }

async function keyframes() {
  const key = process.env.FAL_KEY; if (!key) throw new Error("FAL_KEY ausente");
  const H = { Authorization: `Key ${key}`, "content-type": "application/json", "X-Fal-No-Retry": "1" };
  for (const k of job.keyframes) {
    const item = { id: k.id, model: FLUX_MODEL, aspect: k.aspect, seed: k.seed };
    report.items.push(item);
    const sub = await j(`https://queue.fal.run/${FLUX_MODEL}`, { method: "POST", headers: H, body: JSON.stringify({ prompt: k.prompt, aspect_ratio: k.aspect, num_images: 1, output_format: "jpeg", raw: !!k.raw, seed: k.seed, enable_safety_checker: true, safety_tolerance: "2" }) });
    if (!sub.ok) { item.error = { status: sub.status, body: sub.body }; save(); continue; }
    const { status_url, response_url, request_id } = sub.body; item.requestId = request_id;
    let st; for (let i = 0; i < 90; i++) { await sleep(3000); st = await j(status_url, { headers: H }); if (st.body?.status === "COMPLETED") break; }
    if (st?.body?.status !== "COMPLETED") { item.error = { status: "timeout", last: st?.body }; save(); continue; }
    const res = await j(response_url, { headers: H }); const img = res.body?.images?.[0];
    if (!img?.url) { item.error = { status: res.status, body: res.body }; save(); continue; }
    const bin = Buffer.from(await (await fetch(img.url)).arrayBuffer());
    fs.writeFileSync(path.join(OUT, `${k.id}.jpg`), bin);
    Object.assign(item, { ok: true, width: img.width, height: img.height, bytes: bin.length, usd: FLUX_USD }); save();
  }
}

async function video() {
  const key = process.env.VEO_API_KEY; if (!key) throw new Error("VEO_API_KEY ausente");
  const base = "https://generativelanguage.googleapis.com/v1beta"; const H = { "x-goog-api-key": key, "content-type": "application/json" };
  const models = [];
  for (let page = "", i = 0; i < 10; i++) {
    const r = await j(`${base}/models?pageSize=200${page ? `&pageToken=${page}` : ""}`, { headers: { "x-goog-api-key": key } });
    if (!r.ok) { report.listModelsError = { status: r.status, body: r.body }; break; }
    for (const m of r.body.models ?? []) if (/veo/i.test(m.name)) models.push({ name: m.name.replace(/^models\//, ""), methods: m.supportedGenerationMethods });
    page = r.body.nextPageToken; if (!page) break;
  }
  report.veoModels = models;
  const usable = models.filter((m) => (m.methods ?? []).includes("predictLongRunning")).map((m) => m.name);
  const prefs = job.veoModelPrefs ?? [/^veo-3\.1-fast/, /^veo-3\.\d-fast/, /^veo-3\.1/, /^veo-3/];
  for (const re of prefs.map((x) => (typeof x === "string" ? new RegExp(x) : x))) { const hit = usable.find((n) => re.test(n)); if (hit) { VEO_MODEL = hit; break; } }
  report.veoModel = VEO_MODEL; save();
  if (!VEO_MODEL) throw new Error("ningún modelo Veo con predictLongRunning disponible");
  const worst = job.videos.length * 8 * veoUsdPerSecond(VEO_MODEL);
  if (worst > job.capUsd) { report.refused = `coste máximo con ${VEO_MODEL}: ${worst} > tope ${job.capUsd}`; save(); throw new Error(report.refused); }
  const imgObj = (f) => ({ bytesBase64Encoded: fs.readFileSync(f).toString("base64"), mimeType: "image/jpeg" });
  for (const v of job.videos) {
    const item = { id: v.id, model: VEO_MODEL, aspect: v.aspect, image: v.image, loop: !!v.loop };
    report.items.push(item);
    const instance = { prompt: v.prompt, image: imgObj(v.image) };
    if (v.loop) instance.lastFrame = imgObj(v.lastImage ?? v.image);
    const body = { instances: [instance], parameters: { aspectRatio: v.aspect, resolution: "1080p", durationSeconds: 8, ...(v.negative ? { negativePrompt: v.negative } : {}) } };
    const sub = await j(`${base}/models/${VEO_MODEL}:predictLongRunning`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!sub.ok) { item.error = { status: sub.status, body: sub.body }; save(); continue; }
    const op = sub.body.name; item.operation = op;
    let st; for (let i = 0; i < 120; i++) { await sleep(10_000); st = await j(`${base}/${op}`, { headers: { "x-goog-api-key": key } }); if (st.body?.done) break; }
    if (!st?.body?.done) { item.error = { status: "timeout" }; save(); continue; }
    if (st.body.error) { item.error = st.body.error; save(); continue; }
    const r = st.body.response?.generateVideoResponse; const uri = r?.generatedSamples?.[0]?.video?.uri;
    if (!uri) { item.error = { status: "sin video", filtered: r?.raiMediaFilteredReasons ?? r }; save(); continue; }
    const dl = await fetch(uri, { headers: { "x-goog-api-key": key }, redirect: "follow" });
    const bin = Buffer.from(await dl.arrayBuffer()); fs.writeFileSync(path.join(OUT, `${v.id}.mp4`), bin);
    Object.assign(item, { ok: dl.ok, bytes: bin.length, usd: 8 * veoUsdPerSecond(VEO_MODEL) }); save();
  }
}

const est = job.stage === "keyframes" ? job.keyframes.length * FLUX_USD : job.videos.length * 8 * 0.15;
report.estimatedMaxUsd = +est.toFixed(2); report.capUsd = job.capUsd;
if (!(est <= job.capUsd)) { report.refused = `coste máximo ${est} > tope ${job.capUsd}`; save(); console.log(report.refused); process.exit(1); }
try { await (job.stage === "keyframes" ? keyframes() : video()); } catch (e) { report.fatal = String(e?.message ?? e); }
report.finishedAt = new Date().toISOString(); report.spentUsd = +report.items.filter((i) => i.ok).reduce((s, i) => s + (i.usd ?? 0), 0).toFixed(2); save();
console.log(JSON.stringify(report.items.map(({ id, ok, error, bytes }) => ({ id, ok, bytes, error: error ? JSON.stringify(error).slice(0, 300) : undefined })), null, 1), "spent", report.spentUsd);

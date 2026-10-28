// One-off generation (Recraft via fal.ai queue) of the Podcast studio assets: empty studio plates (Moderno, Cálido,
// Minimalista), candidate portraits for the two new catalog hosts and documentary style references. Hard cap: the
// number of images × USD 0.04 must fit POD_ASSETS_MAX_USD before anything is submitted. Each request is submitted
// ONCE (no retries); a failure is reported, never resent. Images go to $EVID (encrypted by the workflow) and to the
// private «videos» bucket under podcast-catalog/candidates/ (service role). Prints only ids, sizes and status.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID, KEY = process.env.FAL_KEY?.trim(), MAX = Number(process.env.POD_ASSETS_MAX_USD || 0);
const USD_PER_IMAGE = 0.04, MODEL = "fal-ai/recraft/v3/text-to-image";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (t, v) => console.log(t, JSON.stringify(v));
fs.mkdirSync(EVID, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NO = "no people, no person, no text, no letters, no logos, no signs with writing";
const STUDIO = (desc) => `Wide interior photograph of an empty professional video podcast studio, camera at seated eye level facing the rear wall. ${desc} A long podcast table runs horizontally across the lower foreground of the frame, its front edge near the bottom third, with two broadcast microphones on short stands on the table, one at the left third and one at the right third. Behind the table, the space where two hosts would sit on the left and right is empty, chairs hidden behind the table. The rear wall has a large plain empty area in the upper center, above the table, where a sign will be mounted later. Symmetric composition, realistic depth and perspective, ${NO}.`;
const PORTRAIT = (desc) => `Photorealistic professional portrait photograph, head and upper torso, ${desc}, looking directly at the camera, natural relaxed expression, soft even studio key light, plain uniform light gray seamless background, sharp focus on the eyes, centered composition with space above the head, high detail skin texture, natural look.`;
const jobs = [
  ...[1, 2].map((n) => ({ name: `estudio-moderno-${n}`, kind: "plate", size: "landscape_16_9", style: "realistic_image", prompt: STUDIO("Contemporary design: dark charcoal acoustic panels, slim vertical LED light strips, a few elegant spot lights, polished dark walnut table, subtle blue and warm amber accent lighting, elegant and premium.") })),
  ...[1, 2].map((n) => ({ name: `estudio-calido-${n}`, kind: "plate", size: "landscape_16_9", style: "realistic_image", prompt: STUDIO("Warm wood interior: walnut wood paneling, tall wooden bookshelves full of books on both sides, warm soft lamps, several lit decorative candles on the shelves and a pair of candles on the table, cozy library atmosphere, warm golden light.") })),
  ...[1, 2].map((n) => ({ name: `estudio-minimalista-${n}`, kind: "plate", size: "landscape_16_9", style: "realistic_image", prompt: STUDIO("Minimalist design: neutral warm white and light beige tones, very few elements, one small plant at the far side, light oak table, soft diffuse daylight, clean uncluttered composition.") })),
  ...[1, 2, 3].map((n) => ({ name: `anfitriona-${n}`, kind: "portrait", size: "portrait_4_3", style: "realistic_image", prompt: PORTRAIT("a very attractive, elegant and natural Latina woman around 32 years old, shoulder-length softly layered honey-blonde hair, light warm makeup, small pearl earrings, ivory silk blouse under a tailored light camel blazer, warm confident smile") })),
  ...[1, 2, 3].map((n) => ({ name: `anfitrion-${n}`, kind: "portrait", size: "portrait_4_3", style: "realistic_image", prompt: PORTRAIT("a Hispanic man around 40 years old with the look of a friendly science communicator, short salt-and-pepper hair, neatly trimmed short beard, thin dark rectangular glasses, navy crewneck sweater over a light blue collared shirt, curious intelligent expression") })),
  { name: "estilo-1", kind: "style", size: "landscape_16_9", style: "digital_illustration", prompt: `Cinematic documentary digital painting of an ancient Mesopotamian ziggurat at golden hour seen from a distance, painterly yet realistic, muted earthy palette with warm highlights, atmospheric haze, ${NO}.` },
  { name: "estilo-2", kind: "style", size: "landscape_16_9", style: "digital_illustration", prompt: `Cinematic documentary digital painting of a museum display of an ancient clay artifact lit by a single warm spotlight, painterly yet realistic, muted earthy palette with warm highlights, ${NO}.` },
];
// Segunda tanda (POD_ASSETS_ROUND=2): los retratos de la primera miraban de lado (HeyGen anima mejor una cara de frente) y
// los estudios Moderno/Minimalista salieron en ángulo; una imagen por elemento con encuadre frontal estricto.
const FRONT = (desc) => STUDIO(desc).replace("Wide interior photograph", "Straight-on frontal wide interior photograph with perfectly symmetric one-point perspective") .replace("A long podcast table runs horizontally across the lower foreground of the frame, its front edge near the bottom third,", "A wide rectangular podcast table parallel to the camera spans most of the frame width in the foreground, its front edge in the lower third,");
const HEADSHOT = (desc) => `Photorealistic front-facing studio headshot of ${desc}, head straight and facing the camera directly, eyes looking straight into the camera lens like a television presenter, symmetrical shoulders, gentle closed-mouth smile, head and upper torso, soft even studio key light, plain uniform light gray seamless background, sharp focus, centered with space above the head, natural skin texture.`;
const round2 = [
  { name: "estudio-moderno-3", kind: "plate", size: "landscape_16_9", style: "realistic_image", prompt: FRONT("Contemporary design: dark charcoal acoustic wall panels, slim vertical warm LED light strips on both sides, a few elegant spot lights, polished dark walnut table, subtle cool blue and warm amber accent lighting, elegant and premium.") },
  { name: "estudio-minimalista-3", kind: "plate", size: "landscape_16_9", style: "realistic_image", prompt: FRONT("Minimalist design: neutral warm white walls and light beige tones, very few elements, one small plant on each far side, light oak table, soft diffuse daylight, clean uncluttered composition.") },
  { name: "anfitriona-4", kind: "portrait", size: "portrait_4_3", style: "realistic_image", prompt: HEADSHOT("a very attractive, elegant and natural Latina woman around 30 years old, shoulder-length softly layered honey-blonde hair, light warm makeup, small pearl earrings, ivory silk blouse under a tailored light camel blazer") },
  { name: "anfitrion-4", kind: "portrait", size: "portrait_4_3", style: "realistic_image", prompt: HEADSHOT("a Hispanic man around 38 years old with the look of a friendly science communicator, short dark hair with a few gray strands, neatly trimmed short beard, thin dark rectangular glasses, navy crewneck sweater over a light blue collared shirt") },
];
if (process.env.POD_ASSETS_ROUND === "2") jobs.splice(0, jobs.length, ...round2);
const est = Math.round(jobs.length * USD_PER_IMAGE * 100) / 100;
out("PLAN", { images: jobs.length, estimatedUsd: est, capUsd: MAX });
if (!KEY) { out("STOP", "FAL_KEY missing"); process.exit(1); }
if (!(est <= MAX + 1e-9)) { out("STOP", "estimate exceeds cap"); process.exit(1); }

const headers = { Authorization: `Key ${KEY}`, "Content-Type": "application/json", "X-Fal-No-Retry": "1" };
const results = [];
for (const j of jobs) {
  const r = { name: j.name, ok: false };
  try {
    const sub = await fetch(`https://queue.fal.run/${MODEL}`, { method: "POST", headers, body: JSON.stringify({ prompt: j.prompt, image_size: j.size, style: j.style }) });
    const sj = await sub.json().catch(() => ({}));
    r.submitHttp = sub.status; r.requestId = sj.request_id ?? null;
    if (!sub.ok || !sj.status_url || !sj.response_url) { r.error = `submit ${sub.status}`; results.push(r); out("IMG", r); continue; }
    let done = false;
    for (let i = 0; i < 90 && !done; i++) {
      await sleep(2000);
      const st = await fetch(sj.status_url, { headers }).then((x) => x.json()).catch(() => ({}));
      if (st.status === "COMPLETED") done = true;
      else if (st.status && !["IN_QUEUE", "IN_PROGRESS"].includes(st.status)) { r.error = `status ${st.status}`; break; }
    }
    if (!done) { r.error = r.error ?? "timeout"; results.push(r); out("IMG", r); continue; }
    const res = await fetch(sj.response_url, { headers }).then((x) => x.json()).catch(() => ({}));
    const url = res.images?.[0]?.url;
    if (!url) { r.error = "no image"; results.push(r); out("IMG", r); continue; }
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const ext = (res.images[0].content_type ?? "").includes("png") ? "png" : res.images[0].content_type?.includes("webp") ? "webp" : "jpg";
    const file = `${j.name}.${ext}`;
    fs.writeFileSync(path.join(EVID, file), buf);
    const up = await db.storage.from("videos").upload(`podcast-catalog/candidates/${file}`, buf, { contentType: res.images[0].content_type ?? "image/png", upsert: true });
    Object.assign(r, { ok: true, bytes: buf.length, stored: !up.error });
  } catch (e) { r.error = e instanceof Error ? e.name : "error"; }
  results.push(r); out("IMG", r);
}
fs.writeFileSync(path.join(EVID, "assets.json"), JSON.stringify({ model: MODEL, jobs: jobs.map(({ name, kind, size, style, prompt }) => ({ name, kind, size, style, prompt })), results }, null, 1));
const okN = results.filter((r) => r.ok).length;
out("SUMMARY", { generated: okN, submitted: results.filter((r) => r.requestId).length, usdApprox: Math.round(results.filter((r) => r.requestId).length * USD_PER_IMAGE * 100) / 100 });

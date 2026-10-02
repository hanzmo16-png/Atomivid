/**
 * ATOMIVID_PRECAMPAIGN_TEASER_V1 — producción controlada del teaser vertical (1080x1920, 30 fps).
 *
 * Reutiliza infraestructura existente, sin tocar el producto:
 * - voz clonada existente (user_voices) vía gatedVoiceSynthesize: gate de pago + ledger + result store;
 * - avatar HeyGen existente vía heygenAvatarProvider envuelto en guardPaidCall (mismo ledger);
 * - DULCE y Océano ya entregados en Storage, música curada del bucket music-library;
 * - retoque y montaje 100 % locales con ffmpeg (sin proveedor externo, USD 0.00).
 *
 * Tope absoluto de gasto nuevo: TEASER_HARD_CAP_USD (1.03). Se comprueba ANTES de cada llamada pagada.
 * Los clips originales de Hans nunca se modifican: solo se leen.
 *
 * TEASER_LOCAL_DIR: modo de ensayo local (sin Supabase, sin proveedores, sin red): lee los insumos
 * de ese directorio y sustituye la voz/avatar por marcadores, para validar el montaje con USD 0.00.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export {};

const sh = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";
const W = 1080, H = 1920, FPS = 30;
const PROJECT = "precampaign-teaser-v1";
const CAP = Number(process.env.TEASER_HARD_CAP_USD ?? "1.03");
const OUT = resolve(process.env.TEASER_OUT_DIR ?? "teaser-output");
const WORK = join(OUT, "work");
const FONT = resolve("public/fonts/Anton-Regular.ttf");
const LOCAL = process.env.TEASER_LOCAL_DIR ? resolve(process.env.TEASER_LOCAL_DIR) : null;
/** "heygen" (master) | "review-placeholder": sin llamada a HeyGen; corte SOLO de revisión, nunca el master. */
const AVATAR_MODE = process.env.TEASER_AVATAR_MODE === "review-placeholder" ? "review-placeholder" : "heygen";
/** Intento explícito del avatar: el intento 1 (run 37029447621) fue rechazado con HTTP 401 antes de crear trabajo (sin cobro). */
const AVATAR_ATTEMPT = process.env.TEASER_AVATAR_ATTEMPT ?? "2";

/** Retoque local v2 (look cálido/bronceado aprobado por Hans), USD 0.00, sin geometría:
 * - base: denoise leve, altas luces contenidas (contraluz de la ventana), contraste y calidez globales MUY leves;
 * - piel: máscara local por crominancia (Cb/Cr de piel; excluye camisa blanca, pared y ventana), cerrada y
 *   difuminada para incluir cara, cuello y manos por igual; sobre ella: suavizado que respeta bordes,
 *   medios tonos algo más profundos (bronceado), calidez dorada y saturación selectiva;
 * - mezcla con maskedmerge (la máscara se arma desde un único plano gris en los tres planos) + nitidez discreta. */
const SKIN_MASK = "clip((cr(X,Y)-131)/9,0,1)*clip((180-cr(X,Y))/10,0,1)*clip((cb(X,Y)-78)/8,0,1)*clip((130-cb(X,Y))/6,0,1)*clip((lum(X,Y)-35)/25,0,1)*255";
const RETOUCH_GRAPH = (input: string, output: string) =>
  `[${input}]format=yuv444p,hqdn3d=1.5:1.5:3:3,split=3[ra][rb][rc];` +
  `[ra]curves=all='0/0 0.25/0.235 0.6/0.61 0.85/0.82 1/0.93',eq=contrast=1.06:saturation=1.04,colorbalance=rm=0.01:bm=-0.012,format=yuv444p[rbase];` +
  `[rb]smartblur=lr=2.5:ls=0.6:lt=6,curves=all='0/0 0.25/0.235 0.6/0.61 0.85/0.82 1/0.93',curves=all='0/0 0.35/0.33 0.65/0.59 0.9/0.83 1/0.95',` +
  `colorbalance=rs=0.03:bs=-0.04:rm=0.08:gm=0.015:bm=-0.08:rh=0.03:bh=-0.04,eq=contrast=1.08:saturation=1.2,format=yuv444p[rskin];` +
  `[rc]scale=iw/4:ih/4,geq=lum='${SKIN_MASK}':cb=128:cr=128,format=gray,dilation,dilation,erosion,gblur=sigma=3,scale=iw*4:ih*4:flags=bicubic,split=3[rm1][rm2][rm3];` +
  `[rm1][rm2][rm3]mergeplanes=0x001020:yuv444p[rmask];[rbase][rskin][rmask]maskedmerge,unsharp=5:5:0.45:5:5:0,format=yuv420p[${output}]`;

const OPENING_TEXT = "Llevo meses trabajando en algo que por fin hoy te puedo empezar a enseñar.";
const CLOSING_TEXT = "Estamos terminando las últimas pruebas. Si quieres ser de los primeros en probarlo, escribe ATOMIVID en los comentarios.";
const LINES = {
  avatar: "Se llama ATOMIVID. Tú le das una idea… y empieza la producción.",
  demo: "Guion. Voz. Imágenes. Movimiento. Música. Subtítulos. Todo dentro del mismo proceso.",
  results: "Y esto no es una presentación. Son videos que ya estamos produciendo.",
  reveal: "De hecho… el video que estás viendo también fue creado con ATOMIVID.",
} as const;
const ALIASES = [{ word: "ATOMIVID", spoken: "atomivid" }];

type Word = { text: string; start: number; end: number; limit?: number };
type Cost = { provider: string; operation: string; estimatedUsd: number; actualUsd: number; reused: boolean; ledgerKey?: string };

const ff = (args: string[]) => sh(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
async function probe(file: string) {
  const { stdout } = await sh(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    width: swap ? v?.height ?? 0 : v?.width ?? 0,
    height: swap ? v?.width ?? 0 : v?.height ?? 0,
    fps: d ? n / d : 0,
    duration: Number(j.format?.duration ?? 0),
    hasAudio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
    rotation: rot,
  };
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Speech region of a real take (local silencedetect), to trim dead air without rushing the line. */
async function speechWindow(file: string, duration: number) {
  const { stderr } = await sh(FFMPEG, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.3", "-f", "null", "-"], { maxBuffer: 16 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  let a = 0, b = duration;
  if (starts.length && starts[0] < 0.05 && ends.length) a = ends[0];
  const lastStart = starts.at(-1);
  if (lastStart !== undefined && (ends.length < starts.length || (ends.at(-1) ?? 0) >= duration - 0.05)) b = lastStart;
  return { start: Math.max(0, a - 0.12), end: Math.min(duration, b + 0.3) };
}

/** Known line spread over the measured speech window (no transcription provider). */
function spreadWords(text: string, start: number, end: number): Word[] {
  const words = text.split(/\s+/);
  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return words.map((w, i) => {
    const d = ((end - start) * weights[i]) / total;
    const word = { text: w, start: t, end: t + d };
    t += d;
    return word;
  });
}

const costs: Cost[] = [];
const spent = () => costs.reduce((s, c) => s + c.actualUsd, 0);
const notes: string[] = [];
let ledgerRows: unknown[] = [];

type SvcLike = { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => PromiseLike<{ data: unknown[] | null }> } } };
/** Gasto real: operaciones de esta ejecución + filas del ledger del proyecto (incluye llamadas de ejecuciones previas). */
async function buildCostReport(service: unknown) {
  if (service) {
    const { data } = await (service as SvcLike).from("pi_paid_operations").select("provider,shot_id,status,reserved_usd,committed_usd,updated_at").eq("project_id", PROJECT);
    ledgerRows = data ?? [];
  }
  const committed = (ledgerRows as { committed_usd: number | string | null }[]).reduce((a, r) => a + Number(r.committed_usd ?? 0), 0);
  return { capUsd: CAP, spentThisRunUsd: Math.round(spent() * 10000) / 10000, ledgerCommittedTotalUsd: Math.round(committed * 10000) / 10000, operations: costs, ledger: ledgerRows, avatarMode: AVATAR_MODE, avatarAttempt: AVATAR_ATTEMPT };
}

async function main() {
  await mkdir(WORK, { recursive: true });
  if (process.env.TEASER_PREFLIGHT_ONLY === "1") {
    // Solo verificación gratuita (GET) de la clave HeyGen: ninguna llamada pagada.
    const { getHeygenWallet } = await import("../../src/lib/providers/avatar/heygen");
    const wallet = await getHeygenWallet().catch((e: unknown) => { throw new Error(`HEYGEN_PREFLIGHT_FAILED (sin gasto): ${e instanceof Error ? e.message : e}`); });
    const ok = wallet >= 0.3;
    await writeFile(join(OUT, "heygen-preflight.json"), JSON.stringify({ authenticated: true, balanceSufficient: ok, paidCalls: 0 }, null, 2) + "\n");
    console.log(ok ? "HEYGEN_PREFLIGHT_OK" : "HEYGEN_PREFLIGHT_LOW_BALANCE");
    if (!ok) process.exit(1);
    return;
  }

  // ---------- Insumos ----------
  const inputs = { opening: join(WORK, "src-opening.mp4"), closing: join(WORK, "src-closing.mp4"), dulce: join(WORK, "dulce.mp4"), ocean: join(WORK, "ocean.mp4"), music: join(WORK, "music.mp3") };
  type Svc = Awaited<ReturnType<typeof import("../../src/lib/supabase/service")["createServiceClient"]>>;
  let service: Svc | null = null;
  if (LOCAL) {
    for (const [k, p] of Object.entries(inputs)) await copyFile(join(LOCAL, `${k}${p.slice(p.lastIndexOf("."))}`), p);
  } else {
    const { createServiceClient } = await import("../../src/lib/supabase/service");
    service = createServiceClient();
    const videos = service.storage.from("videos");
    const get = async (bucket: string, path: string, to: string) => {
      const { data, error } = await service!.storage.from(bucket).download(path);
      if (error || !data) throw new Error(`No se pudo leer ${bucket}/${path}`);
      await writeFile(to, Buffer.from(await data.arrayBuffer()));
    };
    await get("videos", process.env.TEASER_OPENING_PATH!, inputs.opening);
    await get("videos", process.env.TEASER_CLOSING_PATH!, inputs.closing);
    const manifest = JSON.parse(Buffer.from(await (await videos.download("dulce-001/full-v1/final/manifest.json")).data!.arrayBuffer()).toString()) as { parts: string[] };
    const parts: Buffer[] = [];
    for (const p of manifest.parts) parts.push(Buffer.from(await (await videos.download(p)).data!.arrayBuffer()));
    await writeFile(inputs.dulce, Buffer.concat(parts));
    await get("videos", "ocean-deep-001/samples/episode/sample-approval-motion-production-check.mp4", inputs.ocean);
    await get("music-library", process.env.TEASER_MUSIC_PATH ?? "elevenlabs-corporate-2.mp3", inputs.music);
  }
  for (const k of ["opening", "closing"] as const) {
    const m = await probe(inputs[k]);
    if (m.width !== W || m.height !== H || Math.abs(m.fps - FPS) > 0.5 || !m.hasAudio) throw new Error(`${k}: formato mostrado ${m.width}x${m.height} ${m.fps} fps audio=${m.hasAudio}`);
  }

  // ---------- Tomas reales: retoque local + recorte de silencios (los originales no se tocan) ----------
  const real: Record<"opening" | "closing", { file: string; duration: number; words: Word[] }> = {} as never;
  for (const [k, text] of [["opening", OPENING_TEXT], ["closing", CLOSING_TEXT]] as const) {
    const src = inputs[k];
    const m = await probe(src);
    const win = await speechWindow(src, m.duration);
    const file = join(WORK, `${k}-retouched.mp4`);
    await ff(["-ss", win.start.toFixed(3), "-to", win.end.toFixed(3), "-i", src, "-filter_complex", `[0:v]scale=${W}:${H}:flags=lanczos,fps=${FPS}[src];${RETOUCH_GRAPH("src", "v")}`,
      "-map", "[v]", "-map", "0:a", "-af", "aresample=48000,highpass=f=70,afftdn=nf=-25", "-ac", "2", "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", file]);
    // Comparación ORIGINAL → POLISHED (mismo instante, resolución completa) para la QA de Hans.
    for (const f of [0.25, 0.6]) {
      const tt = (win.end - win.start) * f;
      await ff(["-ss", (win.start + tt).toFixed(3), "-i", src, "-ss", tt.toFixed(3), "-i", file, "-frames:v", "1", "-filter_complex",
        `[0:v]scale=${W}:${H},format=rgb24[o];[1:v]format=rgb24[p];[o][p]hstack=2,scale=1080:-2`, join(OUT, `hans-${k}-original-vs-polished-${Math.round(f * 100)}.jpg`)]);
    }
    const d = (await probe(file)).duration;
    const lead = 0.12;
    real[k] = { file, duration: d, words: spreadWords(text, Math.min(lead, d / 4), Math.max(d - 0.3, d * 0.8)) };
  }

  // ---------- Voz clonada existente (gate + ledger + result store) ----------
  const tts: Record<keyof typeof LINES, { file: string; duration: number; words: Word[] }> = {} as never;
  if (LOCAL) {
    for (const [k, text] of Object.entries(LINES) as [keyof typeof LINES, string][]) {
      const dur = Math.max(2.5, text.split(/\s+/).length * 0.36);
      const file = join(WORK, `tts-${k}.wav`);
      await ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${dur}`, "-af", "volume=0.2", "-ar", "48000", "-ac", "2", file]);
      tts[k] = { file, duration: dur, words: spreadWords(text, 0.05, dur - 0.1) };
    }
    notes.push("ENSAYO LOCAL: voz y avatar sustituidos por marcadores; sin proveedores.");
  } else {
    const { data: voice } = await service!.from("user_voices").select("provider,status,provider_voice_id").eq("id", process.env.TEASER_VOICE_ID!).maybeSingle();
    if (!voice || voice.status !== "ready" || voice.provider !== "elevenlabs" || !voice.provider_voice_id) throw new Error("La voz clonada autorizada no está lista: no se crea ninguna.");
    if (AVATAR_MODE === "heygen") {
      // Comprobación gratuita (GET) de la clave de HeyGen ANTES de cualquier gasto: una clave rechazada detiene todo con USD 0.
      const { getHeygenWallet } = await import("../../src/lib/providers/avatar/heygen");
      const wallet = await getHeygenWallet().catch((e: unknown) => { throw new Error(`HEYGEN_PREFLIGHT_FAILED (sin gasto): ${e instanceof Error ? e.message : e}`); });
      if (wallet < 0.3) throw new Error(`HEYGEN_PREFLIGHT_FAILED (sin gasto): saldo insuficiente (${wallet} USD)`);
      notes.push(`HeyGen preflight OK (saldo suficiente).`);
    }
    process.env.ELEVENLABS_VOICE_ID_ES = voice.provider_voice_id;
    const { gatedVoiceSynthesize } = await import("../../src/lib/paid-calls/gated-providers");
    const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
    const { supabaseResultStore } = await import("../../src/lib/paid-calls/result-store");
    const { realVoiceProvider } = await import("../../src/lib/providers/voice/real");
    const { getVoiceIdentity } = await import("../../src/lib/ai/voice");
    const { getPricingConfig } = await import("../../src/lib/billing/pricing");
    const rate = getPricingConfig().elevenLabsUsdPer1kChars;
    const deps = { ledger: supabaseLedgerStore(service!), results: supabaseResultStore(service!, "videos"), requestId: PROJECT, voiceProvider: realVoiceProvider, voiceIdentity: getVoiceIdentity("es") };
    const heygenReserve = Number(process.env.TEASER_HEYGEN_RESERVE_USD ?? "0.30");
    for (const [k, text] of Object.entries(LINES) as [keyof typeof LINES, string][]) {
      const est = Math.round((text.length / 1000) * rate * 10000) / 10000;
      if (spent() + est + heygenReserve > CAP) throw new Error(`Tope: ${spent() + est + heygenReserve} > ${CAP} USD antes de TTS ${k}; no se llama.`);
      const r = await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: est }, text, "es", undefined, { aliases: ALIASES });
      const file = join(WORK, `tts-${k}.${r.extension}`);
      await writeFile(file, r.audioBuffer);
      tts[k] = { file, duration: (await probe(file)).duration, words: r.words.map((w) => ({ text: w.text, start: w.startSeconds, end: w.endSeconds })) };
      costs.push({ provider: "elevenlabs", operation: `tts:${k}`, estimatedUsd: est, actualUsd: r.costUsd, reused: r.reused });
    }
  }

  // ---------- Avatar HeyGen existente: solo la frase del avatar (~4-5 s) ----------
  const avatarFile = join(WORK, "avatar.mp4");
  const avatarWav = join(WORK, "avatar-line.wav");
  await ff(["-i", tts.avatar.file, "-ar", "48000", "-ac", "1", avatarWav]);
  const avatarSeconds = (await probe(avatarWav)).duration;
  if (LOCAL || AVATAR_MODE === "review-placeholder") {
    await ff(["-f", "lavfi", "-i", `color=c=0x1d2433:s=720x1280:d=${avatarSeconds}`, "-vf", `drawtext=fontfile=${FONT}:text='AVATAR HEYGEN':fontcolor=white:fontsize=80:x=(w-tw)/2:y=(h-th)/2,drawtext=fontfile=${FONT}:text='PENDIENTE - SOLO REVISIÓN':fontcolor=0xffd37f:fontsize=40:x=(w-tw)/2:y=(h-th)/2+110`, "-r", "30", avatarFile]);
    notes.push("AVATAR: marcador de revisión (sin llamada a HeyGen). Este corte NO es el master.");
  } else {
    const { heygenAvatarProvider, estimateHeygenCost } = await import("../../src/lib/providers/avatar/heygen");
    const { guardPaidCall, classifyPaidCallError } = await import("../../src/lib/paid-calls/gate");
    const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
    const { supabaseResultStore, paidResultPath } = await import("../../src/lib/paid-calls/result-store");
    const results = supabaseResultStore(service!, "videos");
    const { data: avatar } = await service!.from("avatars").select("provider,status,provider_avatar_id,consent_given").eq("id", process.env.TEASER_AVATAR_ID!).maybeSingle();
    if (!avatar || avatar.provider !== "heygen" || avatar.status !== "ready" || !avatar.provider_avatar_id || !avatar.consent_given) throw new Error("El avatar autorizado no está listo: no se crea ninguno.");
    const est = estimateHeygenCost(avatarSeconds);
    if (spent() + est > CAP) throw new Error(`Tope: ${spent() + est} > ${CAP} USD antes del avatar; no se llama.`);
    const wav = await readFile(avatarWav);
    const audioPath = `${PROJECT}/work/avatar-line-${sha256(wav).slice(0, 12)}.wav`;
    await service!.storage.from("videos").upload(audioPath, wav, { contentType: "audio/wav", upsert: true });
    const { data: signed } = await service!.storage.from("videos").createSignedUrl(audioPath, 3600);
    if (!signed?.signedUrl) throw new Error("No se pudo firmar el audio del avatar.");
    let acceptedJobId: string | undefined;
    const store = async (key: string, buffer: Buffer) => {
      const path = paidResultPath(PROJECT, key, "mp4");
      await results.putBytes(path, buffer, "video/mp4");
      await results.putJson(paidResultPath(PROJECT, key, "json"), { videoPath: path, sha256: sha256(buffer), bytes: buffer.byteLength });
      return paidResultPath(PROJECT, key, "json");
    };
    const guarded = await guardPaidCall<Buffer>(supabaseLedgerStore(service!), {
      projectId: PROJECT, shotId: "avatar:line", provider: "heygen", model: "avatar-iv-photo", method: "generate_video",
      inputFingerprint: { avatarId: process.env.TEASER_AVATAR_ID, audioSha256: sha256(wav), attempt: AVATAR_ATTEMPT }, reservedUsd: est,
    }, {
      call: async ({ key }) => {
        const r = await heygenAvatarProvider.generateVideo({ providerAvatarId: avatar.provider_avatar_id!, script: LINES.avatar, audioUrl: signed.signedUrl, audioDurationSeconds: avatarSeconds, language: "es", maxCostUsd: CAP - spent(), onJobCreated: async (id) => { acceptedJobId = id; } });
        return { result: r.buffer, costUsd: r.costUsd, resultRef: await store(key, r.buffer), providerJobId: r.providerJobId };
      },
      resume: async (jobId, { key }) => {
        const r = await heygenAvatarProvider.recoverVideo!(jobId);
        return { result: r.buffer, costUsd: est, resultRef: await store(key, r.buffer), providerJobId: jobId };
      },
      load: async (ref) => {
        const meta = await results.getJson<{ videoPath: string; sha256: string }>(ref);
        const bytes = meta ? await results.getBytes(meta.videoPath) : null;
        return bytes && sha256(bytes) === meta!.sha256 ? bytes : null;
      },
      // 401/403 sin trabajo creado = autenticación rechazada, no facturable y no reintentable.
      classify: (err) => acceptedJobId ? { kind: "accepted", providerJobId: acceptedJobId }
        : /HeyGen HTTP 40[13];/.test(err instanceof Error ? err.message : "") ? { kind: "rejected_final" } : classifyPaidCallError(err),
      maxRejectedRetries: 0,
    });
    await writeFile(avatarFile, guarded.result);
    costs.push({ provider: "heygen", operation: "avatar:line", estimatedUsd: est, actualUsd: guarded.costUsd, reused: guarded.reused, ledgerKey: guarded.key });
  }
  if (spent() > CAP) throw new Error(`Gasto ${spent()} supera el tope ${CAP}.`);

  // ---------- Segmentos de video (cada uno 1080x1920@30 con su audio) ----------
  const seg = (name: string) => join(WORK, `seg-${name}.mp4`);
  const enc = ["-r", String(FPS), "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
  // Los renders de DULCE/Océano traen subtítulos en inglés y rótulos quemados (abajo y esquina superior izquierda):
  // se recortan arriba 14 %, abajo 22 % y 10 % por lado.
  const SAFE = "crop=iw*0.80:ih*0.64:iw*0.10:ih*0.14";
  const vertical = (input: string) => `[${input}]${SAFE},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.12:saturation=0.8[bg];[${input}]${SAFE},scale=${W}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2-140`;
  const dulceDur = (await probe(inputs.dulce)).duration, oceanDur = (await probe(inputs.ocean)).duration;
  const montage = async (name: string, audio: string, picks: { file: string; at: number }[], extra = "") => {
    const dur = (await probe(audio)).duration + 0.25;
    const each = dur / picks.length;
    const args: string[] = [];
    for (const p of picks) args.push("-ss", (await cleanStart(p.file, p.at, each)).toFixed(2), "-t", each.toFixed(3), "-i", p.file);
    args.push("-i", audio);
    const chains = picks.map((_, i) => `${vertical(`${i}:v`).replaceAll("[bg]", `[bg${i}]`).replaceAll("[fg]", `[fg${i}]`)},setsar=1,fps=${FPS},trim=duration=${each.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    const concat = `${picks.map((_, i) => `[v${i}]`).join("")}concat=n=${picks.length}:v=1:a=0[mv]`;
    const filter = `${chains.join(";")};${concat};[mv]${extra || "null"}[vout];[${picks.length}:a]apad=whole_dur=${dur.toFixed(3)}[aout]`;
    await ff([...args, "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]", "-t", dur.toFixed(3), ...enc, seg(name)]);
    return dur;
  };
  /** Desplaza la ventana hasta que no tenga negros ni fundidos (blackdetect local), para evitar cortes a negro. */
  const cleanStart = async (file: string, at: number, len: number) => {
    const total = file === inputs.dulce ? dulceDur : oceanDur;
    for (let i = 0, t = at; i < 12; i++, t += len * 0.75) {
      const start = t % Math.max(1, total - len - 0.5);
      const { stderr } = await sh(FFMPEG, ["-hide_banner", "-ss", start.toFixed(2), "-t", (len + 0.1).toFixed(2), "-i", file, "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"], { maxBuffer: 16 << 20 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
      if (!/black_start/.test(stderr)) return start;
    }
    notes.push(`b-roll sin ventana limpia cerca de ${at.toFixed(1)} s; se usa la original.`);
    return at;
  };
  // Hojas de fuentes (1 cuadro cada ~2.5 % de duración) para elegir planos con criterio en la revisión.
  for (const [n, f, d] of [["dulce", inputs.dulce, dulceDur], ["ocean", inputs.ocean, oceanDur]] as const)
    await ff(["-i", f, "-vf", `fps=${(40 / d).toFixed(4)},scale=240:-2,drawtext=fontfile=${FONT}:text='%{pts\\:hms}':fontcolor=white:fontsize=18:x=4:y=4:box=1:boxcolor=black@0.6,tile=8x5`, "-frames:v", "1", join(OUT, `source-sheet-${n}.jpg`)]);
  // Planos elegidos sobre las hojas de fuentes (segundos absolutos; sin rótulos ni negros).
  const D = (sec: number) => ({ file: inputs.dulce, at: Math.min(sec, Math.max(0, dulceDur - 3)) });
  const O = (sec: number) => ({ file: inputs.ocean, at: Math.min(sec, Math.max(0, oceanDur - 3)) });
  const esc = (t: string) => t.replace(/:/g, "\\:").replace(/'/g, "\u2019");
  const label = (text: string, from: number, to: number, y = 330, size = 104) => `drawtext=fontfile=${FONT}:text='${esc(text)}':fontcolor=white:fontsize=${size}:x=(w-tw)/2:y=${y}:borderw=6:bordercolor=black@0.85:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'`;

  // Apertura y cierre reales retocados.
  await ff(["-i", real.opening.file, ...enc, seg("opening")]);
  await ff(["-i", real.closing.file, ...enc, seg("closing")]);
  // Avatar: retrato vertical a pantalla completa con su propia voz.
  await ff(["-i", avatarFile, "-i", tts.avatar.file, "-filter_complex", `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1[v]`, "-map", "[v]", "-map", "1:a", "-shortest", ...enc, seg("avatar")]);
  // Demo: IDEA → GUION → VOZ → VISUALES → MOVIMIENTO → MÚSICA → VIDEO sincronizado con la voz.
  const dw = tts.demo.words;
  const at = (i: number) => dw[Math.min(i, dw.length - 1)]?.start ?? 0;
  const steps: [string, number, number][] = [["IDEA", 0, at(0)], ["GUION", at(0), at(1)], ["VOZ", at(1), at(2)], ["VISUALES", at(2), at(3)], ["MOVIMIENTO", at(3), at(4)], ["MÚSICA", at(4), at(5)], ["SUBTÍTULOS", at(5), at(6)], ["VIDEO", at(6), 99]];
  const demoDur = await montage("demo", tts.demo.file, [O(2.2), D(14.5), O(6.0), D(185), O(22.3), D(199)], [
    ...steps.map(([t, a, b]) => label(t, a, b)),
    `drawtext=fontfile=${FONT}:text='IDEA → GUION → VOZ → VISUALES → MOVIMIENTO → MÚSICA → VIDEO':fontcolor=white@0.8:fontsize=30:x=(w-tw)/2:y=470:borderw=3:bordercolor=black@0.7`,
  ].join(","));
  // Resultados: cortes rápidos de producciones reales (DULCE primero, luego Océano).
  const resultsDur = await montage("results", tts.results.file, [D(170), D(455.8), O(11.7), D(242), O(20.1)], label("HECHO CON ATOMIVID", 0, 99, 300, 70));
  // Reveal: el beat principal, con espacio y "CREATED WITH ATOMIVID".
  const rw = tts.reveal.words;
  const createdAt = rw.find((w) => /creado/i.test(w.text))?.start ?? 2;
  const revealDur = await montage("reveal", tts.reveal.file, [O(36), D(195)], label("CREATED WITH ATOMIVID", createdAt, 99, 330, 88));
  // End card ≤ 1.2 s: marca tipográfica + claim (el repo no tiene logotipo de marca), fondo oscuro de marca (no negro puro).
  const END = 1.2;
  await ff(["-f", "lavfi", "-i", `color=c=0x0d1220:s=${W}x${H}:d=${END}:r=${FPS}`, "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-filter_complex",
    `[0:v]drawbox=x=(iw-220)/2:y=760:w=220:h=8:color=0x7fd3ff:t=fill,drawtext=fontfile=${FONT}:text='ATOMIVID':fontcolor=white:fontsize=170:x=(w-tw)/2:y=800,drawtext=fontfile=${FONT}:text='Tu idea. Tu video.':fontcolor=white:fontsize=72:x=(w-tw)/2:y=1030,drawtext=fontfile=${FONT}:text='Próximamente.':fontcolor=0x7fd3ff:fontsize=58:x=(w-tw)/2:y=1140[v]`,
    "-map", "[v]", "-map", "1:a", "-t", String(END), ...enc, seg("end")]);

  // ---------- Ensamblado: corte tecnológico (pixelado breve) Hans real → avatar ----------
  const order = ["opening", "avatar", "demo", "results", "reveal", "closing", "end"];
  const durs: Record<string, number> = {};
  for (const n of order) durs[n] = (await probe(seg(n))).duration;
  const XF = 0.3;
  const inputsArgs = order.flatMap((n) => ["-i", seg(n)]);
  const vchain = [`[0:v][1:v]xfade=transition=pixelize:duration=${XF}:offset=${(durs.opening - XF).toFixed(3)}[x01]`, `[x01]${order.slice(2).map((_, i) => `[${i + 2}:v]`).join("")}concat=n=${order.length - 1}:v=1:a=0[vcat]`];
  const achain = [`[0:a][1:a]acrossfade=d=${XF}[a01]`, `[a01]${order.slice(2).map((_, i) => `[${i + 2}:a]`).join("")}concat=n=${order.length - 1}:v=0:a=1[voice]`];
  const assembled = join(WORK, "assembled.mp4");
  await ff([...inputsArgs, "-filter_complex", [...vchain, ...achain].join(";"), "-map", "[vcat]", "-map", "[voice]", ...enc, assembled]);
  const total = (await probe(assembled)).duration;

  // ---------- Subtítulos dinámicos (ASS): palabra resaltada, ATOMIVID destacado, zona segura ----------
  const offsets: Record<string, number> = {};
  let t = 0;
  for (const n of order) { offsets[n] = n === "avatar" ? t - XF : t; t = offsets[n] + durs[n]; }
  // limit = fin del segmento: ningún subtítulo invade el plano siguiente (p. ej. "ATOMIVID." del reveal sobre el cierre real).
  const place = (k: string, w: Word) => ({ ...w, start: w.start + offsets[k], end: w.end + offsets[k], limit: offsets[k] + durs[k] - (k === "opening" ? XF : 0) });
  const timeline: Word[] = [
    ...real.opening.words.map((w) => place("opening", w)),
    ...(["avatar", "demo", "results", "reveal"] as const).flatMap((k) => tts[k].words.map((w) => place(k, w))),
    ...real.closing.words.map((w) => place("closing", w)),
  ];
  const ts = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, "0"); return `${h}:${String(m).padStart(2, "0")}:${x}`; };
  const chunks: Word[][] = [];
  for (const w of timeline) {
    const cur = chunks.at(-1);
    if (!cur || cur.length >= 3 || cur.at(-1)!.limit !== w.limit || /[.,…?!]$/.test(cur.at(-1)!.text) || w.start - cur.at(-1)!.end > 0.4) chunks.push([w]); else cur.push(w);
  }
  const events: string[] = [];
  chunks.forEach((c, ci) => {
    const next = chunks[ci + 1]?.[0].start ?? Infinity;
    const end = Math.min(c.at(-1)!.end + 0.08, next, c.at(-1)!.limit ?? Infinity);
    c.forEach((w, i) => {
      const from = w.start, to = i === c.length - 1 ? end : c[i + 1].start;
      const text = c.map((x, j) => {
        const brand = /ATOMIVID/i.test(x.text);
        const col = j === i ? "&H0000D7FF&" : brand ? "&H00FFD37F&" : "&H00FFFFFF&";
        return `{\\c${col}}${x.text.toUpperCase()}`;
      }).join(" ");
      events.push(`Dialogue: 0,${ts(from)},${ts(to)},Cap,,0,0,0,,${text}`);
    });
  });
  const ass = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "",
    "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap,Anton,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,2,2,140,160,560,1", "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, "",
  ].join("\n");
  const assPath = join(WORK, "captions.ass");
  await writeFile(assPath, ass);

  // ---------- Música curada con ducking bajo la voz + normalización para redes ----------
  const review = LOCAL !== null || AVATAR_MODE === "review-placeholder";
  const master = join(OUT, review ? "ATOMIVID-precampaign-teaser-v1-REVIEW-ONLY.mp4" : "ATOMIVID-precampaign-teaser-v1.mp4");
  const fontsDir = resolve("public/fonts");
  await ff(["-i", assembled, "-stream_loop", "-1", "-i", inputs.music, "-filter_complex",
    `[0:v]subtitles=${assPath}:fontsdir=${fontsDir}[v];` +
    `[1:a]atrim=0:${total.toFixed(3)},volume=0.32,afade=t=in:d=0.6,afade=t=out:st=${(total - 1.2).toFixed(3)}:d=1.2[m];` +
    `[0:a]asplit=2[vo][sc];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[md];` +
    `[vo][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
    "-map", "[v]", "-map", "[a]", "-t", total.toFixed(3), "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", master]);

  // ---------- QA automático (metadatos + señal; la revisión visual es humana con la hoja de contactos) ----------
  const m = await probe(master);
  const blk = await sh(FFMPEG, ["-hide_banner", "-i", master, "-vf", "blackdetect=d=0.25:pix_th=0.08", "-an", "-f", "null", "-"], { maxBuffer: 16 << 20 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const blackIntervals = [...blk.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
  const lufs = await sh(FFMPEG, ["-hide_banner", "-i", master, "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 16 << 20 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(lufs.stderr.split("Summary:").at(-1) ?? "")?.[1]);
  const truePeak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(lufs.stderr.split("Summary:").at(-1) ?? "")?.[1]);
  const first = await sh(FFMPEG, ["-hide_banner", "-i", master, "-vf", "select=eq(n\\,0),signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"], { maxBuffer: 16 << 20 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const firstYavg = Number(/YAVG=([\d.]+)/.exec(first.stderr)?.[1]);
  await ff(["-i", master, "-vf", "fps=1/1.5,scale=216:-2,tile=6x4", "-frames:v", "1", join(OUT, "contact-sheet.jpg")]);
  for (const [n, off] of Object.entries(offsets)) await ff(["-ss", (off + Math.min(1, durs[n] / 2)).toFixed(2), "-i", master, "-frames:v", "1", "-vf", "scale=540:-2", join(OUT, `frame-${n}.jpg`)]);
  await ff(["-i", master, "-vf", "scale=540:960", "-c:v", "libx264", "-crf", "26", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(OUT, "preview-540p.mp4")]);

  const qa = {
    resolution: `${m.width}x${m.height}`, fps: Math.round(m.fps * 1000) / 1000, durationSeconds: Math.round(m.duration * 100) / 100, hasAudio: m.hasAudio,
    checks: {
      resolution1080x1920: m.width === W && m.height === H, fps30: Math.abs(m.fps - FPS) < 0.05, duration30to36: m.duration >= 30 && m.duration <= 36,
      audioPresent: m.hasAudio, firstFrameVisual: firstYavg > 16, noAccidentalBlack: blackIntervals.length === 0, noClipping: truePeak <= -1.0,
    },
    loudnessLufs: integrated, truePeakDbfs: truePeak, firstFrameYavg: firstYavg, blackIntervals,
    sections: Object.fromEntries(order.map((n) => [n, { start: Math.round(offsets[n] * 100) / 100, duration: Math.round(durs[n] * 100) / 100 }])),
    retouch: { tools: "ffmpeg (hqdn3d, bilateral, curves, colorbalance, eq, unsharp)", localRetouchLimitReached: true, note: "Sin detección facial local: el suavizado y el color se aplican a todo el plano con parámetros leves; sin cambios de geometría." },
    humanReviewRequired: ["identidad preservada", "piel natural", "avatar sin deformación", "transición", "subtítulos sobre el rostro", "selección de planos de DULCE/Océano", "pronunciación de ATOMIVID"],
    notes,
  };
  const costReport = await buildCostReport(service);
  const manifest = {
    teaser: "ATOMIVID_PRECAMPAIGN_TEASER_V1",
    reused: {
      HANS_OPENING_REAL: process.env.TEASER_OPENING_PATH, HANS_CLOSING_REAL: process.env.TEASER_CLOSING_PATH,
      voice: process.env.TEASER_VOICE_ID, avatar: process.env.TEASER_AVATAR_ID,
      dulce: "videos/dulce-001/full-v1/final (manifest + partes)", ocean: "videos/ocean-deep-001/samples/episode/sample-approval-motion-production-check.mp4",
      music: `music-library/${process.env.TEASER_MUSIC_PATH ?? "elevenlabs-corporate-2.mp3"}`, font: "public/fonts/Anton-Regular.ttf",
    },
    generated: costs.map((c) => `${c.provider}:${c.operation}${c.reused ? " (reutilizado)" : ""}`),
    excluded: ["VIDEO-004 / Termópilas", "OpenAI Images", "Runway", "Veo", "Beatoven"],
  };
  await writeFile(join(OUT, "qa-report.json"), JSON.stringify(qa, null, 2) + "\n");
  await writeFile(join(OUT, "cost-report.json"), JSON.stringify(costReport, null, 2) + "\n");
  await writeFile(join(OUT, "asset-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (service && !review) {
    const bytes = await readFile(master);
    await service.storage.from("videos").upload(`${PROJECT}/output/ATOMIVID-precampaign-teaser-v1.mp4`, bytes, { contentType: "video/mp4", upsert: true });
  }
  console.log(JSON.stringify({ qa, costReport }, null, 2));
}

main().catch(async (err) => {
  console.error("Producción del teaser detenida:", err instanceof Error ? err.message : err);
  await mkdir(OUT, { recursive: true });
  const report = await (async () => {
    const { createServiceClient } = LOCAL ? { createServiceClient: () => null } : await import("../../src/lib/supabase/service");
    return buildCostReport(createServiceClient());
  })().catch(() => ({ capUsd: CAP, spentThisRunUsd: spent(), operations: costs }));
  await writeFile(join(OUT, "cost-report.json"), JSON.stringify({ ...report, stoppedWith: err instanceof Error ? err.message : String(err), notes }, null, 2) + "\n");
  process.exit(1);
});

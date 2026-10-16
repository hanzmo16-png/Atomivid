/**
 * Escenarios Avatar (HeyGen y D-ID) sobre el pipeline REAL
 * (src/lib/video/avatar/pipeline.ts → generateAvatarVideo) y los adaptadores
 * REALES. Solo la respuesta HTTP del proveedor está emulada (fake-providers.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { createFakeSupabase, type FakeSupabase } from "../lib/fake-supabase";
import type { createFakeDid, createFakeElevenLabs, createFakeHeygen, Step } from "../lib/fake-providers";
import { Scenario, probe, decodeFully, type ScenarioResult } from "../lib/report";
import { withVirtualTime } from "../lib/virtual-clock";
import { avatarEconomics } from "../lib/economics";
import type { AvatarJobStatus } from "../../../src/lib/providers/types";

type Fakes = { heygen: ReturnType<typeof createFakeHeygen>; did: ReturnType<typeof createFakeDid>; eleven: ReturnType<typeof createFakeElevenLabs>; setStorage: (s: FakeSupabase | null) => void };

const NARRATION = "Hola, esta es una prueba sintética del modo avatar de ATOMIVID. No hay ningún rostro real, solo un patrón de prueba, y la voz es un tono generado localmente.";
const SCRIPT = { title: "sim", segments: [{ text: NARRATION, visualQuery: "person" }] };

export async function runAvatarScenarios(fakes: Fakes, outDir: string): Promise<ScenarioResult[]> {
  const { generateAvatarVideo, AvatarPipelineError } = await import("../../../src/lib/video/avatar/pipeline");
  const { supabaseLedgerStore } = await import("../../../src/lib/paid-calls/supabase-ledger-store");
  const { memoryResultStore } = await import("../../../src/lib/paid-calls/result-store");
  const { handleAvatarWebhook, avatarStatusesThatMayAdvanceTo } = await import("../../../src/lib/video/avatar/webhook");
  const { heygenAvatarProvider } = await import("../../../src/lib/providers/avatar/heygen");
  const { didAvatarProvider } = await import("../../../src/lib/providers/avatar/did");
  const { fixtureAvatarProvider } = await import("../../../src/lib/providers/avatar/fixture");
  const results: ScenarioResult[] = [];

  type Req = { userId: string; requestId: string; avatarId: string };
  function world(provider: "heygen" | "did", reqs: Req[]) {
    const db = createFakeSupabase({ signedUrlBase: "https://sim-storage.local" });
    fakes.setStorage(db);
    for (const r of reqs) {
      db.table("avatars").push({ id: r.avatarId, user_id: r.userId, status: "ready", consent_given: true, provider_avatar_id: provider === "heygen" ? `asset:sim-photo-${r.avatarId}` : `https://sim-media.local/photo-${r.avatarId}.jpg`, provider });
      db.table("video_requests").push({ id: r.requestId, user_id: r.userId, avatar_id: r.avatarId, avatar_generation_started_at: null, avatar_provider_video_job_id: null, recorded_audio_path: null, avatar_render_status: null });
    }
    // Ledger REAL (pi_paid_operations) sobre la base simulada: reclaimUnsubmittedAvatarAttempt lee la misma tabla.
    const results = memoryResultStore();
    const gate = (_requestId: string) => ({ ledger: supabaseLedgerStore(db.client as never), results });
    const run = (r: Req, extra: { existingProviderVideoJobId?: string | null } = {}) =>
      generateAvatarVideo({ supabase: db.client as never, requestId: r.requestId, userId: r.userId, avatarId: r.avatarId, script: SCRIPT, paidCalls: gate(r.requestId), ...extra });
    const row = (id: string) => db.table("video_requests").find((x) => x.id === id)!;
    const opsOf = (id: string) => db.table("pi_paid_operations").filter((o) => o.project_id === id).map((o) => ({ method: o.method, status: o.status, providerJobId: o.provider_job_id }));
    return { db, run, row, opsOf, gate };
  }
  const setEnv = (provider: "heygen" | "did", maxCost = "3") => {
    process.env.AVATAR_MODE_ENABLED = "true";
    process.env.AVATAR_PROVIDER = provider;
    process.env.MAX_AVATAR_COST_USD = maxCost;
    process.env.VOICE_PROVIDER = "elevenlabs";
  };
  const err = (e: unknown) => (e instanceof Error ? `${e.name}${(e as { code?: string }).code ? `(${(e as { code?: string }).code})` : ""}: ${e.message}` : String(e));
  const code = (e: unknown) => (e instanceof AvatarPipelineError ? e.code : null);
  const billable = () => ({ heygen_post_v3_videos: fakes.heygen.billablePosts(), did_post_talks: fakes.did.billablePosts(), elevenlabs_tts_posts: fakes.eleven.billablePosts() });
  const delta = (before: ReturnType<typeof billable>) => { const now = billable(); return Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - before[k as keyof typeof before]])); };
  const polls = (calls: { method: string; path: string }[], prefix: string) => calls.filter((c) => c.method === "GET" && c.path.startsWith(prefix)).length;

  async function scenario(id: string, title: string, body: (s: Scenario) => Promise<void>) {
    const s = new Scenario(id, "avatar", title);
    const before = billable();
    const heygenCallsBefore = fakes.heygen.calls.length;
    const didCallsBefore = fakes.did.calls.length;
    let error: unknown;
    try { await body(s); } catch (e) { error = e; }
    s.data.providerCalls = { heygen: fakes.heygen.calls.slice(heygenCallsBefore).map((c) => `${c.method} ${c.path} → ${c.status}`), did: fakes.did.calls.slice(didCallsBefore).map((c) => `${c.method} ${c.path} → ${c.status}`) };
    results.push(s.finish(delta(before), error));
  }

  const keepMp4 = async (s: Scenario, db: FakeSupabase, requestId: string, name: string) => {
    const buf = db.objects.get(`videos/${requestId}/final.mp4`);
    if (!s.check("final.mp4 subido al Storage simulado", Boolean(buf))) return;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, buf!);
    decodeFully(file);
    const ev = probe(file);
    s.artifacts.push(ev);
    s.check("MP4 decodificable, H.264 + AAC, 9:16", ev.ffprobe.video?.codec === "h264" && ev.ffprobe.audio?.[0]?.codec === "aac" && Math.abs((ev.ffprobe.video?.width ?? 0) / (ev.ffprobe.video?.height ?? 1) - 9 / 16) < 0.01, ev.ffprobe);
  };

  // =========================== HeyGen ===========================
  setEnv("heygen");
  const u1: Req = { userId: "sim-user-1", requestId: "sim-av-hg-ok", avatarId: "sim-avatar-1" };

  await scenario("AV-HG-01", "HeyGen: trabajo asíncrono waiting→processing→completed, sondeo y finalización", async (s) => {
    const w = world("heygen", [u1]);
    fakes.heygen.setScript({ poll: ["waiting", "processing", "processing", "completed"] });
    s.step("generateAvatarVideo (pipeline real, adaptador HeyGen real)");
    const before = fakes.heygen.calls.length;
    const r = await withVirtualTime(() => w.run(u1));
    s.step(`fin; reloj virtual ${r.virtualMs} ms`);
    if (r.error) throw r.error;
    const calls = fakes.heygen.calls.slice(before);
    s.check("exactamente 1 POST /v3/videos facturable", calls.filter((c) => c.path === "/v3/videos").length === 1);
    s.check("4 sondeos GET /v3/videos/:id hasta completed", polls(calls, "/v3/videos/") === 4, polls(calls, "/v3/videos/"));
    s.check("espera virtual ≥ 30 s (3 intervalos de 10 s)", r.virtualMs >= 30_000, r.virtualMs);
    s.check("ledger generate_video COMMITTED", w.opsOf(u1.requestId).some((o) => o.method === "generate_video" && o.status === "COMMITTED"), w.opsOf(u1.requestId));
    s.check("video_requests: job guardado y estado completed", typeof w.row(u1.requestId).avatar_provider_video_job_id === "string" && w.row(u1.requestId).avatar_render_status === "completed", w.row(u1.requestId));
    await keepMp4(s, w.db, u1.requestId, "avatar-heygen-happy.mp4");
    const audioSeconds = Number((w.db.objects.get(`videos/${u1.requestId}/avatar-narration.wav`)?.length ?? 0) > 0 ? await (await import("../../../src/lib/video/avatar/measure-narration")).measureNarrationSeconds(w.db.objects.get(`videos/${u1.requestId}/avatar-narration.wav`)!) : 0);
    s.data.unit_economics = await avatarEconomics({ provider: "heygen", audioSeconds, voiceCharacters: NARRATION.length, script: NARRATION, billablePosts: 1 });
    s.data.audioSeconds = audioSeconds;
  });

  await scenario("AV-HG-02", "HeyGen: respuestas transitorias 503/502 durante el sondeo", async (s) => {
    const r1: Req = { userId: "sim-user-1", requestId: "sim-av-hg-transient", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r1]);
    fakes.heygen.setScript({ poll: ["processing", { http: 503 }, { http: 502 }, "completed"] });
    const before = fakes.heygen.calls.length;
    const r = await withVirtualTime(() => w.run(r1));
    if (r.error) throw r.error;
    const calls = fakes.heygen.calls.slice(before);
    s.check("los GET transitorios se reintentaron y el trabajo terminó", w.row(r1.requestId).avatar_render_status === "completed");
    s.check("1 solo POST /v3/videos (sin nueva creación)", calls.filter((c) => c.method === "POST" && c.path === "/v3/videos").length === 1);
    s.check("se observaron los 503/502", calls.some((c) => c.status === 503) && calls.some((c) => c.status === 502));
  });

  let recordedJob = "";
  const r3: Req = { userId: "sim-user-1", requestId: "sim-av-hg-timeout", avatarId: "sim-avatar-1" };
  const w3 = world("heygen", [r3]);
  await scenario("AV-HG-03", "HeyGen: timeout de 600 s con el trabajo aceptado (sin nuevo POST)", async (s) => {
    fakes.heygen.setScript({ poll: ["processing"] });
    const r = await withVirtualTime(() => w3.run(r3));
    s.step(`reloj virtual ${r.virtualMs} ms`);
    s.check("falla con provider_error (timeout)", code(r.error) === "provider_error" && /no se creó otro intento/.test(err(r.error)), err(r.error));
    s.check("esperó el plazo real del adaptador (≥ 600 s virtuales)", r.virtualMs >= 600_000, r.virtualMs);
    recordedJob = String(w3.row(r3.requestId).avatar_provider_video_job_id ?? "");
    s.check("job id guardado antes del fallo (onJobCreated)", recordedJob.startsWith("sim-hg-"), recordedJob);
    s.check("ledger PROVIDER_JOB_RECORDED (nunca reenvía)", w3.opsOf(r3.requestId).some((o) => o.method === "generate_video" && o.status === "PROVIDER_JOB_RECORDED"), w3.opsOf(r3.requestId));
  });

  await scenario("AV-HG-04", "HeyGen: reintento ingenuo tras la interrupción queda bloqueado", async (s) => {
    const r = await withVirtualTime(() => w3.run(r3));
    s.check("attempt_blocked", code(r.error) === "attempt_blocked", err(r.error));
  });

  await scenario("AV-HG-05", "HeyGen: recuperación tras interrupción (el proveedor terminó mientras el worker estaba caído)", async (s) => {
    fakes.heygen.setJobPoll(recordedJob, ["completed"]);
    const before = fakes.heygen.calls.length;
    const r = await withVirtualTime(() => w3.run(r3, { existingProviderVideoJobId: recordedJob }));
    if (r.error) throw r.error;
    const calls = fakes.heygen.calls.slice(before);
    s.check("recuperado solo con GET (0 POST)", calls.every((c) => c.method === "GET"), calls.map((c) => `${c.method} ${c.path}`));
    s.check("estado completed", w3.row(r3.requestId).avatar_render_status === "completed");
    await keepMp4(s, w3.db, r3.requestId, "avatar-heygen-recovered.mp4");
  });

  await scenario("AV-HG-06", "HeyGen: corte de red tras aceptar el POST (respuesta perdida) → reconciliación, nunca reenvío", async (s) => {
    const r6: Req = { userId: "sim-user-1", requestId: "sim-av-hg-ambiguous", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r6]);
    fakes.heygen.setScript({ create: { network: "reset" }, poll: ["completed"] });
    const before = fakes.heygen.billablePosts();
    const a = await withVirtualTime(() => w.run(r6));
    s.check("1er intento falla (provider_error)", code(a.error) === "provider_error", err(a.error));
    s.check("ledger RECONCILIATION_REQUIRED", w.opsOf(r6.requestId).some((o) => o.method === "generate_video" && o.status === "RECONCILIATION_REQUIRED"), w.opsOf(r6.requestId));
    const b = await withVirtualTime(() => w.run(r6));
    s.check("2º intento bloqueado (attempt_blocked: el ledger prueba que hubo envío)", code(b.error) === "attempt_blocked", err(b.error));
    s.check("POST facturables totales = 1 (sin duplicado)", fakes.heygen.billablePosts() - before === 1);
  });

  await scenario("AV-HG-07", "HeyGen: el proveedor informa failed → sin nuevo intento", async (s) => {
    const r7: Req = { userId: "sim-user-1", requestId: "sim-av-hg-failed", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r7]);
    fakes.heygen.setScript({ poll: ["processing", "failed"] });
    const before = fakes.heygen.billablePosts();
    const a = await withVirtualTime(() => w.run(r7));
    s.check("provider_error", code(a.error) === "provider_error", err(a.error));
    s.check("ledger PROVIDER_JOB_RECORDED", w.opsOf(r7.requestId).some((o) => o.status === "PROVIDER_JOB_RECORDED"));
    s.check("1 POST", fakes.heygen.billablePosts() - before === 1);
  });

  await scenario("AV-HG-08", "HeyGen: respuesta tardía/duplicada tras completar (doble envío del usuario y callback tardío)", async (s) => {
    const before = fakes.heygen.billablePosts();
    const r8: Req = { userId: "sim-user-1", requestId: "sim-av-hg-dupe", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r8]);
    fakes.heygen.setScript({ poll: ["completed"] });
    const ok = await withVirtualTime(() => w.run(r8));
    if (ok.error) throw ok.error;
    const dup = await withVirtualTime(() => w.run(r8));
    s.check("2º envío del mismo request tras completar → attempt_blocked", code(dup.error) === "attempt_blocked", err(dup.error));
    const hook = await handleAvatarWebhook({ provider: heygenAvatarProvider, rawPayload: { event_type: "avatar_video.success", event_data: { video_id: w.row(r8.requestId).avatar_provider_video_job_id } }, updateJobStatus: async () => ({ error: null }) });
    s.check("HeyGen no tiene webhook implementado: un callback se rechaza (400) sin tocar estado", hook.status === 400 && w.row(r8.requestId).avatar_render_status === "completed", hook);
    s.check("POST facturables = 1 (solo el envío original)", fakes.heygen.billablePosts() - before === 1, fakes.heygen.billablePosts() - before);
  });

  await scenario("AV-HG-09", "HeyGen: presupuesto insuficiente (MAX_AVATAR_COST_USD) antes de cualquier POST", async (s) => {
    setEnv("heygen", "0.05");
    const r9: Req = { userId: "sim-user-1", requestId: "sim-av-hg-budget", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r9]);
    const before = fakes.heygen.calls.length;
    const a = await withVirtualTime(() => w.run(r9));
    setEnv("heygen");
    s.check("rechazado (provider_error: budget_exceeded)", code(a.error) === "provider_error" && /presupuesto/.test(err(a.error)), err(a.error));
    s.check("0 peticiones a HeyGen (ni assets ni videos)", fakes.heygen.calls.length === before);
    s.check("ledger REFUNDED (rechazo final, $0)", w.opsOf(r9.requestId).some((o) => o.method === "generate_video" && o.status === "REFUNDED"), w.opsOf(r9.requestId));
  });

  await scenario("AV-HG-10", "HeyGen: doble clic — dos workers concurrentes sobre el mismo request", async (s) => {
    const r10: Req = { userId: "sim-user-1", requestId: "sim-av-hg-doubleclick", avatarId: "sim-avatar-1" };
    const w = world("heygen", [r10]);
    fakes.heygen.setScript({ poll: ["processing", "completed"] });
    const before = fakes.heygen.billablePosts();
    const r = await withVirtualTime(() => Promise.allSettled([w.run(r10), w.run(r10)]));
    const settled = r.result!;
    const outcome = settled.map((x) => x.status === "fulfilled" ? "ok" : err(x.reason));
    s.data.outcome = outcome;
    s.check("uno termina y el otro se rechaza antes de pedir otro video", settled.filter((x) => x.status === "fulfilled").length === 1 && settled.some((x) => x.status === "rejected" && ["attempt_blocked", "narration_failed"].includes(String(code(x.reason)))), outcome);
    s.check("1 solo POST facturable", fakes.heygen.billablePosts() - before === 1);
    s.check("1 sola síntesis de narración facturable", w.db.table("pi_paid_operations").filter((o) => o.method === "tts_with_timestamps").length === 1);
    if (outcome.some((o) => o.includes("narration_failed"))) s.data.finding = "El 2º worker no lo frena el intento único (avatar_generation_started_at): reclaimUnsubmittedAvatarAttempt lo re-reclama porque el 1º aún no tiene operaciones pagadas registradas; lo frena después la puerta del ledger de voz (narration_failed). Sin cobro doble, pero el 2º worker termina en error en vez de attempt_blocked.";
  });

  await scenario("AV-HG-11", "HeyGen: concurrencia de dos propietarios aislados + acceso cruzado", async (s) => {
    const a: Req = { userId: "sim-owner-a", requestId: "sim-av-hg-owner-a", avatarId: "sim-avatar-a" };
    const b: Req = { userId: "sim-owner-b", requestId: "sim-av-hg-owner-b", avatarId: "sim-avatar-b" };
    const w = world("heygen", [a, b]);
    fakes.heygen.setScript({ poll: ["processing", "completed"] });
    const before = fakes.heygen.billablePosts();
    const r = await withVirtualTime(() => Promise.allSettled([w.run(a), w.run(b)]));
    s.check("ambos terminan", r.result!.every((x) => x.status === "fulfilled"), r.result!.map((x) => x.status));
    s.check("2 POST (uno por trabajo)", fakes.heygen.billablePosts() - before === 2);
    s.check("rutas de salida aisladas por request", w.db.objects.has(`videos/${a.requestId}/final.mp4`) && w.db.objects.has(`videos/${b.requestId}/final.mp4`));
    s.check("jobs distintos", w.row(a.requestId).avatar_provider_video_job_id !== w.row(b.requestId).avatar_provider_video_job_id);
    const cross = await withVirtualTime(() => generateAvatarVideo({ supabase: w.db.client as never, requestId: b.requestId, userId: b.userId, avatarId: a.avatarId, script: SCRIPT, paidCalls: w.gate("cross") }));
    s.check("propietario B no puede usar el avatar de A (avatar_not_owned)", code(cross.error) === "avatar_not_owned", err(cross.error));
  });

  // =========================== D-ID ===========================
  setEnv("did");
  const d1: Req = { userId: "sim-user-1", requestId: "sim-av-did-ok", avatarId: "sim-avatar-d" };
  await scenario("AV-DID-01", "D-ID: talk created→started→done, sondeo con backoff y finalización", async (s) => {
    const w = world("did", [d1]);
    fakes.did.setScript({ poll: ["created", "started", "started", "done"] });
    const before = fakes.did.calls.length;
    const r = await withVirtualTime(() => w.run(d1));
    if (r.error) throw r.error;
    const calls = fakes.did.calls.slice(before);
    s.check("1 POST /talks", calls.filter((c) => c.method === "POST").length === 1);
    s.check("4 sondeos GET /talks/:id", polls(calls, "/talks/") === 4, polls(calls, "/talks/"));
    s.check("backoff 3 s → 4.5 s → 6.75 s (≥ 14 s virtuales)", r.virtualMs >= 14_000, r.virtualMs);
    s.check("ledger COMMITTED", w.opsOf(d1.requestId).some((o) => o.status === "COMMITTED"));
    await keepMp4(s, w.db, d1.requestId, "avatar-did-happy.mp4");
    const { measureNarrationSeconds } = await import("../../../src/lib/video/avatar/measure-narration");
    const narration = [...w.db.objects.entries()].find(([k]) => k.startsWith(`videos/${d1.requestId}/avatar-narration.`))?.[1];
    const audioSeconds = narration ? await measureNarrationSeconds(narration) : 0;
    s.data.unit_economics = await avatarEconomics({ provider: "did", audioSeconds, voiceCharacters: NARRATION.length, script: NARRATION, billablePosts: 1 });
  });

  const d2: Req = { userId: "sim-user-1", requestId: "sim-av-did-transient", avatarId: "sim-avatar-d" };
  const wd2 = world("did", [d2]);
  let didJob = "";
  await scenario("AV-DID-02", "D-ID: un 503 transitorio en el sondeo NO aborta el trabajo", async (s) => {
    fakes.did.setScript({ poll: ["started", { http: 503 }, "done"] });
    const r = await withVirtualTime(() => wd2.run(d2));
    didJob = String(wd2.row(d2.requestId).avatar_provider_video_job_id ?? "");
    s.data.observed = r.error ? err(r.error) : "completado";
    s.check("el trabajo termina pese al 503 transitorio", !r.error && wd2.row(d2.requestId).avatar_render_status === "completed", s.data.observed);
  });

  await scenario("AV-DID-03", "D-ID: tras el 503 del sondeo — sin POST duplicado y recuperable por GET", async (s) => {
    const before = fakes.did.billablePosts();
    s.check("job id guardado", didJob.startsWith("sim-did-"), didJob);
    const blocked = await withVirtualTime(() => wd2.run(d2));
    s.check("reintento ingenuo bloqueado", code(blocked.error) === "attempt_blocked", err(blocked.error));
    fakes.did.setJobPoll(didJob, ["done"]);
    const rec = await withVirtualTime(() => wd2.run(d2, { existingProviderVideoJobId: didJob }));
    if (rec.error) throw rec.error;
    s.check("recuperado con GET /talks/:id", wd2.row(d2.requestId).avatar_render_status === "completed");
    s.check("0 POST /talks adicionales", fakes.did.billablePosts() - before === 0);
  });

  await scenario("AV-DID-04", "D-ID: timeout del sondeo (30 intentos / 300 s) sin nuevo POST", async (s) => {
    const d4: Req = { userId: "sim-user-1", requestId: "sim-av-did-timeout", avatarId: "sim-avatar-d" };
    const w = world("did", [d4]);
    fakes.did.setScript({ poll: ["started"] });
    const before = fakes.did.billablePosts();
    const r = await withVirtualTime(() => w.run(d4));
    s.step(`reloj virtual ${r.virtualMs} ms`);
    s.check("provider_error por timeout", code(r.error) === "provider_error" && /(Tiempo de espera|agotaron)/.test(err(r.error)), err(r.error));
    s.check("1 POST", fakes.did.billablePosts() - before === 1);
    s.check("ledger PROVIDER_JOB_RECORDED", w.opsOf(d4.requestId).some((o) => o.status === "PROVIDER_JOB_RECORDED"), w.opsOf(d4.requestId));
  });

  await scenario("AV-DID-05", "D-ID: saldo insuficiente del proveedor (HTTP 402 InsufficientCreditsError)", async (s) => {
    const d5: Req = { userId: "sim-user-1", requestId: "sim-av-did-credits", avatarId: "sim-avatar-d" };
    const w = world("did", [d5]);
    fakes.did.setScript({ create: { http: 402, body: { kind: "InsufficientCreditsError" } }, poll: ["done"] });
    const before = fakes.did.billablePosts();
    const r = await withVirtualTime(() => w.run(d5));
    s.check("provider_error con el código del proveedor", code(r.error) === "provider_error" && /InsufficientCreditsError/.test(err(r.error)), err(r.error));
    s.check("sin reintento del POST (1 intento)", fakes.did.billablePosts() - before === 1);
    s.data.ledger = w.opsOf(d5.requestId);
    s.check("ledger generate_video no COMMITTED (402 tratado como incierto: RECONCILIATION_REQUIRED, sin reintento)", w.opsOf(d5.requestId).some((o) => o.method === "generate_video" && o.status === "RECONCILIATION_REQUIRED"), w.opsOf(d5.requestId));
  });

  await scenario("AV-DID-06", "D-ID: callbacks — el parser existe pero la ruta no registra D-ID (el flujo real es solo sondeo)", async (s) => {
    const parsed = didAvatarProvider.processWebhookPayload({ id: "sim-did-x", status: "done" });
    s.check("processWebhookPayload(D-ID) reconoce {id,status}", parsed?.status === "completed", parsed);
    const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/app/api/webhooks/avatar/[provider]/route.ts"), "utf8");
    const providersMap = routeSrc.match(/const PROVIDERS[^}]+}/)?.[0] ?? "";
    s.check("la ruta /api/webhooks/avatar/[provider] NO incluye did (callbacks D-ID inalcanzables; solo sondeo)", !/\bdid\b/.test(providersMap), providersMap.replace(/\s+/g, " "));
  });

  await scenario("AV-WH-01", "Callback duplicado y tardío (lógica real del webhook + el UPDATE exacto de la ruta) no retrocede un trabajo completado", async (s) => {
    // Único proveedor con callbacks aceptados por la ruta: fixture (HeyGen devuelve null, D-ID no está registrado).
    const w = world("did", [{ userId: "sim-user-1", requestId: "sim-av-wh", avatarId: "sim-avatar-wh" }]);
    w.row("sim-av-wh").avatar_provider_video_job_id = "sim-fx-1";
    w.row("sim-av-wh").avatar_render_status = "processing";
    // Mismo UPDATE que src/app/api/webhooks/avatar/[provider]/route.ts (condicionado al estado previo: nunca retrocede).
    const update = async (job: string, st: AvatarJobStatus) => {
      const { error } = await w.db.client.from("video_requests").update({ avatar_render_status: st }).eq("avatar_provider_video_job_id", job)
        .in("avatar_render_status", avatarStatusesThatMayAdvanceTo(st));
      return { error: error ? String(error) : null };
    };
    const seq: string[] = [];
    for (const st of ["completed", "completed", "processing"] as AvatarJobStatus[]) {
      const out = await handleAvatarWebhook({ provider: fixtureAvatarProvider, rawPayload: { providerJobId: "sim-fx-1", status: st }, updateJobStatus: update as never });
      seq.push(`${st}→${out.status}:${w.row("sim-av-wh").avatar_render_status}`);
    }
    s.data.sequence = seq;
    s.check("callback duplicado 'completed' aceptado sin cambios (idempotente)", seq[1].endsWith("completed"), seq);
    s.check("callback tardío 'processing' NO retrocede el estado completed", w.row("sim-av-wh").avatar_render_status === "completed", seq);
  });

  return results;
}

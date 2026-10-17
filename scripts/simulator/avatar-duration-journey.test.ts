/**
 * T-24 C1 — recorrido del CLIENTE tras "el audio real supera el límite de Avatar" por la orquestación REAL:
 * runRenderJob (run-job.ts) → generateAvatarVideo → adaptadores HeyGen/ElevenLabs reales contra los emuladores
 * HTTP del simulador; escritura durable del fallo; recuperación que leen historial/revisión (loadAvatarRecovery,
 * describeStoredFailure); edición del guion (persistScriptChange, la misma escritura que la ruta del guion) y un
 * nuevo intento. Solo createServiceClient se sustituye por la base simulada (mock.module). Red externa negada.
 *
 *   node --experimental-test-module-mocks --import tsx --test scripts/simulator/avatar-duration-journey.test.ts
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installNetworkGuard, scrubProviderEnv, guardStats } from "./lib/guard";
import { createFakeSupabase } from "./lib/fake-supabase";
import { createFakeElevenLabs, createFakeHeygen, installMediaHost } from "./lib/fake-providers";

scrubProviderEnv();
Object.assign(process.env, {
  SCRIPT_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture",
  VOICE_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "sim-not-a-real-key", HEYGEN_API_KEY: "sim-not-a-real-key",
  AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "heygen", MAX_AVATAR_COST_USD: "3",
  // Estimación de la app: 29 palabras / 2,5 = 11,6 s ≤ 12; audio emulado ≈ 13 s > 12.
  MAX_AVATAR_DURATION_SECONDS: "12",
});
installNetworkGuard();

const db = createFakeSupabase({ signedUrlBase: "https://sim-storage.local" });
installMediaHost((key) => db.objects.get(key));
const heygen = createFakeHeygen();
const eleven = createFakeElevenLabs();
mock.module(pathToFileURL(path.join(process.cwd(), "src/lib/supabase/service.ts")).href, {
  namedExports: { createServiceClient: () => db.client },
});

const LONG = "Hola, esta es una prueba sintética del modo avatar de ATOMIVID. No hay ningún rostro real, solo un patrón de prueba, y la voz es un tono generado localmente.";
const SHORT = "Hola, esta es una prueba sintética del modo avatar de ATOMIVID.";
const script = (text: string) => ({ title: "sim", segments: [{ text, visualQuery: "person" }] });
const REQ = "sim-av-journey", USER = "sim-user-1", AVATAR = "sim-avatar-1";

db.table("avatars").push({ id: AVATAR, user_id: USER, status: "ready", consent_given: true, provider_avatar_id: `asset:sim-photo-${AVATAR}`, provider: "heygen" });
db.table("video_requests").push({
  id: REQ, user_id: USER, mode: "avatar", status: "processing", render_attempts: 1, progress_stage: null, script_json: script(LONG),
  style: "Educativo", topic: "sim", language: "es", duration_seconds: 30, avatar_id: AVATAR, avatar_voice_id: null,
  avatar_provider_video_job_id: null, avatar_generation_started_at: null, recorded_audio_path: null, avatar_narration_source: null,
  long_form_production_plan: null, long_form_confirmed_at: null, error_message: null, video_path: null,
});
const row = () => db.table("video_requests").find((r) => r.id === REQ)!;
const ops = () => db.table("pi_paid_operations").filter((o) => o.project_id === REQ).map((o) => ({ method: String(o.method), status: String(o.status), provider_job_id: (o.provider_job_id as string | null) ?? null }));
const videoPosts = () => heygen.calls.filter((c) => c.method === "POST" && c.path === "/v3/videos").length;
/** Lo que hace la ruta /render al iniciar otro intento (render_attempts+1, processing, sin etapa). */
const startAttempt = () => Object.assign(row(), { status: "processing", render_attempts: Number(row().render_attempts) + 1, progress_stage: null, error_message: null });

test("audio real por encima del límite: causa accionable, edición del guion y nuevo intento sin pagar dos veces", async () => {
  const { runRenderJob } = await import("../../src/lib/video/run-job");
  const { loadAvatarRecovery } = await import("../../src/lib/video/avatar/recovery");
  const { describeStoredFailure } = await import("../../src/lib/video/job-error");
  const { persistScriptChange } = await import("../../src/lib/video/script-persistence");

  // 1) Primer intento: estimación dentro del límite, audio real fuera.
  await runRenderJob(REQ, 1).catch(() => undefined);
  const r1 = row();
  assert.equal(eleven.billablePosts(), 1, "una sola TTS");
  assert.equal(videoPosts(), 0, "HeyGen nunca recibe el video");
  assert.equal(r1.avatar_provider_video_job_id, null);
  assert.ok(!ops().some((o) => o.method === "generate_video"), JSON.stringify(ops()));
  assert.ok(ops().some((o) => o.method === "tts_with_timestamps" && o.status === "COMMITTED"), JSON.stringify(ops()));

  // 2) Recarga del cliente: estado durable + mensaje + acción.
  const stored = describeStoredFailure(String(r1.error_message ?? ""));
  assert.match(stored.message, /duración/i, `causa visible: ${stored.message}`);
  assert.equal(r1.status, "script_ready", `el guion vuelve a ser editable (estado: ${r1.status})`);
  const recovery = await loadAvatarRecovery(db.client as never, REQ, { status: String(r1.status), render_attempts: Number(r1.render_attempts), avatar_provider_video_job_id: null, video_path: null });
  assert.notEqual(recovery.action === "none" && recovery.reason === "paid_result_missing", true, `sin "contacta a soporte" falso: ${JSON.stringify(recovery)}`);

  // 3) Reintento SIN editar: la TTS idéntica no se vuelve a pagar y sigue bloqueado por duración.
  startAttempt();
  await runRenderJob(REQ, 2).catch(() => undefined);
  assert.equal(eleven.billablePosts(), 1, "TTS idéntica reutilizada, sin segundo cobro");
  assert.equal(videoPosts(), 0);
  assert.match(describeStoredFailure(String(row().error_message ?? "")).message, /duración/i);
  assert.equal(row().status, "script_ready");

  // 4) El cliente acorta el guion (misma escritura que la ruta del guion) y vuelve a intentar: una TTS nueva, un video.
  const before = row();
  await persistScriptChange(db.client as never, { id: REQ, user_id: USER, status: String(before.status), render_attempts: Number(before.render_attempts), script_json: before.script_json }, { script_json: script(SHORT), error_message: null });
  startAttempt();
  await runRenderJob(REQ, 3);
  assert.equal(eleven.billablePosts(), 2, "la narración editada sí se sintetiza (una vez)");
  assert.equal(videoPosts(), 1, "exactamente un video");
  assert.equal(row().status, "completed", JSON.stringify(row()));
  assert.equal(guardStats.blocked.length, 0, "ninguna llamada externa real");
});

test("cierre fail-closed: un generate_video tocado o con provider_job_id nunca se desbloquea", async () => {
  const { decideAvatarRecovery } = await import("../../src/lib/video/avatar/recovery");
  const base = { status: "failed", render_attempts: 1, avatar_provider_video_job_id: null, video_path: null };
  const tts = { method: "tts_with_timestamps", status: "COMMITTED", provider_job_id: "sync:op_x" };
  for (const status of ["SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED", "COMMITTED"]) {
    const r = decideAvatarRecovery(base, [tts, { method: "generate_video", status, provider_job_id: null }]);
    assert.equal(r.action, "none", `generate_video ${status} → ${JSON.stringify(r)}`);
  }
  assert.equal(decideAvatarRecovery(base, [tts, { method: "generate_video", status: "RESERVED", provider_job_id: "job-1" }]).action, "none");
  // Una TTS incierta tampoco se desbloquea a ciegas.
  assert.equal(decideAvatarRecovery(base, [{ method: "tts_with_timestamps", status: "RECONCILIATION_REQUIRED", provider_job_id: null }]).action, "none");
});

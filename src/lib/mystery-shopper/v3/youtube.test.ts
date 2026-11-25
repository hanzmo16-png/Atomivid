import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ytSpendGuard, stageIncidents, renderIncidents, YT_LIMITS, runYoutubeStudio } from "../../../../scripts/mystery-shopper/youtube-mission";
import { measureVideo, parseDecode, parseProbe } from "../../../../scripts/mystery-shopper/av-check";
import { detectAv } from "./detect";
import { ledgerStore, MODULE_CAP_USD, type LedgerState } from "./ledger";
import type { StorageApi } from "../jobs";

const empty: LedgerState = { reservations: [], settlements: [] };
const base = { real: true, killSwitch: true, stopped: false, ledger: empty, amountUsd: 0.6, runCapUsd: 2, runCommittedUsd: 0 };

test("guardia YouTube: cada condición por separado impide el clic que cuesta", () => {
  assert.equal(ytSpendGuard(base).ok, true);
  assert.match(ytSpendGuard({ ...base, real: false }).reason, /gratuito/);
  assert.match(ytSpendGuard({ ...base, killSwitch: false }).reason, /Interruptor/);
  assert.match(ytSpendGuard({ ...base, stopped: true }).reason, /STOP/);
  assert.match(ytSpendGuard({ ...base, ledger: null }).reason, /libro/);
  assert.match(ytSpendGuard({ ...base, amountUsd: null }).reason, /monto/);
  assert.match(ytSpendGuard({ ...base, amountUsd: 0 }).reason, /monto/);
  assert.match(ytSpendGuard({ ...base, runCapUsd: 1, runCommittedUsd: 0.6, amountUsd: 0.5 }).reason, /tope de esta ejecución/);
  // módulo USD 2: guion 0.60 ya comprometido + render 1.50 no cabe
  const withScript: LedgerState = { reservations: [{ key: "s", module: "youtube", jobId: "j", reservedUsd: 0.6, at: "" }], settlements: [] };
  assert.equal(ytSpendGuard({ ...base, ledger: withScript, amountUsd: 1.5, runCapUsd: 5 }).ok, false);
  assert.equal(ytSpendGuard({ ...base, ledger: withScript, amountUsd: 1.4, runCapUsd: 5 }).ok, true);
  // acumulado USD 8.50: otros módulos ya llenaron el tope
  const full: LedgerState = { reservations: [{ key: "a", module: "audio-podcast", jobId: "j", reservedUsd: 2, at: "" }, { key: "r", module: "reels", jobId: "j", reservedUsd: 1.5, at: "" }, { key: "v", module: "video-podcast", jobId: "j", reservedUsd: 3, at: "" }, { key: "y", module: "youtube", jobId: "j", reservedUsd: 1.9, at: "" }], settlements: [] };
  assert.equal(ytSpendGuard({ ...base, ledger: full, amountUsd: 0.2 }).ok, false);
  assert.equal(MODULE_CAP_USD.youtube, 2);
  assert.equal(YT_LIMITS.minutes, 3);
});

test("libro: STOP detiene; error al leer el libro también (no se gasta a ciegas)", async () => {
  const names: string[] = [];
  const ok: StorageApi = { async list() { return { data: names.map((name) => ({ name })), error: null }; }, async download() { return { data: null, error: null }; }, async upload() { return { error: null }; } };
  assert.equal(await ledgerStore(ok).stopped(), false);
  names.push("STOP");
  assert.equal(await ledgerStore(ok).stopped(), true);
  const broken: StorageApi = { ...ok, async list() { return { data: null, error: { message: "boom" } }; } };
  assert.equal(await ledgerStore(broken).stopped(), true);
});

test("preparación del guion: misma etapa > 10 min = atasco; sin terminar > 25 min = interminable", () => {
  const m = 60_000;
  const stuck = [0, 4, 8, 12].map((x) => ({ t: x * m, stage: "Preparando guion · investigando" }));
  assert.ok(stageIncidents("youtube", "/j", stuck, { maxTotalMs: 25 * m, maxStallMs: 10 * m }).some((i) => /no cambia/.test(i.title)));
  const moving = [0, 4, 8, 12].map((x, i) => ({ t: x * m, stage: `etapa ${i}`, done: i === 3 }));
  assert.deepEqual(stageIncidents("youtube", "/j", moving, { maxTotalMs: 25 * m, maxStallMs: 10 * m }), []);
  const endless = [0, 9, 18, 26].map((x, i) => ({ t: x * m, stage: `etapa ${i}` }));
  assert.ok(stageIncidents("youtube", "/j", endless, { maxTotalMs: 25 * m, maxStallMs: 10 * m }).some((i) => i.kind === "endless_generation"));
});

test("render: 100 % mientras procesa, retroceso y barra quieta se detectan; progreso sano no", () => {
  const L = { maxTotalMs: 60 * 60_000, maxStallMs: 10 * 60_000 };
  assert.ok(renderIncidents("/v", [{ t: 0, pct: 40, state: "processing" }, { t: 15_000, pct: 100, state: "processing" }], L).some((i) => /100 %/.test(i.title)));
  assert.ok(renderIncidents("/v", [{ t: 0, pct: 40, state: "processing" }, { t: 15_000, pct: 20, state: "processing" }], L).some((i) => /retrocede/.test(i.title)));
  assert.ok(renderIncidents("/v", [{ t: 0, pct: 30, state: "processing" }, { t: 11 * 60_000, pct: 30, state: "processing" }], L).some((i) => /quieto/.test(i.title)));
  assert.deepEqual(renderIncidents("/v", [{ t: 0, pct: 10, state: "processing" }, { t: 15_000, pct: 55, state: "processing" }, { t: 30_000, pct: 90, state: "processing" }, { t: 45_000, pct: null, state: "completed" }], L), []);
});

test("A/V: sin audio = P0; audio 2 s en video 6 s = desincronizado; inicio desfasado = P1; sano = sin incidentes", () => {
  const ctx = { module: "youtube" as const, screen: "/v", repro: [] };
  const v = { codec: "h264", durationSeconds: 6, startSeconds: 0, frames: 150, width: 1280, height: 720 };
  assert.equal(detectAv(ctx, { file: "x.mp4", video: v, audio: null })[0].severity, "P0");
  assert.ok(detectAv(ctx, { file: "x.mp4", video: v, audio: { codec: "aac", durationSeconds: 2, startSeconds: 0, channels: 1 } }).some((i) => i.kind === "av_desync"));
  assert.ok(detectAv(ctx, { file: "x.mp4", video: v, audio: { codec: "aac", durationSeconds: 6, startSeconds: 0.5, channels: 1 } }).some((i) => /desfasado/.test(i.title)));
  assert.deepEqual(detectAv(ctx, { file: "x.mp4", video: v, audio: { codec: "aac", durationSeconds: 6.02, startSeconds: 0, channels: 1 } }), []);
});

test("parseo ffprobe/ffmpeg: pistas, carátula ignorada y errores de decodificación", () => {
  const p = parseProbe("/x/a.mp4", JSON.stringify({ streams: [{ codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }, { codec_type: "video", codec_name: "h264", duration: "6.0", start_time: "0", nb_frames: "150", width: 1280, height: 720 }, { codec_type: "audio", codec_name: "aac", duration: "5.98", start_time: "0", channels: 2 }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "6.0", size: "1234" } }));
  assert.equal(p.video?.codec, "h264"); assert.equal(p.audio?.channels, 2); assert.equal(p.sizeBytes, 1234);
  assert.equal(parseDecode("[aac @ 0x1] Input buffer exhausted before END element found\n[h264 @ 0x2] error while decoding MB 3 4").decodeOk, false);
  const ok = parseDecode("[Parsed_volumedetect_0 @ 0x1] mean_volume: -21.3 dB\n[silencedetect @ 0x2] silence_end: 4 | silence_duration: 1.25");
  assert.equal(ok.decodeOk, true); assert.equal(ok.meanVolumeDb, -21.3); assert.equal(ok.maxSilenceSeconds, 1.25);
});

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("medición real con ffmpeg: MP4 sano, audio corto, sin audio y truncado", { skip: !hasFfmpeg && "sin ffmpeg" }, async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "ms-yt-"));
  const mk = (name: string, args: string[]) => { execFileSync("ffmpeg", ["-v", "error", "-y", ...args, path.join(d, name)]); return path.join(d, name); };
  const v = ["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25:duration=6"];
  const good = mk("good.mp4", [...v, "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]);
  const short = mk("short.mp4", [...v, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const mute = mk("mute.mp4", [...v, "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const trunc = path.join(d, "trunc.mp4"); writeFileSync(trunc, readFileSync(good).subarray(0, 40_000));
  const ctx = { module: "youtube" as const, screen: "/v", repro: [] };
  const g = await measureVideo(good);
  assert.equal(g.decodeOk, true); assert.equal(g.video?.width, 1280); assert.ok(Math.abs((g.durationSeconds ?? 0) - 6) < 0.2); assert.ok((g.meanVolumeDb ?? -99) > -40);
  assert.deepEqual(detectAv(ctx, g), []);
  assert.ok(detectAv(ctx, await measureVideo(short)).some((i) => i.kind === "av_desync"));
  assert.ok(detectAv(ctx, await measureVideo(mute)).some((i) => /pista de audio/.test(i.title)));
  const t = await measureVideo(trunc);
  assert.equal(t.decodeOk, false);
});

test("misión: en modo real con el interruptor apagado NO pulsa «Crear y revisar guion»", async () => {
  const clicks: string[] = []; const steps: { name: string; state: string; detail: string }[] = [];
  const el = (name: string) => ({ fill: async () => {}, selectOption: async () => {}, click: async () => { clicks.push(name); }, isVisible: async () => true, first() { return this; }, innerText: async () => "Nuevo video" });
  const page = { url: () => "https://atomicvid.app/dashboard/long-form/new", locator: () => el("loc"), getByLabel: (n: string) => el(n), getByText: (n: string) => el(String(n)), getByRole: (_r: string, o: { name: string }) => el(o.name), waitForTimeout: async () => {} };
  const reservations: string[] = [];
  const c = {
    page, jobId: "ms-abc123", baseUrl: "https://atomicvid.app", out: os.tmpdir(), real: true, media: [], incidents: [],
    ledger: { state: async () => empty, reserve: async (r: { key: string }) => { reservations.push(r.key); return { ok: true, reason: "" }; }, settle: async () => {}, stopped: async () => false },
    killSwitch: () => false, runCapUsd: 2,
    step: async (name: string, fn: () => Promise<{ state: string; detail: string }>) => { const r = await fn(); steps.push({ name, ...r }); return r; },
    goto: async () => ({ httpStatus: 200 }), metrics: async () => ({}), mark: () => {}, cIdx: () => 0, act: () => {}, probe: async () => ({}), setCritical: () => {}, setHumanGate: () => {}, addSpend: () => {},
  };
  await runYoutubeStudio(c as never);
  assert.deepEqual(clicks.filter((x) => /Crear y revisar guion|Confirmar y generar/.test(x)), []);
  assert.deepEqual(reservations, []);
  assert.ok(steps.some((s) => s.state === "BLOCKED" && /Interruptor/.test(s.detail)));
});

test("reserva acotada del render: estimado × contingencia + runner bajo nuestro límite; nunca sin corte ni sobre el techo", async () => {
  const { boundedRenderReserve } = await import("../../../../scripts/mystery-shopper/youtube-mission");
  const base = { providerEstimateUsd: 0.49, ceilingUsd: 8.04, renderTimeoutMs: 60 * 60_000, runnerUsdPerMin: 0.008, contingency: 1.5, canCancel: true };
  assert.equal(boundedRenderReserve(base), 1.22);
  assert.equal(boundedRenderReserve({ ...base, canCancel: false }), null);
  assert.equal(boundedRenderReserve({ ...base, providerEstimateUsd: null }), null);
  assert.equal(boundedRenderReserve({ ...base, contingency: 0.5 }), null);
  assert.equal(boundedRenderReserve({ ...base, ceilingUsd: 0.9 }), 0.9);
});

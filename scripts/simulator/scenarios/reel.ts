/**
 * Escenarios Reel sobre el pipeline REAL del producto (generate-script →
 * generate-video → Remotion "VerticalReel" → masterización), igual que
 * scripts/test-pipeline.ts, pero con la voz por el adaptador REAL de
 * ElevenLabs contra el ElevenLabs emulado (marcas por carácter y pausas
 * naturales), la puerta de llamadas pagadas en memoria y render a la
 * resolución de producción (1080x1920).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createFakeSupabase, type FakeSupabase } from "../lib/fake-supabase";
import { wordsFromAlignment, type createFakeElevenLabs } from "../lib/fake-providers";
import { Scenario, probe, decodeFully, type ScenarioResult } from "../lib/report";
import { analyzeSubtitles } from "../lib/subtitles";
import { audioSilences, mediaDuration, readCaptures, verifyBurnedCaptions } from "../lib/media-checks";
import { reelEconomics } from "../lib/economics";

export async function runReelScenarios(eleven: ReturnType<typeof createFakeElevenLabs>, outDir: string, captureDir: string, setStorage: (s: FakeSupabase | null) => void): Promise<ScenarioResult[]> {
  const { generateScriptForRequest } = await import("../../../src/lib/video/generate-script");
  const { generateVideoFromScript } = await import("../../../src/lib/video/generate-video");
  const { memoryLedgerStore } = await import("../../../src/lib/production-intelligence/ledger");
  const { memoryResultStore } = await import("../../../src/lib/paid-calls/result-store");
  const results: ScenarioResult[] = [];

  // Storage simulado servido por HTTP local (Remotion necesita URLs http reales).
  let current: FakeSupabase | null = null;
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "/").slice(1).split("?")[0]);
    const b = current?.objects.get(key);
    if (!b) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": key.endsWith(".mp3") ? "audio/mpeg" : key.endsWith(".wav") ? "audio/wav" : key.endsWith(".svg") ? "image/svg+xml" : key.endsWith(".mp4") ? "video/mp4" : "application/octet-stream" });
    res.end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const newDb = () => { const db = createFakeSupabase({ signedUrlBase: base }); current = db; setStorage(db); return db; };

  const style = "documental, sobrio";
  const topic = "Simulación sintética: por qué el agua hierve antes en la montaña";
  const durationSeconds = 30;
  const scriptOnce = await generateScriptForRequest({ topic, style, durationSeconds });

  async function scenario(id: string, title: string, body: (s: Scenario) => Promise<void>) {
    const s = new Scenario(id, "reel", title);
    const before = eleven.billablePosts();
    let error: unknown;
    try { await body(s); } catch (e) { error = e; }
    results.push(s.finish({ elevenlabs_tts_posts: eleven.billablePosts() - before }, error));
  }
  const render = (db: FakeSupabase, requestId: string, paid: { ledger: ReturnType<typeof memoryLedgerStore>; results: ReturnType<typeof memoryResultStore> }, onStage?: (st: string) => void) =>
    generateVideoFromScript({ supabase: db.client as never, requestId, script: structuredClone(scriptOnce.script), style, topic, targetDurationSeconds: durationSeconds, paidCalls: paid, onProgress: (st) => onStage?.(st) });
  const ops = (p: { ledger: ReturnType<typeof memoryLedgerStore> }) => [...p.ledger.ops.values()].map((o) => `${o.method}:${o.status}`);

  const paidOk = { ledger: memoryLedgerStore(), results: memoryResultStore() };
  const dbOk = newDb();
  await scenario("RE-01", "Reel: recorrido completo (guion → voz ElevenLabs → footage → música → render 1080x1920 → masterización)", async (s) => {
    const histBefore = eleven.history.length;
    const capsBefore = readCaptures(captureDir).length;
    const charsBefore = eleven.chars;
    s.step(`guion fixture: ${scriptOnce.script.segments.length} escenas (${scriptOnce.providerName})`);
    const { videoPath } = await render(dbOk, "sim-reel-ok", paidOk, (st) => s.step(`etapa ${st}`));
    const file = path.join(outDir, "reel-happy-1080x1920.mp4");
    fs.writeFileSync(file, dbOk.objects.get(`videos/${videoPath}`)!);
    decodeFully(file);
    const ev = probe(file);
    s.artifacts.push(ev);
    s.check("MP4 H.264 + AAC, 1080x1920", ev.ffprobe.video?.codec === "h264" && ev.ffprobe.video?.width === 1080 && ev.ffprobe.video?.height === 1920 && ev.ffprobe.audio?.[0]?.codec === "aac", ev.ffprobe);
    s.check("ledger de voz COMMITTED", ops(paidOk).some((o) => o.endsWith("COMMITTED")), ops(paidOk));
    const cap = readCaptures(captureDir)[capsBefore];
    s.check("props de render capturadas", Boolean(cap));
    if (!cap) return;
    const synth = eleven.history.slice(histBefore);
    const words = wordsFromAlignment(synth[synth.length - 1].alignment);
    const silences = cap.narrationFile ? audioSilences(cap.narrationFile) : [];
    const sub = analyzeSubtitles({ cues: cap.captions, words, audioDurationSeconds: cap.narrationFile ? mediaDuration(cap.narrationFile) : 0, videoDurationSeconds: ev.ffprobe.durationSeconds, silences });
    s.data.subtitles = sub;
    s.check("subtítulos: orden, límites, sin solapes, desfase y deriva dentro de tolerancia, sin texto en silencios", sub.issues.length === 0, sub.issues.slice(0, 10));
    s.check("se midieron silencios reales en el audio narrado", sub.metrics.silencesChecked > 0, sub.metrics.silencesChecked);
    const burned = verifyBurnedCaptions(file, cap, cap.dir);
    s.data.burnedCaptions = burned;
    s.check("subtítulos visibles en el MP4 (fotograma MP4 ≈ render con subtítulos, ≠ sin subtítulos)", burned.allBurned, burned.rows);
    s.data.render = { renderMs: cap.renderMs, fps: cap.fps, frames: cap.durationInFrames, scenes: cap.scenes.length, captions: cap.captions.length, profile: cap.profile };
    s.check("escenas contiguas que cubren el video", cap.scenes.every((sc, i) => i === 0 || Math.abs(sc.startSeconds - cap.scenes[i - 1].endSeconds) < 0.05), cap.scenes.map((x) => [x.startSeconds, x.endSeconds]));
    s.data.unit_economics = await reelEconomics({ scriptOutputChars: JSON.stringify(scriptOnce.script).length, voiceCharactersSent: eleven.chars - charsBefore, renderMs: cap.renderMs, musicTrack: Boolean(cap.musicFile), footageCount: cap.scenes.length });
  });

  await scenario("RE-02", "Reel: doble envío del mismo request tras completar — la voz no se vuelve a cobrar", async (s) => {
    const before = eleven.billablePosts();
    await render(dbOk, "sim-reel-ok", paidOk);
    s.check("0 POST nuevos a ElevenLabs (resultado reutilizado del ledger)", eleven.billablePosts() - before === 0, eleven.billablePosts() - before);
    s.data.note = "La puerta de render (render-guard + UPDATE condicional en la ruta) bloquea el doble render; ver BI-02 y test:saas.";
  });

  await scenario("RE-03", "Reel: ElevenLabs rechaza (HTTP 429) → el pipeline se detiene antes de footage/render, sin MP4", async (s) => {
    const db = newDb();
    const paid = { ledger: memoryLedgerStore(), results: memoryResultStore() };
    eleven.queue.push({ http: 429, body: { detail: "rate limited" } });
    const stages: string[] = [];
    let e: unknown;
    try { await render(db, "sim-reel-429", paid, (st) => stages.push(st)); } catch (err) { e = err; }
    s.check("falla", Boolean(e), e instanceof Error ? e.message.slice(0, 160) : e);
    s.check("no llega a footage ni render", !stages.includes("footage") && !stages.includes("render"), stages);
    s.check("sin MP4 en Storage", ![...db.objects.keys()].some((k) => k.endsWith("final.mp4")));
    s.check("ledger REFUNDED", ops(paid).some((o) => o.endsWith("REFUNDED")), ops(paid));
  });

  await scenario("RE-04", "Reel: corte de red en la voz (respuesta perdida) → RECONCILIATION_REQUIRED; reintento sin nuevo cobro", async (s) => {
    const db = newDb();
    const paid = { ledger: memoryLedgerStore(), results: memoryResultStore() };
    eleven.queue.push({ network: "reset" });
    const before = eleven.billablePosts();
    let e1: unknown;
    try { await render(db, "sim-reel-net", paid); } catch (err) { e1 = err; }
    let e2: unknown;
    try { await render(db, "sim-reel-net", paid); } catch (err) { e2 = err; }
    s.check("1º y 2º intento fallan", Boolean(e1) && Boolean(e2));
    s.check("ledger RECONCILIATION_REQUIRED", ops(paid).some((o) => o.endsWith("RECONCILIATION_REQUIRED")), ops(paid));
    s.check("1 solo POST (el reintento no reenvía)", eleven.billablePosts() - before === 1, eleven.billablePosts() - before);
  });

  await scenario("RE-05", "Reel: dos propietarios en paralelo — trabajos aislados por request y ruta", async (s) => {
    const db = newDb();
    const a = { ledger: memoryLedgerStore(), results: memoryResultStore() };
    const b = { ledger: memoryLedgerStore(), results: memoryResultStore() };
    const [ra, rb] = await Promise.all([render(db, "sim-owner-a/reel", a), render(db, "sim-owner-b/reel", b)]);
    s.check("rutas distintas", ra.videoPath !== rb.videoPath && ra.videoPath.startsWith("sim-owner-a/") && rb.videoPath.startsWith("sim-owner-b/"), [ra.videoPath, rb.videoPath]);
    for (const [name, vp] of [["a", ra.videoPath], ["b", rb.videoPath]] as const) {
      const f = path.join(outDir, `reel-concurrent-${name}.mp4`);
      fs.writeFileSync(f, db.objects.get(`videos/${vp}`)!);
      decodeFully(f);
      const ev = probe(f);
      s.artifacts.push(ev);
      s.check(`MP4 ${name} válido`, ev.ffprobe.video?.codec === "h264" && (ev.ffprobe.audio?.length ?? 0) > 0);
    }
    s.check("ledgers separados", a.ledger.ops.size > 0 && b.ledger.ops.size > 0 && [...a.ledger.ops.keys()].every((k) => !b.ledger.ops.has(k)));
  });

  server.close();
  current = null;
  return results;
}

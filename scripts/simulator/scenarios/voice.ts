/**
 * Escenarios ElevenLabs sobre el flujo REAL de síntesis:
 *  - ai/voice.ts synthesizeVoice (POST síncrono /with-timestamps, sin webhook)
 *  - paid-calls/gated-providers.ts gatedVoiceSynthesize (ledger + resultado guardado)
 *  - long-form/timeline.ts splitNarrationIntoSafeChunks / synthesizeBeatNarration (fragmentación ≤ 9000)
 *  - long-form/tts-cache.ts synthesizeBeatNarrationCached (STARTED/COMPLETED por beat)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { createFakeElevenLabs } from "../lib/fake-providers";
import { Scenario, type ScenarioResult } from "../lib/report";

export async function runVoiceScenarios(eleven: ReturnType<typeof createFakeElevenLabs>): Promise<ScenarioResult[]> {
  const { realVoiceProvider } = await import("../../../src/lib/providers/voice/real");
  const { gatedVoiceSynthesize } = await import("../../../src/lib/paid-calls/gated-providers");
  const { getVoiceIdentity } = await import("../../../src/lib/ai/voice");
  const { memoryLedgerStore } = await import("../../../src/lib/production-intelligence/ledger");
  const { memoryResultStore } = await import("../../../src/lib/paid-calls/result-store");
  const { splitNarrationIntoSafeChunks, synthesizeBeatNarration, MAX_TTS_CHARS_PER_CALL } = await import("../../../src/lib/video/long-form/timeline");
  const { synthesizeBeatNarrationCached, TtsUncertainCostStateError, computeTtsCacheKey } = await import("../../../src/lib/video/long-form/tts-cache");
  const results: ScenarioResult[] = [];
  const identity = getVoiceIdentity("es");
  const text = "Este es un texto sintético. Tiene pausas naturales, comas y finales de oración. Sirve para medir la sincronía.";

  async function scenario(id: string, title: string, body: (s: Scenario) => Promise<void>) {
    const s = new Scenario(id, "voice", title);
    const before = eleven.billablePosts();
    const charsBefore = eleven.chars;
    let error: unknown;
    try { await body(s); } catch (e) { error = e; }
    s.data.billedCharacters = eleven.chars - charsBefore;
    results.push(s.finish({ elevenlabs_tts_posts: eleven.billablePosts() - before }, error));
  }
  const deps = () => ({ ledger: memoryLedgerStore(), results: memoryResultStore(), requestId: `sim-voice-${Math.random().toString(36).slice(2, 8)}` });
  const opStatus = (d: ReturnType<typeof deps>) => [...d.ledger.ops.values()].map((o) => o.status);
  const call = (d: ReturnType<typeof deps>) => gatedVoiceSynthesize({ ...d, voiceProvider: realVoiceProvider, voiceIdentity: identity, estimatedCostUsd: (text.length / 1000) * 0.1 }, text, "es");

  await scenario("VO-EL-01", "ElevenLabs: síntesis con timestamps, ledger COMMITTED y reutilización sin nuevo cobro", async (s) => {
    const d = deps();
    const before = eleven.billablePosts();
    const a = await call(d);
    s.check("1 POST /with-timestamps", eleven.billablePosts() - before === 1);
    s.check("palabras con tiempos monótonos", a.words.every((w, i) => w.endSeconds > w.startSeconds && (i === 0 || w.startSeconds >= a.words[i - 1].endSeconds)), a.words.length);
    s.check("hay pausas naturales en las marcas (≥ 0.6 s tras punto)", a.words.some((w, i) => i > 0 && w.startSeconds - a.words[i - 1].endSeconds >= 0.6));
    s.check("ledger COMMITTED", opStatus(d).includes("COMMITTED"), opStatus(d));
    const b = await call(d);
    s.check("2ª llamada idéntica reutiliza el resultado (reused, $0, 0 POST)", b.reused && b.costUsd === 0 && eleven.billablePosts() - before === 1);
  });

  await scenario("VO-EL-02", "ElevenLabs: HTTP 429 (rechazo) → REFUNDED, sin reintento automático", async (s) => {
    const d = deps();
    eleven.queue.push({ http: 429, body: { detail: "rate limited" } });
    const before = eleven.billablePosts();
    let e1: unknown;
    try { await call(d); } catch (e) { e1 = e; }
    s.check("falla con ProviderRejectedError", e1 instanceof Error && e1.name === "ProviderRejectedError", e1 instanceof Error ? e1.message : e1);
    s.check("ledger REFUNDED", opStatus(d).includes("REFUNDED"), opStatus(d));
    s.check("1 POST (sin reintento en la misma llamada)", eleven.billablePosts() - before === 1);
    let e2: unknown;
    try { await call(d); } catch (e) { e2 = e; }
    s.data.secondCall = e2 instanceof Error ? `${e2.name}: ${e2.message.slice(0, 120)}` : "ok";
    s.check("una 2ª llamada no reenvía la petición rechazada (política COST-A2)", eleven.billablePosts() - before === 1, s.data.secondCall);
  });

  await scenario("VO-EL-03", "ElevenLabs: corte de red tras enviar (respuesta perdida) → RECONCILIATION_REQUIRED, nunca reenvía", async (s) => {
    const d = deps();
    eleven.queue.push({ network: "reset" });
    const before = eleven.billablePosts();
    let e1: unknown;
    try { await call(d); } catch (e) { e1 = e; }
    s.check("1er intento falla", Boolean(e1));
    s.check("ledger RECONCILIATION_REQUIRED", opStatus(d).includes("RECONCILIATION_REQUIRED"), opStatus(d));
    let e2: unknown;
    try { await call(d); } catch (e) { e2 = e; }
    s.check("2º intento rechazado sin llamar al proveedor", Boolean(e2) && eleven.billablePosts() - before === 1, e2 instanceof Error ? e2.message.slice(0, 160) : e2);
  });

  const long = Array.from({ length: 60 }, (_, i) => `Frase sintética número ${i + 1} del beat largo, con contenido de relleno para superar el límite de caracteres por petición, ${"y un poco más de texto descriptivo ".repeat(8)}hasta cerrar la oración.`).join(" ");
  await scenario("VO-EL-04", "ElevenLabs: fragmentación de un beat largo (≤ 9000 caracteres por petición) y unión de marcas", async (s) => {
    const chunks = splitNarrationIntoSafeChunks(long);
    s.data.chunks = chunks.map((c) => c.length);
    s.check(`texto de ${long.length} caracteres partido en ≥ 2 trozos ≤ ${MAX_TTS_CHARS_PER_CALL}`, chunks.length >= 2 && chunks.every((c) => c.length <= MAX_TTS_CHARS_PER_CALL));
    s.check("unir los trozos reproduce el texto", chunks.join(" ").replace(/\s+/g, " ") === long.replace(/\s+/g, " "));
    const before = eleven.billablePosts();
    const r = await synthesizeBeatNarration(realVoiceProvider, { id: "sim-beat-long", narration: long }, "es");
    s.check("1 POST por trozo", eleven.billablePosts() - before === chunks.length, eleven.billablePosts() - before);
    s.check("marcas unidas monótonas y re-desplazadas", r.words.every((w, i) => i === 0 || w.startSeconds >= r.words[i - 1].endSeconds - 1e-9));
    s.check("nº de palabras = palabras del texto", r.words.length === long.split(/\s+/).filter(Boolean).length, r.words.length);
    s.check("duración = suma de duraciones de los trozos", Math.abs(r.durationSeconds - r.words[r.words.length - 1].endSeconds) < 1);
  });

  await scenario("VO-EL-05", "ElevenLabs: fallo en el trozo 2 (respuesta perdida) → caché STARTED bloquea reintento; reconciliación manual", async (s) => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomivid-sim-ttscache-"));
    const ctx = { videoId: "sim-lf", cacheDir, voiceIdentity: identity };
    const beat = { id: "sim-beat-long", narration: long };
    const chunks = splitNarrationIntoSafeChunks(long).length;
    eleven.queue.push("ok", { network: "reset" });
    const before = eleven.billablePosts();
    let e1: unknown;
    try { await synthesizeBeatNarrationCached(realVoiceProvider, beat, "es", ctx); } catch (e) { e1 = e; }
    s.check("falla en el trozo 2", Boolean(e1) && eleven.billablePosts() - before === 2, eleven.billablePosts() - before);
    let e2: unknown;
    try { await synthesizeBeatNarrationCached(realVoiceProvider, beat, "es", ctx); } catch (e) { e2 = e; }
    s.check("reintento → TtsUncertainCostStateError sin llamar al proveedor", e2 instanceof TtsUncertainCostStateError && eleven.billablePosts() - before === 2);
    // Reconciliación manual documentada por el propio error: borrar el registro STARTED.
    const key = computeTtsCacheKey({ videoId: "sim-lf", beatId: beat.id, text: long, voiceId: identity.voiceId, modelId: identity.modelId, voiceSettingsJson: identity.voiceSettingsJson, language: "es", providerName: realVoiceProvider.name });
    for (const f of fs.readdirSync(cacheDir)) if (f.includes(key) && f.endsWith(".json")) fs.rmSync(path.join(cacheDir, f));
    const r = await synthesizeBeatNarrationCached(realVoiceProvider, beat, "es", ctx);
    const total = eleven.billablePosts() - before;
    s.data.postsTotal = total;
    s.data.finding = `Tras reconciliar, el beat se vuelve a sintetizar completo: ${chunks} POST nuevos; el trozo 1 ya aceptado se cobra dos veces (caché por beat, no por trozo).`;
    s.check("recupera el beat tras la reconciliación manual", !r.reused && r.words.length > 0);
    const r2 = await synthesizeBeatNarrationCached(realVoiceProvider, beat, "es", ctx);
    s.check("después queda COMPLETED: siguiente ejecución reutiliza (0 POST)", r2.reused && eleven.billablePosts() - before === total);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  return results;
}

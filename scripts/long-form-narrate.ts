/**
 * Narración de un documental PREPARADO (guion en content/long-form/<id>/) en la
 * caché durable de producción (production-tts-cache.ts), beat por beat, con una
 * voz explícita. Es el único paso que sintetiza: la muestra y el episodio
 * (scripts/long-form-quality-sample.ts) solo LEEN esa caché, así que un beat
 * narrado para el primer minuto se reutiliza en el episodio completo sin
 * volver a pagarse (misma clave: videoId + beat + texto + voz + modelo).
 *
 * El gasto se reserva en el MISMO registro que la muestra
 * (`<NARRATE_LEDGER_PREFIX>/state/paid-ledger.json`): voz, imágenes y clips
 * comparten un único tope acumulado del episodio.
 *
 * MODE=plan (por defecto): no sintetiza. Estado de la caché por beat,
 *   caracteres, costo estimado, saldo de la cuenta (GET de solo lectura, si hay
 *   clave) y lo ya comprometido en el registro.
 * MODE=run: exige NARRATE_ALLOW_PAID=true y NARRATE_BUDGET_USD (tope aprobado
 *   acumulado). Antes de gastar: saldo suficiente (más la reserva de la cuenta)
 *   y ninguna narración en estado incierto. Sin reintentos automáticos: un
 *   fallo se registra (cuenta en el tope) y detiene la ejecución.
 *
 * Variables: NARRATE_SCRIPT, NARRATE_BEATS ("all" o "b1,b2"), NARRATE_VIDEO_ID,
 * NARRATE_LEDGER_PREFIX, NARRATE_VOICE_ID, NARRATE_CHAR_RESERVE (3000),
 * NARRATE_USD_PER_1K (0.30, reserva conservadora por 1.000 caracteres).
 */
export {};

import { assertEpisodeBudget } from "../src/lib/video/long-form/episode-spend-policy";

async function main() {
  const fs = await import("node:fs/promises");
  const mode = (process.env.MODE ?? "plan").trim();
  const scriptPath = required("NARRATE_SCRIPT");
  const videoId = required("NARRATE_VIDEO_ID");
  const ledgerPrefix = required("NARRATE_LEDGER_PREFIX");
  const voiceId = required("NARRATE_VOICE_ID");
  if (!ledgerPrefix.startsWith(`${videoId}/samples/`)) throw new Error("NARRATE_LEDGER_PREFIX debe ser el outputPrefix del manifiesto (<videoId>/samples/...)");
  const script = JSON.parse(await fs.readFile(scriptPath, "utf8")) as { meta: { language?: string }; beats: { id: string; narration: string }[] };
  const language: "es" | "en" = script.meta.language === "en" ? "en" : "es";
  const wanted = (process.env.NARRATE_BEATS ?? "all").trim();
  const beats = wanted === "all" ? script.beats : wanted.split(",").map((id) => {
    const beat = script.beats.find((b) => b.id === id.trim());
    if (!beat) throw new Error(`beat desconocido: ${id}`);
    return beat;
  });
  const charReserve = Number(process.env.NARRATE_CHAR_RESERVE ?? "3000");

  // La voz del proveedor sale de ELEVENLABS_VOICE_ID_<LANG>: se fija ANTES de cargar el módulo de voz.
  process.env[language === "en" ? "ELEVENLABS_VOICE_ID_EN" : "ELEVENLABS_VOICE_ID_ES"] = voiceId;
  const { getVoiceIdentity } = await import("../src/lib/ai/voice");
  const identity = getVoiceIdentity(language, voiceId);
  if (getVoiceIdentity(language).voiceId !== voiceId) throw new Error("la voz del proveedor no coincide con NARRATE_VOICE_ID — no se narra con otra voz");

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { readProductionTtsCacheRecord, synthesizeBeatNarrationProductionCached } = await import("../src/lib/video/long-form/production-tts-cache");
  const { computeTtsCacheKey } = await import("../src/lib/video/long-form/tts-cache");
  const { committedUsd, reservePaid, settlePaid } = await import("../src/lib/video/long-form/sample-manifest");
  type PaidLedger = import("../src/lib/video/long-form/sample-manifest").PaidLedger;
  const service = createServiceClient();
  const bucket = "videos";
  // Reserva conservadora por 1.000 caracteres (la misma tarifa por defecto que
  // long-form/cost.ts). En Starter el costo real sale de la cuota ya pagada,
  // pero el tope se cuenta con esta tarifa para no subestimar.
  const rate = Number(process.env.NARRATE_USD_PER_1K ?? "0.3");
  if (!(rate > 0)) throw new Error("NARRATE_USD_PER_1K inválido");

  const rows = [];
  for (const beat of beats) {
    const key = computeTtsCacheKey({ videoId, beatId: beat.id, text: beat.narration, voiceId: identity.voiceId, modelId: identity.modelId, voiceSettingsJson: identity.voiceSettingsJson, language, providerName: "elevenlabs" });
    const record = await readProductionTtsCacheRecord(service, bucket, videoId, key);
    rows.push({ beat, key, status: record?.status ?? "missing", characters: beat.narration.length, estimateUsd: +((beat.narration.length / 1000) * rate).toFixed(4) });
  }
  const pending = rows.filter((r) => r.status !== "COMPLETED");
  const neededChars = pending.reduce((a, r) => a + r.characters, 0);

  const ledgerPath = `${ledgerPrefix}/state/paid-ledger.json`;
  const { data: ledgerBlob } = await service.storage.from(bucket).download(ledgerPath);
  let ledger: PaidLedger = ledgerBlob ? (JSON.parse(await ledgerBlob.text()) as PaidLedger) : { entries: [] };
  const saveLedger = async () => {
    const { error } = await service.storage.from(bucket).upload(ledgerPath, Buffer.from(JSON.stringify(ledger, null, 2)), { contentType: "application/json", upsert: true });
    if (error) throw new Error(`no se pudo guardar el registro de gasto: ${error.message}`);
  };

  // Saldo de la cuenta: solo lectura (GET), no consume caracteres.
  let balance: { used: number; limit: number; remaining: number } | null = null;
  if (process.env.ELEVENLABS_API_KEY?.trim()) {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY.trim() } });
    if (res.ok) {
      const sub = (await res.json()) as { character_count: number; character_limit: number };
      balance = { used: sub.character_count, limit: sub.character_limit, remaining: sub.character_limit - sub.character_count };
    }
  }
  console.log(`@@NARRATE_PLAN ${JSON.stringify({ mode, videoId, language, voiceId, modelId: identity.modelId, beats: rows.map((r) => ({ id: r.beat.id, status: r.status, characters: r.characters, estimateUsd: r.estimateUsd })), neededChars, estimateUsd: +pending.reduce((a, r) => a + r.estimateUsd, 0).toFixed(4), balance, charReserve, committedUsd: committedUsd(ledger) })}`);
  if (mode !== "run") {
    console.log("Modo plan: no se sintetizó nada.");
    return;
  }

  if (process.env.NARRATE_ALLOW_PAID !== "true") throw new Error("MODE=run exige NARRATE_ALLOW_PAID=true (autorización explícita de gasto)");
  const budgetUsd = Number(process.env.NARRATE_BUDGET_USD ?? "0");
  assertEpisodeBudget(budgetUsd, videoId, ledgerPrefix, "narration");
  const uncertain = rows.filter((r) => r.status === "STARTED");
  if (uncertain.length > 0) throw new Error(`narración en estado incierto (${uncertain.map((r) => r.beat.id).join(", ")}): revisar antes de gastar; no se repite`);
  if (!balance) throw new Error("no se pudo leer el saldo de ElevenLabs: no se gasta sin comprobarlo");
  if (balance.remaining - neededChars < charReserve) {
    throw new Error(`saldo insuficiente: quedan ${balance.remaining} caracteres, se necesitan ${neededChars} + reserva ${charReserve}`);
  }

  process.env.VOICE_PROVIDER = "elevenlabs";
  const { getVoiceProvider } = await import("../src/lib/providers/voice");
  const voiceProvider = getVoiceProvider();
  if (voiceProvider.name !== "elevenlabs") throw new Error("proveedor de voz real no disponible");

  for (const row of pending) {
    const ledgerKey = `tts:${videoId}:${row.beat.id}:${row.key.slice(0, 16)}`;
    ledger = reservePaid(ledger, { key: ledgerKey, sceneId: row.beat.id, provider: "elevenlabs-tts", estimateUsd: row.estimateUsd, prompt: `${row.characters} caracteres` }, budgetUsd, new Date().toISOString());
    await saveLedger(); // write-ahead
    try {
      const result = await synthesizeBeatNarrationProductionCached(service, voiceProvider, row.beat, language, { videoId, voiceIdentity: identity });
      ledger = settlePaid(ledger, ledgerKey, { status: "spent", actualUsd: result.reused ? 0 : row.estimateUsd }, new Date().toISOString());
      await saveLedger();
      console.log(`@@NARRATED ${JSON.stringify({ beat: row.beat.id, reused: result.reused, seconds: +result.durationSeconds.toFixed(3), words: result.words.length, costUsd: result.reused ? 0 : row.estimateUsd })}`);
    } catch (err) {
      // Pudo cobrarse (el registro STARTED ya existe): cuenta en el tope y no se reintenta automáticamente.
      ledger = settlePaid(ledger, ledgerKey, { status: "failed", note: err instanceof Error ? err.message.slice(0, 200) : "error" }, new Date().toISOString());
      await saveLedger();
      throw err;
    }
  }
  console.log(`@@NARRATE_DONE ${JSON.stringify({ committedUsd: committedUsd(ledger), budgetUsd })}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} requerido`);
  return value;
}

main().catch((err) => {
  console.error("Narración detenida:", err instanceof Error ? err.message : err);
  process.exit(1);
});

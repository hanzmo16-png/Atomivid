/**
 * Revisión de Work (PR #13): gasto durable, imágenes sin regeneración
 * incierta y voz reutilizable. Todo con proveedores simulados y Storage en
 * memoria con fallos inyectados — cero red, cero gasto.
 */
process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { GenerativeProviderError, type ImageProvider, type VoiceProvider } from "@/lib/providers/types";
import {
  LedgerWriteError,
  PaidBudgetExceededError,
  PaidLedger,
  UncertainPaidOperationError,
  memoryLedgerStore,
  type PaidOperation,
} from "./paid-ledger";
import { IMAGE_RESERVE_USD, openStorageLedger, voiceCostUsd } from "./paid-costs";
import { StorageStateUnknownError } from "./storage-state";
import { memoryStorage } from "./test-storage";
import { GeneratedImageUncertainError, generatedImageMarkerPath, resolveGeneratedImageForScene } from "../visual-resource-resolver";
import { VoiceCacheUncertainError, synthesizeNarrationCached } from "./voice-cache";

const op = (key: string, reserveUsd = 0.1): PaidOperation => ({ key, kind: "image", provider: "fake", reserveUsd, units: { images: 1 } });
const ok = (actualUsd: number) => async () => ({ value: "ok", settle: { actualUsd, costBasis: "provider_usage" as const } });
const uncertain = () => "uncertain" as const;

// ---------- Registro de gasto ----------

test("gasto: la reserva queda guardada ANTES de llamar al proveedor; si no se puede guardar, no se llama", async () => {
  const store = memoryLedgerStore();
  const ledger = await PaidLedger.open(store, { scope: "r" });
  let statusSeenDuringCall = "";
  await ledger.run(op("a"), async () => {
    statusSeenDuringCall = (await store.load())!.entries[0].status;
    return { value: 1, settle: { actualUsd: 0.05, costBasis: "provider_usage" } };
  }, uncertain);
  assert.equal(statusSeenDuringCall, "reserved");

  store.failNextSave = true;
  let called = false;
  await assert.rejects(ledger.run(op("b"), async () => ((called = true), { value: 1, settle: { costBasis: "estimated" } }), uncertain), LedgerWriteError);
  assert.equal(called, false);
});

test("gasto: se conserva entre intentos (registro por solicitud) y el tope se aplica al acumulado, sin ampliarse", async () => {
  const store = memoryLedgerStore();
  const first = await PaidLedger.open(store, { scope: "r", capUsd: 0.75 });
  await first.run(op("img-1", 0.07), ok(0.056), uncertain);
  // Intento 1 falla después (p. ej. el render): el gasto sigue en el registro.
  const second = await PaidLedger.open(store, { scope: "r", capUsd: 5 });
  assert.equal(second.summary().committedUsd, 0.056);
  assert.equal(second.snapshot().capUsd, 0.75, "un reintento nunca amplía el tope");
  const small = await PaidLedger.open(memoryLedgerStore(), { scope: "s", capUsd: 0.75, otherCommittedUsd: 0.7 });
  let called = false;
  await assert.rejects(small.run(op("x", 0.07), async () => ((called = true), { value: 1, settle: { costBasis: "estimated" } }), uncertain), PaidBudgetExceededError);
  assert.equal(called, false, "tope global (otras muestras) respetado antes de llamar");
});

test("gasto: fallo con costo incierto cuenta por la reserva y bloquea repetir; reconocerlo permite reintentar y ambos cuentan", async () => {
  const store = memoryLedgerStore();
  const ledger = await PaidLedger.open(store, { scope: "r" });
  await assert.rejects(ledger.run(op("v", 0.1), async () => { throw new Error("timeout"); }, uncertain));
  assert.equal(ledger.summary().uncertainUsd, 0.1);
  assert.deepEqual(ledger.summary().openUncertainKeys, ["v"]);
  await assert.rejects(ledger.run(op("v", 0.1), ok(0.05), uncertain), UncertainPaidOperationError);
  assert.equal(await ledger.acknowledge("v", "revisado: se cobró"), true);
  await ledger.run(op("v", 0.1), ok(0.05), uncertain);
  assert.equal(ledger.summary().committedUsd, 0.15);
});

test("gasto: un fallo con costo cero conocido se libera (no cuenta) y puede repetirse", async () => {
  const ledger = await PaidLedger.open(memoryLedgerStore(), { scope: "r" });
  await assert.rejects(ledger.run(op("i"), async () => { throw new Error("HTTP 500"); }, () => "not_sent"));
  assert.equal(ledger.summary().committedUsd, 0);
  await ledger.run(op("i"), ok(0.05), uncertain);
  assert.equal(ledger.summary().committedUsd, 0.05);
});

// ---------- Imágenes ----------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 4, 0, 0, 0, 6, 0]), Buffer.alloc(200, 0x20)]);

function fakeImages(behaviors: Array<"ok" | "timeout" | "http" | "broken">) {
  let calls = 0;
  const provider: ImageProvider = {
    name: "fake-openai",
    capabilities: { id: "fake", models: ["m"], formats: ["image/png"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      const b = behaviors[Math.min(calls, behaviors.length - 1)];
      calls += 1;
      if (b === "timeout") throw new GenerativeProviderError("timeout", "fake", "timeout");
      if (b === "http") throw new GenerativeProviderError("HTTP 500", "fake", "upstream_error");
      if (b === "broken") throw new Error("socket hang up");
      return { buffer: PNG, mimeType: "image/png", extension: "png", model: "m", costUsd: 0.0558, costBasis: "provider_usage" };
    },
  };
  return { provider, calls: () => calls };
}

const resolve = (client: ReturnType<typeof memoryStorage>["client"], provider: ImageProvider, ledger?: PaidLedger) =>
  resolveGeneratedImageForScene({
    supabase: client,
    bucket: "videos",
    requestId: "req",
    sceneIndex: 0,
    scene: { imagePrompt: "p", negativePrompt: "n" },
    imageProvider: provider,
    remainingBudgetUsd: 1,
    signedUrlTtlSeconds: 60,
    objectPrefix: "scene-0-styled-abc",
    ledger,
  });

test("imágenes: un error de Storage.list NO se interpreta como «no existe»: se detiene sin llamar al proveedor", async () => {
  const s = memoryStorage({ list: [/^req$/] });
  const img = fakeImages(["ok"]);
  const ledger = await PaidLedger.open(memoryLedgerStore(), { scope: "req" });
  await assert.rejects(resolve(s.client, img.provider, ledger), StorageStateUnknownError);
  assert.equal(img.calls(), 0);
  assert.equal(ledger.snapshot().entries.length, 0);
});

test("imágenes: si no se puede leer el marcador del intento anterior, se detiene sin llamar", async () => {
  const s = memoryStorage({ download: [/state\/generated/] });
  const img = fakeImages(["ok"]);
  await assert.rejects(resolve(s.client, img.provider), StorageStateUnknownError);
  assert.equal(img.calls(), 0);
});

test("imágenes: generación cobrada + subida fallida → queda contada, marcada y NO se regenera en el reintento", async () => {
  const s = memoryStorage({ upload: [{ match: /scene-0-styled-abc\.png$/, times: Infinity }] });
  const img = fakeImages(["ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(resolve(s.client, img.provider, ledger), /cobrada\) no se pudo guardar/);
  assert.equal(s.json<{ status: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.status, "generated_unstored");
  assert.equal(ledger.summary().committedUsd, 0.0558);

  const retryLedger = await openStorageLedger(s.client, "videos", "req"); // otro intento, mismo registro durable
  await assert.rejects(resolve(s.client, img.provider, retryLedger), GeneratedImageUncertainError);
  assert.equal(img.calls(), 1, "nunca se paga dos veces");
  assert.equal(retryLedger.summary().committedUsd, 0.0558);
});

test("imágenes: timeout (pudo cobrarse) → incierto, contado por la reserva y sin regeneración automática", async () => {
  const s = memoryStorage();
  const img = fakeImages(["timeout", "ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(resolve(s.client, img.provider, ledger), /timeout/);
  assert.equal(ledger.summary().uncertainUsd, IMAGE_RESERVE_USD);
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req")), GeneratedImageUncertainError);
  assert.equal(img.calls(), 1);
});

test("imágenes: error HTTP (costo cero conocido) → se libera y el reintento sí genera", async () => {
  const s = memoryStorage();
  const img = fakeImages(["http", "ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(resolve(s.client, img.provider, ledger), /HTTP 500/);
  assert.equal(ledger.summary().committedUsd, 0);
  const out = await resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req"));
  assert.equal(out.status, "generated");
  assert.equal(img.calls(), 2);
});

test("imágenes: subida con un fallo transitorio se reintenta; un reintento posterior reutiliza sin pagar", async () => {
  const s = memoryStorage({ upload: [{ match: /scene-0-styled-abc\.png$/, times: 1 }] });
  const img = fakeImages(["ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req");
  assert.equal((await resolve(s.client, img.provider, ledger)).status, "generated");
  assert.equal((await resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req"))).status, "reused");
  assert.equal(img.calls(), 1);
  assert.equal(s.json<{ status: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.status, "stored");
});

// ---------- Voz ----------

function fakeVoice(behaviors: Array<"ok" | "http" | "network"> = ["ok"]) {
  let calls = 0;
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text, _lang, speed = 1) {
      const b = behaviors[Math.min(calls, behaviors.length - 1)];
      calls += 1;
      if (b === "http") throw new Error("ElevenLabs respondió 500: error");
      if (b === "network") throw new Error("fetch failed");
      const words = text.split(" ").map((w, i) => ({ text: w, startSeconds: i / (2.5 * speed), endSeconds: (i + 0.8) / (2.5 * speed) }));
      return { audioBuffer: Buffer.from(`audio:${speed}:${text}`), durationSeconds: words.at(-1)!.endSeconds, words, mimeType: "audio/mpeg", extension: "mp3" };
    },
  };
  return { provider, calls: () => calls };
}

const TEXT = "Nadie sabe qué pasó aquella noche en el faro abandonado.";
const narrate = (s: ReturnType<typeof memoryStorage>, provider: VoiceProvider, ledger: PaidLedger, speed?: number) =>
  synthesizeNarrationCached({ supabase: s.client, bucket: "videos", requestId: "req", voiceProvider: provider, text: TEXT, language: "es", speed, ledger });

test("voz: con el mismo texto, voz, idioma y velocidad, el reintento reutiliza audio y tiempos sin volver a pagar", async () => {
  const s = memoryStorage();
  const v = fakeVoice();
  const first = await narrate(s, v.provider, await openStorageLedger(s.client, "videos", "req"));
  const retryLedger = await openStorageLedger(s.client, "videos", "req");
  const again = await narrate(s, v.provider, retryLedger);
  assert.equal(v.calls(), 1);
  assert.equal(again.reused, true);
  assert.deepEqual(again.words, first.words);
  assert.equal(Buffer.compare(again.audioBuffer, first.audioBuffer), 0);
  assert.equal(retryLedger.snapshot().entries.length, 1);
});

test("voz: la corrección de duración es otra operación («voice_retime») y ambas se contabilizan", async () => {
  const s = memoryStorage();
  const v = fakeVoice();
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await narrate(s, v.provider, ledger);
  await narrate(s, v.provider, ledger, 0.92);
  const byKind = ledger.summary().byKind;
  assert.equal(byKind.voice.characters, TEXT.length);
  assert.equal(byKind.voice_retime.characters, TEXT.length);
  assert.ok(Math.abs(ledger.summary().committedUsd - 2 * voiceCostUsd(TEXT.length)) < 1e-9);
  // Otro intento: ambas se reutilizan.
  const retry = await openStorageLedger(s.client, "videos", "req");
  await narrate(s, v.provider, retry);
  await narrate(s, v.provider, retry, 0.92);
  assert.equal(v.calls(), 2);
});

test("voz: cobrada y no guardada → contada y sin resíntesis automática", async () => {
  const s = memoryStorage({ upload: [{ match: /voice-cache\//, times: Infinity }] });
  const v = fakeVoice();
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(narrate(s, v.provider, ledger), /no se pudo guardar/);
  assert.ok(ledger.summary().committedUsd > 0);
  await assert.rejects(narrate(s, v.provider, await openStorageLedger(s.client, "videos", "req")), VoiceCacheUncertainError);
  assert.equal(v.calls(), 1);
});

test("voz: error HTTP (costo cero) permite reintentar; error de red (incierto) detiene el reintento", async () => {
  const s1 = memoryStorage();
  const http = fakeVoice(["http", "ok"]);
  await assert.rejects(narrate(s1, http.provider, await openStorageLedger(s1.client, "videos", "req")), /respondió 500/);
  assert.equal((await narrate(s1, http.provider, await openStorageLedger(s1.client, "videos", "req"))).reused, false);
  assert.equal(http.calls(), 2);

  const s2 = memoryStorage();
  const net = fakeVoice(["network", "ok"]);
  await assert.rejects(narrate(s2, net.provider, await openStorageLedger(s2.client, "videos", "req")), /fetch failed/);
  await assert.rejects(narrate(s2, net.provider, await openStorageLedger(s2.client, "videos", "req")), VoiceCacheUncertainError);
  assert.equal(net.calls(), 1);
});

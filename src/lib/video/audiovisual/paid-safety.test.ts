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

function fakeImages(behaviors: Array<"ok" | "timeout" | "http" | "http500" | "broken">) {
  let calls = 0;
  const provider: ImageProvider = {
    name: "fake-openai",
    capabilities: { id: "fake", models: ["m"], formats: ["image/png"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
    isAvailable: () => true,
    async generateImage() {
      const b = behaviors[Math.min(calls, behaviors.length - 1)];
      calls += 1;
      if (b === "timeout") throw new GenerativeProviderError("timeout", "fake", "timeout");
      if (b === "http") throw new GenerativeProviderError("HTTP 400", "fake", "upstream_error", undefined, undefined, "rejected");
      if (b === "http500") throw new GenerativeProviderError("HTTP 500", "fake", "upstream_error", undefined, undefined, "uncertain");
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

test("imágenes: rechazo HTTP explícito (400, costo cero conocido) → se libera y el reintento sí genera", async () => {
  const s = memoryStorage();
  const img = fakeImages(["http", "ok"]);
  const ledger = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(resolve(s.client, img.provider, ledger), /HTTP 400/);
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

function fakeVoice(behaviors: Array<"ok" | "http" | "http500" | "network"> = ["ok"]) {
  let calls = 0;
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text, _lang, speed = 1) {
      const b = behaviors[Math.min(calls, behaviors.length - 1)];
      calls += 1;
      if (b === "http") throw new Error("ElevenLabs respondió 422: texto inválido");
      if (b === "http500") throw new Error("ElevenLabs respondió 500: error");
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

test("voz: rechazo HTTP explícito (costo cero) permite reintentar; error de red (incierto) detiene el reintento", async () => {
  const s1 = memoryStorage();
  const http = fakeVoice(["http", "ok"]);
  await assert.rejects(narrate(s1, http.provider, await openStorageLedger(s1.client, "videos", "req")), /respondió 422/);
  assert.equal((await narrate(s1, http.provider, await openStorageLedger(s1.client, "videos", "req"))).reused, false);
  assert.equal(http.calls(), 2);

  const s2 = memoryStorage();
  const net = fakeVoice(["network", "ok"]);
  await assert.rejects(narrate(s2, net.provider, await openStorageLedger(s2.client, "videos", "req")), /fetch failed/);
  await assert.rejects(narrate(s2, net.provider, await openStorageLedger(s2.client, "videos", "req")), VoiceCacheUncertainError);
  assert.equal(net.calls(), 1);
});

// ---------- Fallos de red y cobro incierto (segunda revisión de Work) ----------

const netError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

async function withStubbedFetch<T>(handler: () => Promise<Response>, fn: (calls: () => number) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return handler();
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test-sin-red";
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
}

test("red: OpenAI pierde la conexión con la solicitud en vuelo → una sola llamada, reserva conservada y reintento bloqueado", async () => {
  const { openaiImageProvider } = await import("@/lib/providers/image/openai");
  await withStubbedFetch(async () => { throw netError("ECONNRESET"); }, async (calls) => {
    const s = memoryStorage();
    const ledger = await openStorageLedger(s.client, "videos", "req");
    await assert.rejects(resolve(s.client, openaiImageProvider, ledger), (err: unknown) => err instanceof GenerativeProviderError && err.chargeOutcome === "uncertain");
    assert.equal(calls(), 1, "ni el proveedor ni el registro repiten una llamada que pudo cobrarse");
    const entry = ledger.snapshot().entries.at(-1)!;
    assert.equal(entry.status, "uncertain");
    assert.equal(ledger.summary().committedUsd, IMAGE_RESERVE_USD, "la reserva queda comprometida");
    assert.equal(s.json<{ status: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.status, "started");

    await assert.rejects(resolve(s.client, openaiImageProvider, await openStorageLedger(s.client, "videos", "req")), GeneratedImageUncertainError);
    assert.equal(calls(), 1, "el siguiente intento se detiene antes de llamar");
  });
});

test("red: HTTP 500 de OpenAI no prueba costo cero → incierto, sin reintento interno", async () => {
  const { openaiImageProvider } = await import("@/lib/providers/image/openai");
  await withStubbedFetch(async () => new Response(null, { status: 500 }), async (calls) => {
    const s = memoryStorage();
    const ledger = await openStorageLedger(s.client, "videos", "req");
    await assert.rejects(resolve(s.client, openaiImageProvider, ledger), /HTTP 500/);
    assert.equal(calls(), 1);
    assert.equal(ledger.summary().uncertainUsd, IMAGE_RESERVE_USD);
  });
});

test("red: conexión rechazada (inequívocamente antes del envío) → se libera; el proveedor puede repetir y el siguiente intento también", async () => {
  const { openaiImageProvider } = await import("@/lib/providers/image/openai");
  let refuse = true;
  await withStubbedFetch(async () => {
    if (refuse) throw netError("ECONNREFUSED");
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  }, async (calls) => {
    const s = memoryStorage();
    const ledger = await openStorageLedger(s.client, "videos", "req");
    await assert.rejects(resolve(s.client, openaiImageProvider, ledger), (err: unknown) => err instanceof GenerativeProviderError && err.chargeOutcome === "not_sent");
    assert.equal(calls(), 2, "OPENAI_IMAGE_MAX_RETRIES=1 por defecto: solo se repite lo que no salió");
    assert.equal(ledger.summary().committedUsd, 0);
    assert.equal(s.json<{ status: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.status, "released");
    refuse = false;
    assert.equal((await resolve(s.client, openaiImageProvider, await openStorageLedger(s.client, "videos", "req"))).status, "generated");
  });
});

test("red: clasificación de voz — 500 incierto, 429 rechazo, conexión cortada incierta, DNS antes del envío", async () => {
  const { classifyVoiceFailure } = await import("./paid-costs");
  assert.equal(classifyVoiceFailure(new Error("ElevenLabs respondió 500: x")), "uncertain");
  assert.equal(classifyVoiceFailure(new Error("ElevenLabs respondió 408: x")), "uncertain");
  assert.equal(classifyVoiceFailure(new Error("ElevenLabs respondió 429: x")), "not_sent");
  assert.equal(classifyVoiceFailure(netError("ECONNRESET")), "uncertain");
  assert.equal(classifyVoiceFailure(netError("UND_ERR_SOCKET")), "uncertain");
  assert.equal(classifyVoiceFailure(netError("ENOTFOUND")), "not_sent");
  assert.equal(classifyVoiceFailure(new Error("fetch failed")), "uncertain");
});

test("red: fetchFailureOutcome exige que TODOS los destinos fallen antes del envío", async () => {
  const { fetchFailureOutcome, httpStatusOutcome } = await import("@/lib/providers/charge-outcome");
  const refused = () => Object.assign(new Error("x"), { code: "ECONNREFUSED" });
  const reset = Object.assign(new Error("y"), { code: "ECONNRESET" });
  assert.equal(fetchFailureOutcome(new TypeError("fetch failed", { cause: new AggregateError([refused(), refused()]) })), "not_sent");
  assert.equal(fetchFailureOutcome(new TypeError("fetch failed", { cause: new AggregateError([refused(), reset]) })), "uncertain");
  assert.equal(fetchFailureOutcome(new Error("sin código")), "uncertain");
  assert.deepEqual([400, 401, 429, 500, 502, 408, 409].map(httpStatusOutcome), ["rejected", "rejected", "rejected", "uncertain", "uncertain", "uncertain", "uncertain"]);
});

// ---------- Recuperación manual coherente (registro + marcador/caché) ----------

test("recuperación de imagen: incierto → bloqueado → reconocimiento explícito → reintento permitido, con ambos intentos contados", async () => {
  const { recoverPaidOperation } = await import("./recovery");
  const s = memoryStorage();
  const img = fakeImages(["timeout", "ok"]);
  const key = "image:req/scene-0-styled-abc";
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 })), /timeout/);

  // Bloqueado en el siguiente intento.
  const blocked = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  await assert.rejects(resolve(s.client, img.provider, blocked), GeneratedImageUncertainError);
  assert.equal(img.calls(), 1);

  const operator = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  const result = await recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: operator, key, note: "revisado en el panel de OpenAI: sin imagen utilizable" });
  assert.deepEqual(result.released, { path: generatedImageMarkerPath("req", "scene-0-styled-abc"), previousStatus: "started" });
  assert.equal(result.acknowledged, true);
  assert.equal(s.json<{ status: string; previousStatus: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.previousStatus, "started");

  const retry = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  assert.equal((await resolve(s.client, img.provider, retry)).status, "generated");
  assert.equal(img.calls(), 2);
  const entries = retry.snapshot().entries.filter((e) => e.key === key);
  assert.deepEqual(entries.map((e) => [e.status, Boolean(e.acknowledgedAtIso)]), [["uncertain", true], ["spent", false]]);
  assert.ok(Math.abs(retry.summary().committedUsd - (IMAGE_RESERVE_USD + 0.0558)) < 1e-9, "el intento incierto sigue contando junto al nuevo");
});

test("recuperación de voz: incierto → bloqueado → reconocimiento explícito → reintento permitido, con ambos intentos contados", async () => {
  const { recoverPaidOperation } = await import("./recovery");
  const { voiceReserveUsd } = await import("./paid-costs");
  const s = memoryStorage();
  let calls = 0;
  const provider: VoiceProvider = {
    name: "elevenlabs",
    async synthesize(text) {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      return fakeVoice().provider.synthesize(text, "es");
    },
  };
  await assert.rejects(narrate(s, provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 })), /fetch failed/);
  await assert.rejects(narrate(s, provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 })), VoiceCacheUncertainError);
  assert.equal(calls, 1);

  const operator = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  const key = operator.summary().openUncertainKeys[0];
  assert.match(key, /^voice:req\//);
  const result = await recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: operator, key, note: "ElevenLabs: sin cargo en el historial" });
  assert.equal(result.released?.previousStatus, "started");

  const retry = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  const out = await narrate(s, provider, retry);
  assert.equal(out.reused, false);
  assert.equal(calls, 2);
  assert.ok(Math.abs(retry.summary().committedUsd - (voiceReserveUsd(TEXT.length) + voiceCostUsd(TEXT.length))) < 1e-9);
  assert.equal(retry.summary().byKind.voice.count, 2);
  // Y a partir de aquí el audio guardado se reutiliza.
  assert.equal((await narrate(s, provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 }))).reused, true);
});

test("recuperación: sin presupuesto para otro intento se rechaza SIN cambiar marcador ni registro", async () => {
  const { recoverPaidOperation } = await import("./recovery");
  const s = memoryStorage();
  const img = fakeImages(["timeout", "ok"]);
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.1 })), /timeout/);
  const operator = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.1 });
  await assert.rejects(
    recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: operator, key: "image:req/scene-0-styled-abc", note: "revisado" }),
    PaidBudgetExceededError,
  );
  assert.equal(s.json<{ status: string }>(generatedImageMarkerPath("req", "scene-0-styled-abc"))?.status, "started");
  assert.equal(operator.latest("image:req/scene-0-styled-abc")?.acknowledgedAtIso, undefined);
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.1 })), GeneratedImageUncertainError);
  assert.equal(img.calls(), 1);
});

test("recuperación: se rechaza sin tope, sin nota o si el resultado ya está guardado", async () => {
  const { recoverPaidOperation, RecoveryRefusedError } = await import("./recovery");
  const s = memoryStorage();
  const img = fakeImages(["timeout"]);
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req")), /timeout/);
  const noCap = await openStorageLedger(s.client, "videos", "req");
  await assert.rejects(recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: noCap, key: "image:req/scene-0-styled-abc", note: "x" }), RecoveryRefusedError);
  await assert.rejects(recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: noCap, key: "image:req/scene-0-styled-abc", note: " ", capUsd: 1 }), RecoveryRefusedError);

  const stored = memoryStorage();
  const good = fakeImages(["ok"]);
  const ledger = await openStorageLedger(stored.client, "videos", "req", { capUsd: 0.75 });
  await resolve(stored.client, good.provider, ledger);
  await assert.rejects(
    recoverPaidOperation({ supabase: stored.client, bucket: "videos", ledger, key: "image:req/scene-0-styled-abc", note: "x" }),
    /ya está guardada/,
  );
});

test("recuperación: reconocer SOLO el registro no desbloquea (el marcador manda); la recuperación completa lo sincroniza", async () => {
  const { recoverPaidOperation } = await import("./recovery");
  const s = memoryStorage();
  const img = fakeImages(["timeout", "ok"]);
  const key = "image:req/scene-0-styled-abc";
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 })), /timeout/);
  const partial = await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 });
  assert.equal(await partial.acknowledge(key, "solo el registro"), true);
  await assert.rejects(resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 })), GeneratedImageUncertainError);
  // Repetir la recuperación completa termina lo que faltó (idempotente).
  const result = await recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 }), key, note: "revisado" });
  assert.equal(result.acknowledged, false, "ya estaba reconocido");
  assert.equal(result.released?.previousStatus, "started");
  assert.equal((await resolve(s.client, img.provider, await openStorageLedger(s.client, "videos", "req", { capUsd: 0.75 }))).status, "generated");
  assert.equal(img.calls(), 2);
});

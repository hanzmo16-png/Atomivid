/**
 * Llamadas reales al modelo de guion, con fetch simulado (cero red, cero
 * gasto): reintentos solo cuando no pudo cobrarse, cada llamada registrada y
 * diagnóstico seguro (sin texto, razonamiento ni claves).
 */
process.env.SCRIPT_RETRY_DELAY_MS = "0";
process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LENGTH_ATTEMPTS,
  SCRIPT_MAX_TOKENS,
  ScriptOutputError,
  createScriptClient,
  generateScript,
  setScriptClientForTests,
} from "./script";
import { realScriptProvider } from "@/lib/providers/script/real";
import { targetWordsFor } from "@/lib/video/script-pacing";
import { PaidLedger, UncertainPaidOperationError, memoryLedgerStore } from "@/lib/video/audiovisual/paid-ledger";
import {
  SCRIPT_LENGTH_ATTEMPTS,
  SCRIPT_MAX_TOKENS_PER_CALL,
  SCRIPT_PROMPT_CHARS_ESTIMATE,
  scriptCallReserveUsd,
  scriptUsageCostUsd,
} from "@/lib/video/audiovisual/paid-costs";
import { assertScriptGenerationClear, ledgeredScriptRunner, scriptScope } from "@/lib/video/audiovisual/script-ledger";
import { recoverPaidOperation } from "@/lib/video/audiovisual/recovery";
import { memoryStorage } from "@/lib/video/audiovisual/test-storage";

const API_KEY = "sk-ant-prueba-no-real-123";
const THINKING_SECRET = "RAZONAMIENTO_INTERNO_QUE_NO_DEBE_APARECER";
const INPUT = { topic: "El faro abandonado", style: "Curiosidades", durationSeconds: 30, language: "es" as const };
const TARGET = targetWordsFor(30);
const USAGE = { input_tokens: 2100, output_tokens: 850, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function scriptJson(words: number) {
  const per = Math.ceil(words / 4);
  const segments = Array.from({ length: 4 }, (_, i) => ({
    text: Array.from({ length: i < 3 ? per : words - 3 * per }, (_, w) => `palabra${w}`).join(" "),
    visualQuery: "old lighthouse",
  }));
  return JSON.stringify({ title: "Título", segments });
}

const message = (content: unknown[], stop_reason = "end_turn", usage: unknown = USAGE) =>
  new Response(JSON.stringify({ id: "msg_prueba", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason, stop_sequence: null, usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const text = (t: string) => ({ type: "text", text: t });
const netError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

type Step = Response | Error | (() => Response);

async function withScript<T>(steps: Step[], fn: (ctx: { calls: () => number; logs: string[] }) => Promise<T>): Promise<T> {
  let calls = 0;
  const queue = [...steps];
  const fetchStub = (async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: "disabled" }, "el presupuesto de salida se reserva para el guion, sin razonamiento implícito");
    if (String(body.messages?.[0]?.content).includes("Borrador a editar:")) {
      const draft = JSON.parse(String(body.messages[0].content).split("Borrador a editar:\n")[1]);
      assert.ok(draft.segments.length > 0, "la corrección recibe el texto anterior, no solo su conteo");
    }
    const next = queue.shift();
    if (!next) throw new Error("llamada inesperada");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  setScriptClientForTests(createScriptClient(API_KEY, fetchStub));
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    return await fn({ calls: () => calls, logs });
  } finally {
    console.log = original;
    setScriptClientForTests(null);
  }
}

const ledgerWithCap = (capUsd = 1) => PaidLedger.open(memoryLedgerStore(), { scope: "samples/audiovisual/horror", capUsd });
const SCOPE = scriptScope("samples/audiovisual/horror");

test("guion: respuesta sin bloque de texto (parsed_output vacío) → UNA sola llamada, sin reintento, con diagnóstico seguro", async () => {
  await withScript([message([{ type: "thinking", thinking: THINKING_SECRET, signature: "firma" }], "max_tokens")], async ({ calls, logs }) => {
    await assert.rejects(realScriptProvider.generateScript(INPUT), (err: unknown) => {
      assert.ok(err instanceof ScriptOutputError);
      assert.equal(err.diagnostics.parse, "no_text_block");
      assert.equal(err.diagnostics.stopReason, "max_tokens");
      assert.deepEqual(err.diagnostics.blockTypes, ["thinking"]);
      assert.deepEqual(err.diagnostics.usage, USAGE);
      return true;
    });
    assert.equal(calls(), 1, "ni el proveedor, ni el SDK, ni el bucle de longitud repiten una respuesta ya recibida");
    const line = logs.find((l) => l.startsWith("[atomivid:script-call]"))!;
    assert.match(line, /"stopReason":"max_tokens"/);
    assert.match(line, /"blockTypes":\["thinking"\]/);
    assert.match(line, /"output_tokens":850/);
    const all = logs.join("\n");
    assert.ok(!all.includes(THINKING_SECRET), "nunca se registra el razonamiento");
    assert.ok(!all.includes(API_KEY), "nunca se registra la clave");
    assert.ok(!all.includes(INPUT.topic), "nunca se registra el prompt");
  });
});

test("guion: JSON inválido o fuera del esquema → una llamada; el diagnóstico da rutas, nunca el texto", async () => {
  await withScript([message([text('{"title": "x", "segments": [{"text": 5}]}')])], async ({ calls }) => {
    await assert.rejects(generateScript(INPUT), (err: unknown) => err instanceof ScriptOutputError && err.diagnostics.parse === "schema_mismatch" && err.diagnostics.schemaIssues!.includes("segments.0.text"));
    assert.equal(calls(), 1);
  });
  await withScript([message([text("no es json")])], async ({ calls }) => {
    await assert.rejects(generateScript(INPUT), (err: unknown) => err instanceof ScriptOutputError && err.diagnostics.parse === "invalid_json");
    assert.equal(calls(), 1);
  });
});

test("guion: con registro, la llamada vacía queda PAGADA por sus tokens medidos y bloquea otra generación", async () => {
  const ledger = await ledgerWithCap();
  await withScript([message([], "refusal")], async ({ calls }) => {
    await assert.rejects(generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") }), ScriptOutputError);
    assert.equal(calls(), 1);
  });
  const [entry] = ledger.snapshot().entries;
  assert.equal(entry.key, `${SCOPE}/abc/call-1`);
  assert.equal(entry.status, "spent");
  assert.equal(entry.costBasis, "provider_usage");
  assert.ok(Math.abs(entry.actualUsd! - scriptUsageCostUsd(USAGE)) < 1e-12);
  assert.match(entry.note!, /stop_reason=refusal; bloques=ninguno/);
  assert.throws(() => assertScriptGenerationClear(ledger, SCOPE), UncertainPaidOperationError);
});

test("guion: cada corrección de longitud es otra llamada registrada y contabilizada", async () => {
  const ledger = await ledgerWithCap();
  const metas: number[] = [];
  const runner = ledgeredScriptRunner(ledger, SCOPE, "abc");
  await withScript([message([text(scriptJson(10))]), message([text(scriptJson(12))]), message([text(scriptJson(TARGET))])], async ({ calls, logs }) => {
    const out = await generateScript({ ...INPUT, runCall: (meta, call) => (metas.push(meta.lengthAttempt), runner(meta, call)) });
    assert.equal(out.segments.length, 4);
    assert.equal(calls(), 3);
    assert.deepEqual(metas, [1, 2, 3]);
    assert.equal(logs.filter((l) => l.includes('"parse":"ok"')).length, 3);
  });
  const entries = ledger.snapshot().entries;
  assert.deepEqual(entries.map((e) => [e.key.split("/").pop(), e.status]), [["call-1", "spent"], ["call-2", "spent"], ["call-3", "spent"]]);
  assert.ok(Math.abs(ledger.summary().committedUsd - 3 * scriptUsageCostUsd(USAGE)) < 1e-6);
});

test("guion: HTTP 500 y 529 no prueban costo cero → una llamada, incierta, sin reintento (tampoco del SDK)", async () => {
  for (const status of [500, 529]) {
    const ledger = await ledgerWithCap();
    await withScript([new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } }), { status }), message([text(scriptJson(TARGET))])], async ({ calls }) => {
      await assert.rejects(generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") }));
      assert.equal(calls(), 1, `status ${status}`);
    });
    assert.equal(ledger.snapshot().entries[0].status, "uncertain");
  }
});

test("guion: conexión cortada en vuelo → una llamada, incierta", async () => {
  const ledger = await ledgerWithCap();
  await withScript([netError("ECONNRESET"), message([text(scriptJson(TARGET))])], async ({ calls }) => {
    await assert.rejects(generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") }));
    assert.equal(calls(), 1);
  });
  assert.equal(ledger.snapshot().entries[0].status, "uncertain");
});

test("guion: solo se reintenta lo que no pudo cobrarse (conexión rechazada, 429), y cada intento queda registrado", async () => {
  for (const first of [netError("ECONNREFUSED"), new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }), { status: 429 })]) {
    const ledger = await ledgerWithCap();
    await withScript([first, message([text(scriptJson(TARGET))])], async ({ calls }) => {
      await generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") });
      assert.equal(calls(), 2);
    });
    assert.deepEqual(ledger.snapshot().entries.map((e) => [e.key.split("/").pop(), e.status]), [["call-1", "released"], ["call-2", "spent"]]);
  }
});

test("guion: los US$0,08 inciertos del intento real se conservan y bloquean otra generación sin llamar", async () => {
  // Estado equivalente al del run 36245126551: una sola entrada de guion incierta (clave de la versión anterior).
  const store = memoryLedgerStore({
    version: 1,
    scope: "samples/audiovisual/horror",
    capUsd: 0.75,
    updatedAtIso: "2026-09-26T13:40:00.000Z",
    entries: [{ key: `${SCOPE}/0123456789abcdef`, kind: "script", provider: "anthropic", reserveUsd: 0.08, status: "uncertain", reservedAtIso: "2026-09-26T13:39:00.000Z", note: "Claude no devolvió un guion válido" }],
  });
  const ledger = await PaidLedger.open(store, { scope: "samples/audiovisual/horror", capUsd: 0.75 });
  await withScript([message([text(scriptJson(TARGET))])], async ({ calls }) => {
    assert.throws(() => assertScriptGenerationClear(ledger, SCOPE), UncertainPaidOperationError);
    assert.equal(calls(), 0);
  });
  assert.equal(ledger.summary().committedUsd, 0.08);
  assert.equal(ledger.summary().uncertainUsd, 0.08);
});

test("guion: la recuperación explícita del grupo comprueba presupuesto, conserva el gasto y reconoce todas sus llamadas", async () => {
  const s = memoryStorage();
  const ledger = await ledgerWithCap(0.75);
  await withScript([message([text(scriptJson(10))]), message([], "max_tokens")], async () => {
    await assert.rejects(generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") }), ScriptOutputError);
  });
  const before = ledger.summary().committedUsd;
  const tight = await PaidLedger.open(memoryLedgerStore(ledger.snapshot()), { scope: "samples/audiovisual/horror", capUsd: before + 0.01 });
  await assert.rejects(recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger: tight, key: SCOPE, note: "revisado" }), /No se cambió nada/);
  assert.throws(() => assertScriptGenerationClear(tight, SCOPE));

  const result = await recoverPaidOperation({ supabase: s.client, bucket: "videos", ledger, key: SCOPE, note: "revisado en la consola de Anthropic" });
  assert.equal(result.acknowledged, true);
  assert.equal(ledger.summary().committedUsd, before, "el gasto anterior sigue contando");
  assert.doesNotThrow(() => assertScriptGenerationClear(ledger, SCOPE));
  // Una generación nueva usa claves nuevas (call-3…), nunca reutiliza las anteriores.
  await withScript([message([text(scriptJson(TARGET))])], async () => {
    await generateScript({ ...INPUT, runCall: ledgeredScriptRunner(ledger, SCOPE, "abc") });
  });
  assert.equal(ledger.snapshot().entries.at(-1)!.key, `${SCOPE}/abc/call-3`);
});

test("guion: constantes de reserva alineadas con el generador y la reserva por llamada cubre el prompt real", async () => {
  assert.equal(SCRIPT_LENGTH_ATTEMPTS, MAX_LENGTH_ATTEMPTS);
  assert.equal(SCRIPT_MAX_TOKENS_PER_CALL, SCRIPT_MAX_TOKENS);
  const seen: number[] = [];
  await withScript([message([text(scriptJson(TARGET))])], async () => {
    await generateScript({ ...INPUT, guidance: "Guía de suspenso: ".repeat(20), runCall: (meta, call) => (seen.push(meta.promptChars), call()) });
  });
  assert.ok(seen[0] < SCRIPT_PROMPT_CHARS_ESTIMATE, `prompt ${seen[0]} caracteres`);
  // Peor caso de salida (max_tokens) con la entrada estimada: la reserva lo cubre.
  assert.ok(scriptCallReserveUsd(seen[0], SCRIPT_MAX_TOKENS) >= scriptUsageCostUsd({ input_tokens: Math.ceil(seen[0] / 2), output_tokens: SCRIPT_MAX_TOKENS }));
});

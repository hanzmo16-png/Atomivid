/**
 * RED/GREEN de precisión monetaria contra Postgres REAL con los tipos de la migración 0023
 * (reserved_usd/committed_usd numeric(12,4)). USD 0: todos los proveedores son mocks.
 * Ejecutar: HARNESS_PG_URL=postgres://postgres@/x?host=/tmp&port=55432 node --import tsx --test scripts/harness/ledger-precision.pg.test.ts
 * Sin HARNESS_PG_URL el test FALLA (no se salta en silencio).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { pgClient, pgLedgerStore } from "./pg-ledger-store";
import { ledgerGuardedCreateAvatar, configuredAvatarCreationCostUsd } from "@/lib/video/avatar/create-avatar-ledger";
import { gatedMusicTrack, gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";
import { guardPaidCall } from "@/lib/paid-calls/gate";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import type { MusicProvider, VoiceProvider } from "@/lib/providers/types";

const URL = process.env.HARNESS_PG_URL;
let db: Awaited<ReturnType<typeof pgClient>>;
const DDL = `
create or replace function public.pi_reject_mutation() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$;
drop table if exists public.pi_paid_operations cascade;
create table public.pi_paid_operations (
  idempotency_key text primary key, project_id text not null, shot_id text not null, provider text not null, model text not null,
  method text not null, attempt_kind text not null,
  reserved_usd numeric(12,4) not null check (reserved_usd >= 0),
  committed_usd numeric(12,4) check (committed_usd is null or committed_usd >= 0),
  status text not null check (status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','COMMITTED','REFUNDED','RECONCILIATION_REQUIRED')),
  provider_job_id text, result_ref text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`;

before(async () => {
  assert.ok(URL, "HARNESS_PG_URL es obligatorio: este test no se salta en silencio");
  db = await pgClient(URL!);
  await db.query(DDL);
});
after(async () => { await db?.end(); });
beforeEach(async () => { await db.query("truncate public.pi_paid_operations"); });

async function rows() {
  const r = await db.query("select status, reserved_usd::text r, committed_usd::text c from public.pi_paid_operations order by created_at");
  return r.rows as { status: string; r: string; c: string | null }[];
}

async function avatarRun(rate: string) {
  let calls = 0;
  const env = { PRICING_HEYGEN_CREATE_AVATAR_USD: rate };
  const ledger = pgLedgerStore(db);
  const run = () => ledgerGuardedCreateAvatar(ledger, "req-precision", "heygen", "sha-photo",
    async () => { calls++; return { avatarId: "av1" } as never; },
    { verifiedCostUsd: configuredAvatarCreationCostUsd("heygen", env) });
  return { run, get calls() { return calls; } };
}

// Positivos diminutos y fronteras: nunca 0.0000 en el ledger tras una llamada facturable.
const CASES: [string, string][] = [
  ["0.0000001", "0.0001"], ["0.000001", "0.0001"], ["0.00004999", "0.0001"], ["0.00005", "0.0001"],
  ["0.0001", "0.0001"], ["0.00010001", "0.0002"], ["0.0003", "0.0003"], ["0.35", "0.3500"], ["12.5", "12.5000"], ["99999999.9999", "99999999.9999"],
];
for (const [rate, stored] of CASES) {
  test(`avatar tarifa ${rate} → 1 llamada, COMMITTED, reserved=committed=${stored} (nunca 0)`, async () => {
    const a = await avatarRun(rate);
    await a.run();
    assert.equal(a.calls, 1);
    const rs = await rows();
    assert.equal(rs.length, 1);
    assert.equal(rs[0].status, "COMMITTED");
    assert.equal(rs[0].r, stored);
    assert.equal(rs[0].c, stored);
    assert.notEqual(rs[0].c, "0.0000");
    // Reutilización: segunda ejecución no llama ni escribe otra fila.
    await a.run();
    assert.equal(a.calls, 1);
    assert.equal((await rows()).length, 1);
  });
}

for (const bad of ["0", "-0.01", "", "  ", "NaN", "Infinity", "-Infinity", "abc", "100000000", "1e9"]) {
  test(`avatar tarifa inválida/no representable "${bad}" → rechazo antes del proveedor, 0 filas`, async () => {
    let calls = 0;
    assert.throws(() => configuredAvatarCreationCostUsd("heygen", { PRICING_HEYGEN_CREATE_AVATAR_USD: bad }));
    // También por la vía verifiedCostUsd explícita (sin pasar por la env).
    const n = Number(bad);
    await assert.rejects(ledgerGuardedCreateAvatar(pgLedgerStore(db), "req-bad", "heygen", "sha", async () => { calls++; return {} as never; }, { verifiedCostUsd: n }));
    assert.equal(calls, 0);
    assert.equal((await rows()).length, 0);
  });
}

const identity = { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" };
test("voz facturable 0.000001 → reserved=committed=0.0001, 1 llamada; reuso 0 llamadas", async () => {
  let calls = 0;
  const provider = { name: "elevenlabs", synthesize: async () => { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 1, words: [], mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as VoiceProvider;
  const deps = { requestId: "rv", ledger: pgLedgerStore(db), results: memoryResultStore(), voiceProvider: provider, voiceIdentity: identity };
  await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: 0.000001 }, "hola", "es");
  const rs = await rows();
  assert.equal(calls, 1); assert.equal(rs.length, 1);
  assert.deepEqual(rs[0], { status: "COMMITTED", r: "0.0001", c: "0.0001" });
  const again = await gatedVoiceSynthesize({ ...deps, estimatedCostUsd: 0 }, "hola", "es");
  assert.equal(calls, 1); assert.equal(again.reused, true); assert.equal((await rows()).length, 1);
});

test("música generativa 0.00004999 → reserved=committed=0.0001, 1 llamada", async () => {
  let calls = 0;
  const provider = { name: "beatoven", getTrack: async () => { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as MusicProvider;
  await gatedMusicTrack({ requestId: "rm", ledger: pgLedgerStore(db), results: memoryResultStore(), musicProvider: provider, estimatedCostUsd: 0.00004999 }, { durationSeconds: 30 });
  assert.equal(calls, 1);
  assert.deepEqual(await rows(), [{ status: "COMMITTED", r: "0.0001", c: "0.0001" }]);
});

test("fixture/biblioteca gratis siguen en 0 (sin fila positiva inventada)", async () => {
  let calls = 0;
  const provider = { name: "curated-library", getTrack: async () => { calls++; return { audioBuffer: Buffer.from("mp3"), durationSeconds: 30, mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as MusicProvider;
  await gatedMusicTrack({ requestId: "rf", ledger: pgLedgerStore(db), results: memoryResultStore(), musicProvider: provider, estimatedCostUsd: 0 }, { durationSeconds: 30 });
  assert.equal(calls, 1);
  for (const r of await rows()) { assert.equal(r.r, "0.0000"); }
});

test("imágenes/genérico vía gate: reserva y costo diminutos nunca se guardan como 0; NaN/negativo/overflow bloquean antes", async () => {
  let calls = 0;
  const spec = { projectId: "ri", shotId: "img:1", provider: "openai", model: "gpt-image", method: "generate", inputFingerprint: { p: 1 }, reservedUsd: 0.00002 };
  await guardPaidCall(pgLedgerStore(db), spec, { call: async () => { calls++; return { result: "x", costUsd: 0.00003, resultRef: "img:x" }; }, load: async () => "x" });
  assert.equal(calls, 1);
  assert.deepEqual(await rows(), [{ status: "COMMITTED", r: "0.0001", c: "0.0001" }]);
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 1e8]) {
    await assert.rejects(guardPaidCall(pgLedgerStore(db), { ...spec, shotId: `img:${bad}`, reservedUsd: bad }, { call: async () => { calls++; return { result: "x", costUsd: 1, resultRef: "r" }; }, load: async () => "x" }));
  }
  assert.equal(calls, 1);
  assert.equal((await rows()).length, 1);
});


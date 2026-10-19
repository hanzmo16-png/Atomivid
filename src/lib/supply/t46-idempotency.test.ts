/**
 * T46 (D1–D3), ROJO/VERDE with 2/5/10 concurrent competitors. Counters: rows persisted and paid provider calls.
 * D1: the request id comes from user + intent on the server (submission-key.ts), not from a browser key — a browser
 *     without localStorage/Web Locks sends a different key per tab and still maps to ONE request.
 * D2: createAvatar runs under the Postgres paid-call ledger (create-avatar-ledger.ts): at most one provider call even
 *     when the Storage claim is not atomic (storage-api v1.11.13 let every concurrent upload win).
 * D3: an uncertain outcome is never resubmitted; it stays blocked until reconciled (docs/runbooks/avatar-uncertain-claims.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { draftRequestId, intentFingerprint, requestIdForSubmission } from "@/lib/video/submission-key";
import { gatedVoiceSynthesize } from "@/lib/paid-calls/gated-providers";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { configuredAvatarCreationCostUsd, ledgerGuardedCreateAvatar } from "@/lib/video/avatar/create-avatar-ledger";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { createAvatarOnce, photoClaimPath, type NewPhotoClaimDeps } from "@/lib/video/avatar/new-photo-claim";
import { AvatarProviderError } from "@/lib/providers/types";
import type { VoiceProvider } from "@/lib/providers/types";

const USER_A = "11111111-1111-4111-8111-111111111111", USER_B = "22222222-2222-4222-8222-222222222222";
const form = (key: string, text = "Hola, este es mi texto.") => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ submission_id: key, mode: "avatar", topic: "Mi video", style: "Educativo", duration_seconds: "30",
    language: "es", narration_source: "tts_text", avatar_tts_text: text, existing_avatar_id: "a1" })) fd.set(k, v);
  return fd;
};

/** The action's order with a Postgres-like primary key and the real paid-voice gate (in-memory ledger). */
function backend(rule: "T46" | "ROJO_browser_key") {
  const rows = new Set<string>(); const ledger = memoryLedgerStore(), results = memoryResultStore(); let paid = 0;
  const voice = { name: "elevenlabs", synthesize: async () => { paid++; await new Promise(r => setTimeout(r, 10));
    return { audioBuffer: Buffer.from("mp3"), durationSeconds: 10, words: [], mimeType: "audio/mpeg", extension: "mp3" }; } } as unknown as VoiceProvider;
  async function submit(user: string, fd: FormData) {
    const id = rule === "T46"
      ? (await requestIdForSubmission(user, fd, async c => new Set(c.filter(x => rows.has(x))))).requestId!
      : draftRequestId(user, String(fd.get("submission_id")), await intentFingerprint(fd)); // rule shipped in 35fb212
    if (rows.has(id)) return "existing";
    try {
      await gatedVoiceSynthesize({ requestId: id, ledger, results, voiceProvider: voice, estimatedCostUsd: 0.05,
        voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" } }, String(fd.get("avatar_tts_text")), "es");
    } catch { return "retry"; }
    if (rows.has(id)) return "23505";
    rows.add(id); return "created";
  }
  return { submit, rows, get paid() { return paid; } };
}

for (const n of [2, 5, 10]) {
  test(`D1 ROJO (regla de 35fb212): ${n} pestañas sin localStorage (llave distinta por pestaña) → ${n} filas y ${n} voces pagadas`, async () => {
    const b = backend("ROJO_browser_key");
    await Promise.all(Array.from({ length: n }, () => b.submit(USER_A, form(randomUUID()))));
    assert.equal(b.rows.size, n); assert.equal(b.paid, n);
  });
  test(`D1 VERDE: ${n} pestañas sin localStorage, misma intención → como máximo 1 voz pagada y, tras reintentar, 1 sola fila`, async () => {
    const b = backend("T46");
    await Promise.all(Array.from({ length: n }, () => b.submit(USER_A, form(randomUUID()))));
    assert.ok(b.paid <= 1, `voces pagadas: ${b.paid}`);
    assert.ok(b.rows.size <= 1);
    const before = b.rows.size;
    assert.equal(await b.submit(USER_A, form(randomUUID())), before ? "existing" : "created", "un reintento converge");
    assert.equal(b.rows.size, 1); assert.equal(b.paid, 1);
  });
  test(`D5 VERDE: ${n} reenvíos concurrentes de LA MISMA repetición explícita → 1 solicitud adicional`, async () => {
    const b = backend("T46");
    await b.submit(USER_A, form(randomUUID()));
    const repeatToken = randomUUID();
    const repeated = () => { const f = form(randomUUID()); f.set("repeat_intent", "on"); f.set("repeat_request_token", repeatToken); return f; };
    await Promise.all(Array.from({ length: n }, () => b.submit(USER_A, repeated())));
    assert.ok(b.rows.size <= 2, `filas ${b.rows.size}`); assert.ok(b.paid <= 2, `voces ${b.paid}`);
    if (b.rows.size < 2) await b.submit(USER_A, repeated());
    assert.equal(b.rows.size, 2); assert.equal(b.paid, 2);
    // The old first-free-ordinal rule produced a THIRD request here after commit/redirect loss.
    assert.equal(await b.submit(USER_A, repeated()), "existing");
    assert.equal(b.rows.size, 2); assert.equal(b.paid, 2);
    const fresh = form(randomUUID()); fresh.set("repeat_intent", "on"); fresh.set("repeat_request_token", randomUUID());
    await b.submit(USER_A, fresh);
    assert.equal(b.rows.size, 3); assert.equal(b.paid, 3);
  });
}

test("D1: cuentas distintas nunca se deduplican entre sí; otra intención es otra solicitud", async () => {
  const b = backend("T46");
  await b.submit(USER_A, form(randomUUID())); await b.submit(USER_B, form(randomUUID()));
  await b.submit(USER_A, form(randomUUID(), "Otro texto distinto."));
  assert.equal(b.rows.size, 3);
});

test("D1: el id no depende de la llave del navegador ni de su ausencia", async () => {
  const noKey = form(""); noKey.delete("submission_id");
  const ids = await Promise.all([form(randomUUID()), form(randomUUID()), noKey, form("no-es-uuid")].map(async f => (await requestIdForSubmission(USER_A, f)).requestId));
  assert.equal(new Set(ids).size, 1);
});

test("D5 fail closed: a repeat without a stable valid token cannot choose a payable request", async () => {
  const repeat = form(randomUUID()); repeat.set("repeat_intent", "on");
  assert.equal((await requestIdForSubmission(USER_A, repeat)).requestId, null);
  repeat.set("repeat_request_token", "invalid");
  assert.equal((await requestIdForSubmission(USER_A, repeat)).requestId, null);
});

// ---------------------------------------------------------------- D2

/** A test ledger whose submit hook performs the same RESERVED→SUBMITTED CAS expected from atomic supply admission. */
function admittedMemoryLedger() {
  const ledger = memoryLedgerStore();
  ledger.submit = async (op, at) => ledger.update(op.idempotencyKey, "RESERVED", { status: "SUBMITTED", updatedAt: at });
  return ledger;
}

/** Storage that is NOT atomic (every concurrent upload wins), as storage-api v1.11.13 behaved. */
function avatarWorld(providerImpl: () => Promise<{ providerAvatarId: string }>) {
  const ledger = admittedMemoryLedger(); let providerCalls = 0;
  const deps = (requestId: string, guarded: boolean): NewPhotoClaimDeps => ({
    async upload() { await new Promise(r => setTimeout(r, 1)); return { ok: true }; },
    async findAvatarByPhoto() { return null; },
    async claimCreatedAt() { return new Date(); },
    async removePhoto() {},
    async createAvatar() {
      const call = async () => { providerCalls++; await new Promise(r => setTimeout(r, 15)); const r = await providerImpl();
        return { providerAvatarId: r.providerAvatarId, status: "completed", providerName: "heygen" }; };
      return guarded ? ledgerGuardedCreateAvatar(ledger, requestId, "heygen", "sha-foto", call, { verifiedCostUsd: 0.25 }) : call();
    },
    async insertAvatar() { return { id: randomUUID(), status: "ready" }; },
  });
  return { deps, get providerCalls() { return providerCalls; } };
}
const ok = async () => ({ providerAvatarId: "asset:1" });

for (const n of [2, 5, 10]) {
  test(`D2 ROJO: Storage no atómico y SIN ledger → ${n} llamadas a createAvatar`, async () => {
    const w = avatarWorld(ok), id = randomUUID();
    await Promise.all(Array.from({ length: n }, () => createAvatarOnce(w.deps(id, false), photoClaimPath("u", id, "jpg"))));
    assert.equal(w.providerCalls, n);
  });
  test(`D2 VERDE: Storage no atómico CON ledger → como máximo 1 llamada a createAvatar (${n} competidores)`, async () => {
    const w = avatarWorld(ok), id = randomUUID();
    const r = await Promise.all(Array.from({ length: n }, () => createAvatarOnce(w.deps(id, true), photoClaimPath("u", id, "jpg"))));
    assert.equal(w.providerCalls, 1);
    assert.ok(r.every(x => ["created", "uncertain"].includes(x.kind)), JSON.stringify(r.map(x => x.kind)));
  });
}

test("D2/D3: tiempo agotado tras posible aceptación → incierto; reintentos posteriores 0 llamadas (nunca otra generación por TTL)", async () => {
  const w = avatarWorld(async () => { throw new AvatarProviderError("timeout", "heygen", "upstream_error"); }), id = randomUUID();
  assert.equal((await createAvatarOnce(w.deps(id, true), photoClaimPath("u", id, "jpg"))).kind, "uncertain");
  for (let i = 0; i < 3; i++) assert.equal((await createAvatarOnce(w.deps(id, true), photoClaimPath("u", id, "jpg"))).kind, "uncertain");
  assert.equal(w.providerCalls, 1);
});

test("D2: un resultado confirmado se reutiliza del ledger sin volver a llamar", async () => {
  const store = admittedMemoryLedger(), id = randomUUID(); let calls = 0;
  const call = async () => { calls++; return { providerAvatarId: "asset:7", status: "completed", providerName: "heygen" }; };
  await ledgerGuardedCreateAvatar(store, id, "heygen", "x", call, { verifiedCostUsd: 0.25 });
  const again = await ledgerGuardedCreateAvatar(store, id, "heygen", "x", call, { verifiedCostUsd: 0.25 });
  assert.equal(calls, 1); assert.equal(again.providerAvatarId, "asset:7");
});

test("D6: tarifa ausente, cero, negativa o malformada bloquea antes de reservar o llamar", async () => {
  for (const env of [{}, { PRICING_HEYGEN_CREATE_AVATAR_USD: "0" }, { PRICING_HEYGEN_CREATE_AVATAR_USD: "-1" },
    { PRICING_HEYGEN_CREATE_AVATAR_USD: "gratis" }]) {
    assert.throws(() => configuredAvatarCreationCostUsd("heygen", env), (e: unknown) =>
      e instanceof AvatarProviderError && e.reason === "not_configured");
  }
  assert.equal(configuredAvatarCreationCostUsd("heygen", { PRICING_HEYGEN_CREATE_AVATAR_USD: "0.1234561" }), 0.123457);
});

test("D6: sin el submit atómico de supply no existe bypass local; 0 llamadas", async () => {
  const store = memoryLedgerStore(); let calls = 0;
  await assert.rejects(
    ledgerGuardedCreateAvatar(store, randomUUID(), "heygen", "photo", async () => {
      calls++; return { providerAvatarId: "asset:no", status: "completed", providerName: "heygen" };
    }, { verifiedCostUsd: 0.25 }),
    (e: unknown) => e instanceof AvatarProviderError && e.reason === "not_configured",
  );
  assert.equal(calls, 0);
});

for (const reason of ["insufficient balance", "balance unverified or stale", "rate limited", "timeout"]) {
  test(`D6: supply ${reason} bloquea con 0 llamadas y rechazo local definitivo`, async () => {
    const store = memoryLedgerStore(); let calls = 0;
    store.submit = async () => { throw new SupplyUnavailableError("heygen", reason); };
    await assert.rejects(
      ledgerGuardedCreateAvatar(store, randomUUID(), "heygen", "photo", async () => {
        calls++; return { providerAvatarId: "asset:no", status: "completed", providerName: "heygen" };
      }, { verifiedCostUsd: 0.25 }),
      (e: unknown) => e instanceof AvatarProviderError && e.reason === "budget_exceeded",
    );
    assert.equal(calls, 0);
  });
}

test("D6: un bloqueo económico libera solo el claim local; 0 llamadas y ninguna incertidumbre falsa", async () => {
  const store = memoryLedgerStore(); let providerCalls = 0, removals = 0;
  store.submit = async () => { throw new SupplyUnavailableError("heygen", "insufficient balance"); };
  const result = await createAvatarOnce({
    async upload() { return { ok: true }; },
    async findAvatarByPhoto() { return null; },
    async claimCreatedAt() { return new Date(); },
    async removePhoto() { removals++; },
    async createAvatar() {
      return ledgerGuardedCreateAvatar(store, randomUUID(), "heygen", "photo", async () => {
        providerCalls++; return { providerAvatarId: "asset:no", status: "completed", providerName: "heygen" };
      }, { verifiedCostUsd: 0.25 });
    },
    async insertAvatar() { throw new Error("unreachable"); },
  }, "u/request.jpg");
  assert.equal(result.kind, "provider_failed");
  assert.equal(providerCalls, 0);
  assert.equal(removals, 1);
});

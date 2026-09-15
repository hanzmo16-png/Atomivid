import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_LANGUAGE,
  DEFAULT_MODE,
  DEFAULT_STYLE,
  DEFAULT_TOPIC,
  MAX_DURATION_SECONDS,
  MAX_STYLE_LENGTH,
  MAX_TOPIC_LENGTH,
  type ResolvedSeedInput,
  buildVideoRequestInsert,
  resolveDurationSeconds,
  resolveLanguage,
  resolveMode,
  resolveScriptProvider,
  resolveSeedInput,
  resolveStyle,
  resolveTopic,
  seedTestRequest,
} from "./seed-request";

// --- Tema ---------------------------------------------------------------

test("tema: undefined usa el default (comportamiento sin cambios)", () => {
  const result = resolveTopic(undefined);
  assert.deepEqual(result, { ok: true, value: DEFAULT_TOPIC });
});

test("tema: valor válido se acepta tal cual (recortado)", () => {
  const result = resolveTopic("  Los resultados tienen un precio  ");
  assert.deepEqual(result, { ok: true, value: "Los resultados tienen un precio" });
});

test("tema: vacío o solo espacios es inválido", () => {
  assert.equal(resolveTopic("").ok, false);
  assert.equal(resolveTopic("   ").ok, false);
  assert.equal(resolveTopic("\t\n").ok, false);
});

test("tema: en el límite máximo es válido, uno más lo excede", () => {
  const atLimit = "a".repeat(MAX_TOPIC_LENGTH);
  const overLimit = "a".repeat(MAX_TOPIC_LENGTH + 1);
  assert.equal(resolveTopic(atLimit).ok, true);
  const over = resolveTopic(overLimit);
  assert.equal(over.ok, false);
});

// --- Estilo (según los valores reales admitidos por el esquema: no vacío, <= 100 chars) ---

test("estilo: undefined usa el default", () => {
  assert.deepEqual(resolveStyle(undefined), { ok: true, value: DEFAULT_STYLE });
});

test("estilo: permitido — no vacío y dentro del límite del esquema", () => {
  assert.deepEqual(resolveStyle("Motivacional"), { ok: true, value: "Motivacional" });
  assert.equal(resolveStyle("a".repeat(MAX_STYLE_LENGTH)).ok, true);
});

test("estilo: inválido — vacío, solo espacios, o por encima del límite del esquema (migración 0007)", () => {
  assert.equal(resolveStyle("").ok, false);
  assert.equal(resolveStyle("   ").ok, false);
  assert.equal(resolveStyle("a".repeat(MAX_STYLE_LENGTH + 1)).ok, false);
});

// --- Idioma ---------------------------------------------------------------

test("idioma: undefined o vacío usa el default", () => {
  assert.deepEqual(resolveLanguage(undefined), { ok: true, value: DEFAULT_LANGUAGE });
  assert.deepEqual(resolveLanguage(""), { ok: true, value: DEFAULT_LANGUAGE });
});

test("idioma: es/en son válidos", () => {
  assert.deepEqual(resolveLanguage("es"), { ok: true, value: "es" });
  assert.deepEqual(resolveLanguage("en"), { ok: true, value: "en" });
});

test("idioma: cualquier otro valor es inválido (no cae en silencio a 'es')", () => {
  for (const bad of ["ES", "spanish", "fr", "es-MX", "  es  "]) {
    assert.equal(resolveLanguage(bad).ok, false, `se esperaba inválido: "${bad}"`);
  }
});

// --- Modo (real/fixture) ---------------------------------------------------

test("modo: undefined o vacío usa el default (fixture)", () => {
  assert.deepEqual(resolveMode(undefined), { ok: true, value: DEFAULT_MODE });
  assert.deepEqual(resolveMode(""), { ok: true, value: DEFAULT_MODE });
});

test("modo: real/fixture son válidos", () => {
  assert.deepEqual(resolveMode("real"), { ok: true, value: "real" });
  assert.deepEqual(resolveMode("fixture"), { ok: true, value: "fixture" });
});

test("modo: cualquier otro valor es inválido", () => {
  for (const bad of ["REAL", "Fixture", "claude", "mock"]) {
    assert.equal(resolveMode(bad).ok, false, `se esperaba inválido: "${bad}"`);
  }
});

// --- Duración ---------------------------------------------------------------

test("duración: undefined o vacía usa el default", () => {
  assert.deepEqual(resolveDurationSeconds(undefined), { ok: true, value: DEFAULT_DURATION_SECONDS });
  assert.deepEqual(resolveDurationSeconds(""), { ok: true, value: DEFAULT_DURATION_SECONDS });
});

test("duración: valores válidos dentro del rango", () => {
  assert.deepEqual(resolveDurationSeconds("30"), { ok: true, value: 30 });
  assert.deepEqual(resolveDurationSeconds("90"), { ok: true, value: 90 });
  assert.deepEqual(resolveDurationSeconds(String(MAX_DURATION_SECONDS)), {
    ok: true,
    value: MAX_DURATION_SECONDS,
  });
});

test("duración: no numérica es inválida", () => {
  for (const bad of ["treinta", "30s", "NaN", "--"]) {
    assert.equal(resolveDurationSeconds(bad).ok, false, `se esperaba inválido: "${bad}"`);
  }
});

test("duración: fuera del mínimo (<=0) es inválida", () => {
  assert.equal(resolveDurationSeconds("0").ok, false);
  assert.equal(resolveDurationSeconds("-5").ok, false);
});

test("duración: fuera del máximo (>120) es inválida", () => {
  assert.equal(resolveDurationSeconds(String(MAX_DURATION_SECONDS + 1)).ok, false);
  assert.equal(resolveDurationSeconds("999").ok, false);
});

// --- resolveSeedInput (combinación) -----------------------------------------

test("resolveSeedInput: todo por defecto reproduce el comportamiento original", () => {
  const result = resolveSeedInput({});
  assert.deepEqual(result, {
    ok: true,
    value: {
      topic: DEFAULT_TOPIC,
      style: DEFAULT_STYLE,
      language: DEFAULT_LANGUAGE,
      mode: DEFAULT_MODE,
      durationSeconds: DEFAULT_DURATION_SECONDS,
    },
  });
});

test("resolveSeedInput: combinación real solicitada por el usuario", () => {
  const result = resolveSeedInput({
    topic: "Los resultados tienen un precio",
    language: "es",
    mode: "real",
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value.topic === "Los resultados tienen un precio");
  assert.ok(result.ok && result.value.mode === "real");
});

test("resolveSeedInput: se detiene en el primer campo inválido", () => {
  const result = resolveSeedInput({ topic: "   ", language: "fr" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.toLowerCase().includes("tema"));
});

// --- resolveScriptProvider ---------------------------------------------------

test("resolveScriptProvider: modo fixture siempre devuelve el proveedor fixture, sin mirar la API key", async () => {
  const result = await resolveScriptProvider("fixture", {
    hasAnthropicKey: false,
    resolveRealProvider: () => {
      throw new Error("no debería llamarse en modo fixture");
    },
    fixtureProvider: { name: "fixture" },
  });
  assert.deepEqual(result, { ok: true, value: { name: "fixture" } });
});

test("resolveScriptProvider: modo real con API key y proveedor 'anthropic' resuelto → ok", async () => {
  const result = await resolveScriptProvider("real", {
    hasAnthropicKey: true,
    resolveRealProvider: () => ({ name: "anthropic" }),
    fixtureProvider: { name: "fixture" },
  });
  assert.deepEqual(result, { ok: true, value: { name: "anthropic" } });
});

test("resolveScriptProvider: modo real sin ANTHROPIC_API_KEY falla explícito, sin intentar resolver el proveedor", async () => {
  let resolveRealProviderCalled = false;
  const result = await resolveScriptProvider("real", {
    hasAnthropicKey: false,
    resolveRealProvider: () => {
      resolveRealProviderCalled = true;
      return { name: "anthropic" };
    },
    fixtureProvider: { name: "fixture" },
  });
  assert.equal(result.ok, false);
  assert.equal(resolveRealProviderCalled, false);
  assert.ok(!result.ok && result.reason.includes("ANTHROPIC_API_KEY"));
});

test("resolveScriptProvider: modo real pero el proveedor resuelto no es 'anthropic' → falla, no cae al fixture", async () => {
  const result = await resolveScriptProvider("real", {
    hasAnthropicKey: true,
    resolveRealProvider: () => ({ name: "fixture" }), // p. ej. SCRIPT_PROVIDER mal configurada
    fixtureProvider: { name: "fixture" },
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes('no "anthropic"'));
});

// --- buildVideoRequestInsert -------------------------------------------------

test("buildVideoRequestInsert arma el payload exacto esperado por video_requests", () => {
  const payload = buildVideoRequestInsert({
    userId: "user-1",
    topic: "Los resultados tienen un precio",
    style: "Motivacional",
    durationSeconds: 30,
    language: "es",
    script: { title: "t", segments: [] },
  });

  assert.equal(payload.user_id, "user-1");
  assert.equal(payload.topic, "Los resultados tienen un precio");
  assert.equal(payload.style, "Motivacional");
  assert.equal(payload.duration_seconds, 30);
  assert.equal(payload.language, "es");
  assert.equal(payload.status, "processing");
  assert.deepEqual(payload.script_json, { title: "t", segments: [] });
  assert.equal(payload.render_attempts, 0);
  assert.equal(payload.render_worker, "github-actions-manual-test");
  assert.ok(typeof payload.render_started_at === "string" && !Number.isNaN(Date.parse(payload.render_started_at)));
});

test("buildVideoRequestInsert respeta un render_worker distinto si se pasa explícito", () => {
  const payload = buildVideoRequestInsert({
    userId: "user-1",
    topic: "t",
    style: "s",
    durationSeconds: 30,
    language: "en",
    script: null,
    renderWorker: "custom-worker",
  });
  assert.equal(payload.render_worker, "custom-worker");
});

// --- seedTestRequest (orquestación, con fakes en memoria — sin Supabase real) ---

const RESOLVED: ResolvedSeedInput = {
  topic: "Los resultados tienen un precio",
  style: "Motivacional",
  language: "es",
  mode: "fixture",
  durationSeconds: 30,
};

function fakeScriptProvider(name = "fixture") {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    generateScript: async () => {
      calls += 1;
      return { title: "t", segments: [{ text: "hola", visualQuery: "x" }] };
    },
  };
}

test("seedTestRequest: invocación normal inserta exactamente una solicitud", async () => {
  let insertCalls = 0;
  const provider = fakeScriptProvider();

  const outcome = await seedTestRequest(RESOLVED, provider, {
    getFirstUserId: async () => "user-1",
    createInternalTestUser: async () => {
      throw new Error("no debería llamarse — ya hay un usuario");
    },
    findRecentDuplicate: async () => null,
    insertVideoRequest: async () => {
      insertCalls += 1;
      return "req-123";
    },
  });

  assert.equal(insertCalls, 1);
  assert.equal(provider.calls(), 1);
  assert.deepEqual(outcome, { requestId: "req-123", reused: false, scriptProviderName: "fixture" });
});

test("seedTestRequest: crea un usuario interno solo si no hay ninguno", async () => {
  let createUserCalls = 0;
  const provider = fakeScriptProvider();

  await seedTestRequest(RESOLVED, provider, {
    getFirstUserId: async () => null,
    createInternalTestUser: async () => {
      createUserCalls += 1;
      return "user-nuevo";
    },
    findRecentDuplicate: async ({ userId }) => {
      assert.equal(userId, "user-nuevo");
      return null;
    },
    insertVideoRequest: async () => "req-1",
  });

  assert.equal(createUserCalls, 1);
});

test("seedTestRequest: si hay un duplicado reciente, reutiliza su id y NO inserta ni genera guion", async () => {
  let insertCalls = 0;
  const provider = fakeScriptProvider();

  const outcome = await seedTestRequest(RESOLVED, provider, {
    getFirstUserId: async () => "user-1",
    createInternalTestUser: async () => {
      throw new Error("no debería llamarse");
    },
    findRecentDuplicate: async () => "req-existente",
    insertVideoRequest: async () => {
      insertCalls += 1;
      return "req-nuevo";
    },
  });

  assert.equal(insertCalls, 0);
  assert.equal(provider.calls(), 0);
  assert.deepEqual(outcome, { requestId: "req-existente", reused: true, scriptProviderName: "fixture" });
});

test("seedTestRequest: la ventana de duplicados usa DUPLICATE_WINDOW_MS hacia atrás desde `now`", async () => {
  const fixedNow = new Date("2026-09-15T12:00:00.000Z");
  let receivedSinceISO = "";

  await seedTestRequest(RESOLVED, fakeScriptProvider(), {
    getFirstUserId: async () => "user-1",
    createInternalTestUser: async () => "unused",
    findRecentDuplicate: async ({ sinceISO }) => {
      receivedSinceISO = sinceISO;
      return null;
    },
    insertVideoRequest: async () => "req-1",
    now: () => fixedNow,
  });

  assert.equal(receivedSinceISO, "2026-09-15T11:50:00.000Z");
});

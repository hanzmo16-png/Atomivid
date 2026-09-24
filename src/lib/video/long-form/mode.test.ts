import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRealModeConfirmed,
  computePaidApisCalled,
  isRealModeConfirmed,
  LongFormRealModeNotConfirmedError,
  LongFormRealProviderMissingError,
  resolveLongFormProviders,
} from "./mode";

test("simulation SIEMPRE devuelve proveedores fixture, incluso con env vars de proveedor real configuradas", () => {
  const env = {
    VOICE_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "fake-key-presente",
    IMAGE_PROVIDER: "openai",
    OPENAI_API_KEY: "fake-key-presente",
    MUSIC_PROVIDER: "beatoven",
    BEATOVEN_API_KEY: "fake-key-presente",
  };
  const providers = resolveLongFormProviders("simulation", env);
  assert.equal(providers.voiceProvider.name, "fixture");
  assert.equal(providers.footageProvider.name, "fixture");
  assert.equal(providers.musicProvider.name, "fixture");
  assert.equal(providers.imageProvider.name, "fixture");
});

test("computePaidApisCalled es false para el set de simulation", () => {
  const providers = resolveLongFormProviders("simulation", {});
  assert.equal(computePaidApisCalled(providers), false);
});

test("isRealModeConfirmed exige el valor exacto, no cualquier verdad truthy", () => {
  assert.equal(isRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "1" }), false);
  assert.equal(isRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "true" }), false);
  assert.equal(isRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "yes" }), false);
  assert.equal(isRealModeConfirmed({}), false);
  assert.equal(isRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" }), true);
});

test("assertRealModeConfirmed lanza LongFormRealModeNotConfirmedError sin la confirmación exacta", () => {
  assert.throws(() => assertRealModeConfirmed({}), LongFormRealModeNotConfirmedError);
  assert.throws(() => assertRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "1" }), LongFormRealModeNotConfirmedError);
  assert.doesNotThrow(() => assertRealModeConfirmed({ LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" }));
});

test("resolveLongFormProviders('real') lanza sin confirmación, sin importar qué proveedores estén configurados", () => {
  assert.throws(
    () => resolveLongFormProviders("real", { ELEVENLABS_API_KEY: "fake-key" }),
    LongFormRealModeNotConfirmedError,
  );
});

test("resolveLongFormProviders('real') con confirmación explícita pero SIN credenciales lanza LongFormRealProviderMissingError — nunca degrada en silencio a fixture", () => {
  const savedEnv = {
    VOICE_PROVIDER: process.env.VOICE_PROVIDER,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  };
  delete process.env.VOICE_PROVIDER;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    // Sin ELEVENLABS_API_KEY, getVoiceProvider() resuelve a fixture — el
    // modo real de Long Form debe detectar esto y lanzar, nunca continuar
    // en silencio con contenido de fixture disfrazado de "real".
    assert.throws(
      () => resolveLongFormProviders("real", { LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" }),
      LongFormRealProviderMissingError,
    );
  } finally {
    if (savedEnv.VOICE_PROVIDER === undefined) delete process.env.VOICE_PROVIDER;
    else process.env.VOICE_PROVIDER = savedEnv.VOICE_PROVIDER;
    if (savedEnv.ELEVENLABS_API_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedEnv.ELEVENLABS_API_KEY;
  }
});

test("LongFormRealProviderMissingError nombra la etapa y la variable de entorno faltante en el mensaje", () => {
  const savedEnv = {
    VOICE_PROVIDER: process.env.VOICE_PROVIDER,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  };
  delete process.env.VOICE_PROVIDER;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    try {
      resolveLongFormProviders("real", { LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" });
      assert.fail("debería haber lanzado");
    } catch (err) {
      assert.ok(err instanceof LongFormRealProviderMissingError);
      assert.match((err as Error).message, /voz/);
      assert.match((err as Error).message, /ELEVENLABS_API_KEY/);
    }
  } finally {
    if (savedEnv.VOICE_PROVIDER === undefined) delete process.env.VOICE_PROVIDER;
    else process.env.VOICE_PROVIDER = savedEnv.VOICE_PROVIDER;
    if (savedEnv.ELEVENLABS_API_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedEnv.ELEVENLABS_API_KEY;
  }
});

test("resolveLongFormProviders('real') con TODAS las credenciales reales presentes SÍ delega en los proveedores reales, sin lanzar", () => {
  const keys = ["VOICE_PROVIDER", "ELEVENLABS_API_KEY", "FOOTAGE_PROVIDER", "PEXELS_API_KEY", "IMAGE_PROVIDER", "OPENAI_API_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.VOICE_PROVIDER = "elevenlabs";
  process.env.ELEVENLABS_API_KEY = "fake-key-solo-para-resolver-el-proveedor";
  process.env.FOOTAGE_PROVIDER = "pexels";
  process.env.PEXELS_API_KEY = "fake-key-solo-para-resolver-el-proveedor";
  process.env.IMAGE_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "fake-key-solo-para-resolver-el-proveedor";
  try {
    const providers = resolveLongFormProviders("real", { LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" });
    assert.equal(providers.voiceProvider.name, "elevenlabs");
    assert.equal(providers.footageProvider.name, "pexels-video-first");
    assert.equal(providers.imageProvider.name, "openai");
    assert.equal(computePaidApisCalled(providers), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("computePaidApisCalled trata Pexels y la biblioteca curada como gratis, pero cualquier otro nombre como pagado", () => {
  const base = resolveLongFormProviders("simulation", {});
  assert.equal(
    computePaidApisCalled({ ...base, footageProvider: { name: "pexels-video-first" } as never }),
    false,
  );
  assert.equal(
    computePaidApisCalled({ ...base, musicProvider: { name: "curated-library" } as never }),
    false,
  );
  assert.equal(
    computePaidApisCalled({ ...base, voiceProvider: { name: "elevenlabs" } as never }),
    true,
  );
  assert.equal(
    computePaidApisCalled({ ...base, imageProvider: { name: "openai" } as never }),
    true,
  );
});

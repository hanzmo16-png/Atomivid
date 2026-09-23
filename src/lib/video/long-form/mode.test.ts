import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRealModeConfirmed,
  computePaidApisCalled,
  isRealModeConfirmed,
  LongFormRealModeNotConfirmedError,
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

test("resolveLongFormProviders('real') con confirmación explícita SÍ delega en los getters reales (sin credenciales pagas, caen a fixture/gratis igual que Shorts)", () => {
  const providers = resolveLongFormProviders("real", { LONG_FORM_REAL_RUN_CONFIRM: "YES_SPEND_REAL_MONEY" });
  // Sin ELEVENLABS_API_KEY/OPENAI_API_KEY/PEXELS_API_KEY configuradas, los
  // getters compartidos con Shorts caen a fixture — comportamiento
  // heredado, no nuevo. La música curada no necesita clave (es gratis) y
  // sí puede resolver a "curated-library" en vez de "fixture".
  assert.equal(providers.voiceProvider.name, "fixture");
  assert.equal(providers.footageProvider.name, "fixture");
  assert.equal(providers.imageProvider.name, "fixture");
  assert.equal(computePaidApisCalled(providers), false);
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

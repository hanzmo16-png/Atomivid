import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMusicPrompt } from "./beatoven";
import { getMusicProvider } from "./index";

const KEYS = ["MUSIC_PROVIDER", "BEATOVEN_API_KEY", "MUSIC_TRACK_URLS", "MUSIC_TRACK_URL"];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("buildMusicPrompt produce un prompt descriptivo, sin vocales/karaoke y con la duración objetivo", () => {
  const prompt = buildMusicPrompt({ durationSeconds: 30, style: "Motivacional", scriptText: "levántate y sigue" });
  assert.match(prompt, /no vocals/);
  assert.match(prompt, /30 seconds/);
  assert.match(prompt, /underscore/);
});

test("buildMusicPrompt nunca lanza aunque falten style/topic/scriptText", () => {
  assert.doesNotThrow(() => buildMusicPrompt({ durationSeconds: 15 }));
});

test("MUSIC_PROVIDER=beatoven sin BEATOVEN_API_KEY cae al proveedor curado/fixture, nunca falla al seleccionar", async () => {
  await withEnv({ MUSIC_PROVIDER: "beatoven" }, () => {
    const provider = getMusicProvider();
    assert.notEqual(provider.name, "beatoven");
  });
});

test("MUSIC_PROVIDER=beatoven con clave presente sí selecciona beatoven", async () => {
  await withEnv({ MUSIC_PROVIDER: "beatoven", BEATOVEN_API_KEY: "fake-key" }, () => {
    assert.equal(getMusicProvider().name, "beatoven");
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  MUSIC_LIBRARY_BUCKET,
  MUSIC_LIBRARY_SIGNED_URL_TTL_SECONDS,
  normalizeObjectPath,
  signMusicLibraryUrl,
} from "./storage";
import { MusicObjectNotFoundError, MusicProviderError, MusicSigningError } from "./errors";

// Mock mínimo con la misma forma que el cliente de Supabase real en el
// único método que storage.ts usa — no depende de red ni de credenciales.
function mockSupabase(createSignedUrl: (path: string, ttl: number) => Promise<unknown>) {
  return {
    storage: {
      from(bucket: string) {
        assert.equal(bucket, MUSIC_LIBRARY_BUCKET, "debe usar el bucket de la biblioteca de música");
        return { createSignedUrl };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("normalizeObjectPath quita barras iniciales", () => {
  assert.equal(normalizeObjectPath("/pixabay-1.mp3"), "pixabay-1.mp3");
  assert.equal(normalizeObjectPath("pixabay-1.mp3"), "pixabay-1.mp3");
  assert.equal(normalizeObjectPath("  pixabay-1.mp3  "), "pixabay-1.mp3");
});

test("normalizeObjectPath rechaza una ruta vacía", () => {
  assert.throws(() => normalizeObjectPath("   "), MusicProviderError);
});

test("signMusicLibraryUrl devuelve la URL firmada en el camino feliz", async () => {
  const service = mockSupabase(async (path, ttl) => {
    assert.equal(path, "pixabay-335162.mp3");
    assert.equal(ttl, MUSIC_LIBRARY_SIGNED_URL_TTL_SECONDS);
    return { data: { signedUrl: "https://example.supabase.co/signed/pixabay-335162.mp3?token=abc" }, error: null };
  });

  const url = await signMusicLibraryUrl(service, "pixabay-335162.mp3");
  assert.equal(url, "https://example.supabase.co/signed/pixabay-335162.mp3?token=abc");
});

test("nunca pide más de 1 hora de duración (tope explícito)", () => {
  assert.equal(MUSIC_LIBRARY_SIGNED_URL_TTL_SECONDS, 3600);
});

test("normaliza la ruta antes de pedir la firma", async () => {
  const service = mockSupabase(async (path) => {
    assert.equal(path, "pixabay-335162.mp3");
    return { data: { signedUrl: "https://example.com/x" }, error: null };
  });

  await signMusicLibraryUrl(service, "/pixabay-335162.mp3");
});

test("error 404 del storage se traduce a MusicObjectNotFoundError", async () => {
  const service = mockSupabase(async () => ({
    data: null,
    error: { message: "Object not found", status: 404, code: "NoSuchKey" },
  }));

  await assert.rejects(
    () => signMusicLibraryUrl(service, "no-existe.mp3"),
    MusicObjectNotFoundError,
  );
});

test("error genérico de firma se traduce a MusicSigningError, no a 'no encontrado'", async () => {
  const service = mockSupabase(async () => ({
    data: null,
    error: { message: "Internal error", status: 500 },
  }));

  await assert.rejects(
    () => signMusicLibraryUrl(service, "pixabay-335162.mp3"),
    MusicSigningError,
  );
});

test("respuesta vacía sin error también se trata como fallo de firma", async () => {
  const service = mockSupabase(async () => ({ data: null, error: null }));

  await assert.rejects(
    () => signMusicLibraryUrl(service, "pixabay-335162.mp3"),
    MusicSigningError,
  );
});

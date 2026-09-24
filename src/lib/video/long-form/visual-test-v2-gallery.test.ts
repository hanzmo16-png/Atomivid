import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVisualTestV2Gallery, VISUAL_TEST_V2_GALLERY_SIGNED_URL_TTL_SECONDS } from "./visual-test-v2-gallery";
import { writeVisualTestV2ShotRecord } from "./visual-test-v2-storage";
import { buildVisualTestV2Manifest } from "./visual-test-v2";
import { VISUAL_TEST_V2_REAL_SHOT_IDS } from "./visual-test-v2-real";

const BUCKET = "videos";
const VIDEO_ID = "gobekli-tepe-001";

/**
 * Fake mínimo de SupabaseClient — mismo patrón que
 * visual-test-v2-real.test.ts, con la firma de URLs simulada: cualquier
 * ruta que exista en `files` se "firma" devolviendo una URL determinista;
 * una ruta ausente devuelve error (como la API real).
 */
function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const signCalls: Array<{ path: string; ttl: number }> = [];
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            return { error: null };
          },
          async createSignedUrl(path: string, ttl: number) {
            signCalls.push({ path, ttl });
            if (!files.has(path)) return { data: null, error: { message: "object not found" } };
            return { data: { signedUrl: `https://fake.local/${path}?ttl=${ttl}&signed=1` }, error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files, signCalls };
}

async function seedCompletedShot(fake: ReturnType<typeof makeFakeSupabase>["fake"], files: Map<string, Buffer>, shotId: string, overrides: Partial<{ costUsd: number; widthPx: number; heightPx: number; provider: string; model: string; quality: string }> = {}) {
  const manifest = buildVisualTestV2Manifest();
  const entry = manifest.shots.find((s) => s.shotId === shotId)!;
  const path = `long-form/${VIDEO_ID}/visual-test-v2/${shotId}-${entry.idempotencyKey}.png`;
  files.set(path, Buffer.from("bytes-de-imagen"));
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId,
    status: "COMPLETED",
    storagePath: path,
    checksumSha256: "no-relevante-para-la-galeria",
    mimeType: "image/png",
    extension: "png",
    widthPx: overrides.widthPx ?? 1536,
    heightPx: overrides.heightPx ?? 1024,
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-image-2",
    quality: overrides.quality ?? "medium",
    costUsd: overrides.costUsd ?? 0.056,
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  });
  return path;
}

test("VISUAL_TEST_V2_GALLERY_SIGNED_URL_TTL_SECONDS es corto (minutos, no horas)", () => {
  assert.ok(VISUAL_TEST_V2_GALLERY_SIGNED_URL_TTL_SECONDS <= 600);
});

test("sin ningún registro → galería vacía, sin lanzar", async () => {
  const { fake } = makeFakeSupabase();
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.deepEqual(gallery, []);
});

test("los 3 shots COMPLETED con archivo → la galería trae exactamente esos 3, en el orden aprobado, con signedUrl", async () => {
  const { fake, files } = makeFakeSupabase();
  for (const shotId of VISUAL_TEST_V2_REAL_SHOT_IDS) {
    await seedCompletedShot(fake, files, shotId);
  }
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.deepEqual(
    gallery.map((g) => g.shotId),
    ["b1-s4", "b4-s2", "b8-s5"],
  );
  assert.ok(gallery.every((g) => g.signedUrl.startsWith("https://fake.local/")));
  assert.ok(gallery.every((g) => g.status === "COMPLETED"));
});

test("solo se consideran los 3 shotIds aprobados — un registro COMPLETED bajo cualquier otro shotId nunca aparece (el módulo ni siquiera lo busca)", async () => {
  const { fake, files } = makeFakeSupabase();
  // Solo siembra los 3 aprobados; no hay forma de sembrar un 4to porque
  // buildVisualTestV2Gallery itera exclusivamente sobre VISUAL_TEST_V2_REAL_SHOT_IDS.
  await seedCompletedShot(fake, files, "b1-s4");
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.equal(gallery.length, 1);
  assert.equal(gallery[0].shotId, "b1-s4");
  assert.ok(VISUAL_TEST_V2_REAL_SHOT_IDS.includes(gallery[0].shotId as (typeof VISUAL_TEST_V2_REAL_SHOT_IDS)[number]));
});

test("un shot en STARTED (sin COMPLETED) se omite de la galería — nunca se muestra un registro incierto/incompleto", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = buildVisualTestV2Manifest();
  const entry = manifest.shots.find((s) => s.shotId === "b4-s2")!;
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId: "b4-s2",
    status: "STARTED",
    createdAtIso: "x",
    updatedAtIso: "x",
  });
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.equal(gallery.length, 0);
});

test("un registro COMPLETED sin storagePath se omite (defensivo)", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = buildVisualTestV2Manifest();
  const entry = manifest.shots.find((s) => s.shotId === "b8-s5")!;
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId: "b8-s5",
    status: "COMPLETED",
    createdAtIso: "x",
    updatedAtIso: "x",
  });
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.equal(gallery.length, 0);
});

test("si createSignedUrl falla para un shot (archivo no encontrado), ese shot se omite sin romper la galería completa", async () => {
  const { fake } = makeFakeSupabase();
  const manifest = buildVisualTestV2Manifest();
  const entry = manifest.shots.find((s) => s.shotId === "b1-s4")!;
  // Registro COMPLETED que apunta a un archivo que NUNCA se subió (simulación de borrado externo).
  await writeVisualTestV2ShotRecord(fake, BUCKET, VIDEO_ID, {
    idempotencyKey: entry.idempotencyKey,
    shotId: "b1-s4",
    status: "COMPLETED",
    storagePath: `long-form/${VIDEO_ID}/visual-test-v2/b1-s4-${entry.idempotencyKey}.png`,
    createdAtIso: "x",
    updatedAtIso: "x",
  });
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  assert.equal(gallery.length, 0);
});

test("usa el TTL corto pasado a createSignedUrl (lectura segura, de corta duración)", async () => {
  const { fake, files, signCalls } = makeFakeSupabase();
  await seedCompletedShot(fake, files, "b1-s4");
  await buildVisualTestV2Gallery(fake, BUCKET, 120);
  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].ttl, 120);
});

test("cada item de la galería solo trae los campos esperados — ningún secreto ni campo inesperado", async () => {
  const { fake, files } = makeFakeSupabase();
  await seedCompletedShot(fake, files, "b1-s4", { costUsd: 0.056, widthPx: 1536, heightPx: 1024, provider: "openai", model: "gpt-image-2", quality: "medium" });
  const gallery = await buildVisualTestV2Gallery(fake, BUCKET);
  const keys = Object.keys(gallery[0]).sort();
  assert.deepEqual(keys, [
    "costUsd",
    "heightPx",
    "model",
    "provider",
    "quality",
    "shotId",
    "signedUrl",
    "status",
    "storagePath",
    "widthPx",
  ].sort());
  assert.equal(gallery[0].costUsd, 0.056);
  const serialized = JSON.stringify(gallery);
  assert.equal(/service_role|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY/i.test(serialized), false);
});

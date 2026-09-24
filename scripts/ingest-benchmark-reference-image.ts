/**
 * Sube REALMENTE la imagen de referencia ya APROBADA de "Pillar Transport"
 * a Supabase Storage y guarda la referencia canónica — completa el paso
 * que scripts/preflight-p2b-reference-image.ts dejó pendiente por falta de
 * credenciales en la sesión interactiva (ver informe P2B preparation).
 *
 * NO se ejecutó en la sesión de Claude Code que lo escribió (no hay
 * SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL con permisos de
 * escritura en ese entorno) — listo para correr donde SÍ existan esas
 * credenciales (Vercel/CI/local de Hans con el service role key real).
 *
 * Requiere:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Uso:
 *   npx tsx scripts/ingest-benchmark-reference-image.ts
 *
 * NO genera ningún video. NO llama a Google/Veo/Kling. Solo sube UN
 * archivo de imagen ya aprobado a Storage.
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "[ingest-benchmark-reference-image] Faltan credenciales: NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
        "Este script NUNCA sube nada sin ambas — no hay fallback silencioso.",
    );
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const { ingestApprovedReferenceImage, ReferenceImageInvalidError } = await import("../src/lib/video/long-form/ai-video-reference-image");
  const { ACTIVE_BENCHMARK_SHOTS } = await import("../src/lib/video/long-form/ai-video-benchmark-v2-active");

  const shot = ACTIVE_BENCHMARK_SHOTS.find((s) => s.shotId === "bench-v2-a-pillar-transport");
  if (!shot?.referenceImageSpec.approval) {
    console.error("[ingest-benchmark-reference-image] El shot Pillar Transport no tiene una imagen de referencia aprobada registrada — abortando.");
    process.exit(1);
  }
  const approval = shot.referenceImageSpec.approval;

  const imagePath = join(__dirname, "..", approval.sourceImagePath);
  const buffer = readFileSync(imagePath);

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  console.log(`[ingest-benchmark-reference-image] Subiendo ${approval.sourceImagePath} (${buffer.byteLength} bytes) a Supabase Storage...`);
  try {
    const asset = await ingestApprovedReferenceImage(supabase, buffer, {
      benchmarkId: shot.benchmarkId,
      shotId: shot.shotId,
      declaredMimeType: "image/png",
    });
    console.log(`[ingest-benchmark-reference-image] Subida completada.`);
    console.log(`  bucket: ${asset.bucket}`);
    console.log(`  path: ${asset.storagePath}`);
    console.log(`  checksum: ${asset.checksumSha256}`);
    console.log(`  dimensiones: ${asset.widthPx}x${asset.heightPx}`);
    console.log(
      `\n  Próximo paso manual: generar una URL firmada/pública de Supabase Storage para "${asset.storagePath}" y usarla como ` +
        `referenceImageUrl al llamar a veoVideoProvider.generateVideo() en P2B — este script NUNCA genera esa URL ni llama a Veo.`,
    );
  } catch (err) {
    if (err instanceof ReferenceImageInvalidError) {
      console.error(`[ingest-benchmark-reference-image] Imagen inválida, NO se subió nada: ${err.reason}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("[ingest-benchmark-reference-image] fallo:", err);
  process.exit(1);
});

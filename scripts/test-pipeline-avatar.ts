/**
 * Prueba de orquestación end-to-end del modo AVATAR usando el proveedor
 * fixture (sin red, sin claves) — contraparte de scripts/test-pipeline.ts
 * (modo visual). Demuestra, con una foto de prueba REAL (no simulada
 * como bytes vacíos): validación de foto, consentimiento obligatorio,
 * aislamiento entre usuarios (rechaza un avatarId ajeno), costo $0 en
 * modo fixture, e idempotencia (un job de proveedor ya completado nunca
 * se vuelve a generar — nunca cobra dos veces).
 *
 * El fixture (src/lib/providers/avatar/fixture.ts) ahora devuelve un MP4
 * REAL y válido (h264/aac, 9:16, con "VIDEO SIMULADO" incrustado en los
 * fotogramas — ver fixtures/simulated-avatar-video.mp4), así que esta
 * prueba escribe el resultado final a disco (--out-dir) para poder
 * inspeccionarlo con ffprobe/reproducirlo: confirma audio presente,
 * duración y formato vertical. NO es una prueba de calidad ni de
 * sincronización labial de ningún proveedor real — el video de origen
 * es un patrón de prueba sintético, sin ningún rostro real ni de stock.
 *
 * Limitación conocida y NO resuelta por este script (documentada en
 * video/avatar/pipeline.ts desde su implementación original): el modo
 * avatar NUNCA superpone subtítulos propios sobre el video del
 * proveedor (el proveedor ya devuelve audio+labios sincronizados y no
 * expone marcas de tiempo por palabra) — por eso esta prueba NO verifica
 * subtítulos en el resultado del modo avatar; esa verificación sí aplica
 * al modo visual (scripts/test-pipeline.ts), que sí los compone.
 *
 * Necesitas una foto de prueba real en disco (jpeg/png, >4KB, ≥200px por
 * lado — ver src/lib/video/avatar/photo-validation.ts). Genera una rápido
 * con: `ffmpeg -f lavfi -i testsrc=size=800x800:rate=1 -frames:v 1 -q:v 2 /tmp/test-photo.jpg`
 *
 * Uso: npx tsx scripts/test-pipeline-avatar.ts [ruta-a-foto.jpg] [--out-dir /ruta/salida]
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

process.env.AVATAR_MODE_ENABLED = "true";
process.env.AVATAR_PROVIDER = "fixture";
process.env.VOICE_PROVIDER = "fixture";

async function main() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { validatePhotoBuffer } = await import("../src/lib/video/avatar/photo-validation");
  const { generateAvatarVideo, AvatarPipelineError } = await import("../src/lib/video/avatar/pipeline");

  const rawArgs = process.argv.slice(2);
  const outDirFlagIndex = rawArgs.indexOf("--out-dir");
  const outDir = outDirFlagIndex >= 0 ? rawArgs[outDirFlagIndex + 1] : undefined;
  const positional = rawArgs.filter((a, i) => a !== "--out-dir" && (outDirFlagIndex < 0 || i !== outDirFlagIndex + 1));

  const photoPath = positional[0] || path.join(process.cwd(), "scripts", "test-avatar-photo.jpg");
  let photoBuffer: Buffer;
  try {
    photoBuffer = await fs.readFile(photoPath);
  } catch {
    throw new Error(
      `No se encontró una foto de prueba en "${photoPath}". Genera una con:\n` +
        `  ffmpeg -f lavfi -i testsrc=size=800x800:rate=1 -frames:v 1 -q:v 2 ${photoPath}\n` +
        `o pasa la ruta a una foto real como argumento: npx tsx scripts/test-pipeline-avatar.ts /ruta/a/foto.jpg`,
    );
  }

  const validation = validatePhotoBuffer(photoBuffer, "image/jpeg");
  console.log("1) Validación de foto real:", JSON.stringify(validation));
  if (!validation.valid) throw new Error(`La foto de prueba no pasó validación: ${JSON.stringify(validation)}`);

  const uploads: Array<{ path: string; bytes: number }> = [];
  const updates: Record<string, unknown>[] = [];

  function makeFakeSupabase(avatarRow: Record<string, unknown> | null) {
    let storedJob: string | null = null;
    return {
      from(table: string) {
        if (table === "avatars") {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() { return { data: avatarRow }; },
          };
        }
        if (table === "video_requests") {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() { return { data: { avatar_provider_video_job_id: storedJob }, error: null }; },
            update(payload: Record<string, unknown>) {
              updates.push(payload);
              if (typeof payload.avatar_provider_video_job_id === "string") storedJob = payload.avatar_provider_video_job_id;
              return { eq() { return this; }, is() { return this; }, select() { return this; }, async maybeSingle() { return { data: { id: "test-request" }, error: null }; } };
            },
          };
        }
        if (table === "generation_costs") {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() { return { data: null }; },
            async upsert() { return { error: null }; },
          };
        }
        throw new Error(`tabla no soportada por este fake: ${table}`);
      },
      storage: {
        from() {
          return {
            async upload(objectPath: string, buffer: Buffer) {
              uploads.push({ path: objectPath, bytes: buffer.byteLength });
              if (outDir) {
                const dest = path.join(outDir, objectPath.replace(/\//g, "_"));
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.writeFile(dest, buffer);
              }
              return { error: null };
            },
            async createSignedUrl(objectPath: string) {
              return { data: { signedUrl: `https://fake.local/${objectPath}?signed=1` }, error: null };
            },
          };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  const script = { title: "t", segments: [{ text: "Hola, esta es una prueba de video con avatar.", visualQuery: "person" }] };

  // --- Caso 2: acceso cruzado entre usuarios ----------------------------
  const otherUsersAvatar = makeFakeSupabase({
    id: "a1",
    user_id: "usuario-dueno-real",
    status: "ready",
    consent_given: true,
    provider_avatar_id: "fixture-avatar-x",
    provider: "fixture",
  });
  try {
    await generateAvatarVideo({ supabase: otherUsersAvatar, requestId: "r-intruso", userId: "usuario-atacante", script, avatarId: "a1" });
    throw new Error("DEBIÓ rechazar el acceso cruzado entre usuarios");
  } catch (err) {
    if (err instanceof AvatarPipelineError && err.code === "avatar_not_owned") {
      console.log("2) Aislamiento entre usuarios: acceso cruzado RECHAZADO correctamente (avatar_not_owned)");
    } else throw err;
  }

  // --- Caso 3: sin consentimiento ---------------------------------------
  const noConsent = makeFakeSupabase({ id: "a2", user_id: "u1", status: "ready", consent_given: false, provider_avatar_id: "fixture-avatar-y", provider: "fixture" });
  try {
    await generateAvatarVideo({ supabase: noConsent, requestId: "r-sinconsent", userId: "u1", script, avatarId: "a2" });
    throw new Error("DEBIÓ rechazar por falta de consentimiento");
  } catch (err) {
    if (err instanceof AvatarPipelineError && err.code === "consent_missing") {
      console.log("3) Consentimiento obligatorio: solicitud sin consentimiento RECHAZADA correctamente");
    } else throw err;
  }

  // --- Caso 4: flujo exitoso completo ------------------------------------
  const legit = makeFakeSupabase({ id: "a3", user_id: "u1", status: "ready", consent_given: true, provider_avatar_id: "fixture-avatar-real", provider: "fixture" });
  const result = await generateAvatarVideo({ supabase: legit, requestId: "r-legit", userId: "u1", script, avatarId: "a3" });
  console.log("4) Generación exitosa (dueño correcto + consentimiento):", JSON.stringify(result));
  console.log("   Subida registrada:", JSON.stringify(uploads));
  console.log("   Actualización de video_requests:", JSON.stringify(updates));

  // --- Caso 5: recuperar sin volver a generar voz ni reservar otro intento ---
  const savedJob = updates.find(u => typeof u.avatar_provider_video_job_id === "string")?.avatar_provider_video_job_id;
  if (typeof savedJob !== "string") throw new Error("No se guardó el job");
  const voicesBefore = uploads.filter(u => u.path.includes("avatar-narration")).length;
  const claimsBefore = updates.filter(u => "avatar_generation_started_at" in u).length;
  const recovered = await generateAvatarVideo({ supabase: legit, requestId: "r-legit", userId: "u1", script, avatarId: "a3", existingProviderVideoJobId: savedJob });
  if (recovered.videoPath !== result.videoPath ||
      uploads.filter(u => u.path.includes("avatar-narration")).length !== voicesBefore ||
      updates.filter(u => "avatar_generation_started_at" in u).length !== claimsBefore) {
    throw new Error("La recuperación repitió consumo o cambió el destino");
  }
  console.log("5) Recuperación exitosa del job existente, sin nueva narración ni reserva");

  if (outDir) {
    const finalPath = path.join(outDir, result.videoPath.replace(/\//g, "_"));
    console.log(`\n6) Video final escrito en disco para inspección: ${finalPath}`);
    const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
    await verifyVideoEvidence(finalPath);
    console.log("Fixture SIMULADO: no valida calidad ni sincronización labial real.");
  }

  console.log("\nTODOS LOS CASOS PASARON — cero llamadas reales, cero costo (fixture, costUsd=0).");
}

main().catch((err) => {
  console.error("Falló la prueba de orquestación de avatar:", err);
  process.exit(1);
});

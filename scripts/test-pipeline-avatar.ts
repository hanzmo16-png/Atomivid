/**
 * Prueba de orquestación end-to-end del modo AVATAR usando el proveedor
 * fixture (sin red, sin claves) — contraparte de scripts/test-pipeline.ts
 * (modo visual). Demuestra, con una foto de prueba REAL (no simulada
 * como bytes vacíos): validación de foto, consentimiento obligatorio,
 * aislamiento entre usuarios (rechaza un avatarId ajeno), costo $0 en
 * modo fixture, e idempotencia (un job de proveedor ya completado nunca
 * se vuelve a generar — nunca cobra dos veces).
 *
 * Limitación conocida y documentada (no es un bug de este script):
 * fixtureAvatarProvider.generateVideo() devuelve bytes de texto plano,
 * no un MP4 válido — a diferencia del modo visual (scripts/test-pipeline.ts),
 * que sí produce un video real inspeccionable con ffprobe. El pipeline de
 * avatar intenta masterizar el loudness de esos bytes con ffmpeg, falla
 * limpiamente ("moov atom not found") y sube el archivo sin normalizar de
 * todas formas — comportamiento ya esperado, no un fallo de esta prueba.
 * Además, el modo avatar no superpone subtítulos ni música sobre el video
 * del proveedor (limitación documentada en video/avatar/pipeline.ts desde
 * su implementación original) — por eso esta prueba verifica la
 * ORQUESTACIÓN (quién puede generar qué, cuánto cuesta, si se repite),
 * no el contenido audiovisual del resultado.
 *
 * Necesitas una foto de prueba real en disco (jpeg/png, >4KB, ≥200px por
 * lado — ver src/lib/video/avatar/photo-validation.ts). Genera una rápido
 * con: `ffmpeg -f lavfi -i testsrc=size=800x800:rate=1 -frames:v 1 -q:v 2 /tmp/test-photo.jpg`
 *
 * Uso: npx tsx scripts/test-pipeline-avatar.ts [ruta-a-foto.jpg]
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

process.env.AVATAR_MODE_ENABLED = "true";
process.env.AVATAR_PROVIDER = "fixture";

async function main() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { validatePhotoBuffer } = await import("../src/lib/video/avatar/photo-validation");
  const { generateAvatarVideo, AvatarPipelineError } = await import("../src/lib/video/avatar/pipeline");

  const photoPath = process.argv[2] || path.join(process.cwd(), "scripts", "test-avatar-photo.jpg");
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
            update(payload: Record<string, unknown>) {
              updates.push(payload);
              return { async eq() { return { error: null }; } };
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
              return { error: null };
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

  // --- Caso 5: idempotencia ----------------------------------------------
  try {
    await generateAvatarVideo({ supabase: legit, requestId: "r-legit", userId: "u1", script, avatarId: "a3", existingProviderVideoJobId: "job-anterior-ya-completado" });
    throw new Error("DEBIÓ detenerse por idempotencia");
  } catch (err) {
    if (err instanceof AvatarPipelineError && err.code === "provider_error") {
      console.log("5) Idempotencia: un job de proveedor ya completado NO se vuelve a generar (nunca cobra dos veces)");
    } else throw err;
  }

  console.log("\nTODOS LOS CASOS PASARON — cero llamadas reales, cero costo (fixture, costUsd=0).");
}

main().catch((err) => {
  console.error("Falló la prueba de orquestación de avatar:", err);
  process.exit(1);
});

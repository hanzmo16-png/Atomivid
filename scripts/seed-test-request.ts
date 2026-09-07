/**
 * Crea una solicitud de prueba REAL en la base de datos de producción,
 * lista para que el worker de render la procese — solo para validar el
 * worker end-to-end sin depender de que alguien la cree manualmente desde
 * la UI. Corre exclusivamente dentro de GitHub Actions (nunca en el
 * sandbox de desarrollo, que no tiene salida de red hacia Supabase), con
 * las credenciales ya configuradas como secrets del repo — nadie ve ni
 * pega ninguna clave para esto.
 *
 * Usa el proveedor de guion "fixture" (determinístico, sin llamar a
 * Claude) porque ANTHROPIC_API_KEY no está configurada en este worker —
 * el guion generado por Claude ya se prueba por separado, en Vercel. Este
 * script solo valida voz (ElevenLabs) + footage (Pexels) + música + render
 * + Storage, que es lo nuevo que hay que probar.
 *
 * Asocia la solicitud a un usuario real ya existente en el proyecto
 * (el primero que encuentre vía la Admin API) para que aparezca en su
 * historial normal. Si el proyecto todavía no tiene ningún usuario
 * registrado (nadie se ha registrado aún en el sitio real), crea uno
 * sintético marcado como cuenta de prueba interna — así la validación
 * técnica del worker no depende de que alguien haya hecho login primero.
 * De cualquier forma respeta la restricción de clave foránea de
 * video_requests.user_id.
 *
 * Uso: npx tsx scripts/seed-test-request.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { fixtureScriptProvider } = await import("../src/lib/providers/script/fixture");

  const service = createServiceClient();

  const { data: usersData, error: usersError } = await service.auth.admin.listUsers({
    perPage: 1,
  });
  if (usersError) {
    throw new Error(`No se pudo consultar los usuarios existentes: ${usersError.message}`);
  }

  let userId = usersData?.users?.[0]?.id;
  if (!userId) {
    console.log(
      "No hay ningún usuario registrado todavía — creando una cuenta de prueba interna solo para esta validación técnica.",
    );
    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: `worker-test+${Date.now()}@atomivid-internal.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { atomivid_internal_test_account: true },
    });
    if (createError || !created?.user) {
      throw new Error(`No se pudo crear un usuario de prueba: ${createError?.message}`);
    }
    userId = created.user.id;
  }

  const topic = "[PRUEBA AUTOMÁTICA] Validación técnica del worker de Atomivid";
  const style = "Educativo";
  const durationSeconds = 30;

  const script = await fixtureScriptProvider.generateScript({ topic, style, durationSeconds });

  const { data: inserted, error: insertError } = await service
    .from("video_requests")
    .insert({
      user_id: userId,
      topic,
      style,
      duration_seconds: durationSeconds,
      status: "processing",
      script_json: script,
      render_attempts: 0,
      render_started_at: new Date().toISOString(),
      render_worker: "github-actions-manual-test",
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !inserted) {
    throw new Error(`No se pudo crear la solicitud de prueba: ${insertError?.message}`);
  }

  console.log(`REQUEST_ID=${inserted.id}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(githubOutput, `request_id=${inserted.id}\n`);
  }
}

main().catch((err) => {
  console.error("Fallo al crear la solicitud de prueba:", err);
  process.exit(1);
});

/**
 * Crea una solicitud de prueba REAL en la base de datos de producción,
 * lista para que el worker de render la procese — solo para validar el
 * worker end-to-end sin depender de que alguien la cree manualmente desde
 * la UI. Corre exclusivamente dentro de GitHub Actions (nunca en el
 * sandbox de desarrollo, que no tiene salida de red hacia Supabase), con
 * las credenciales ya configuradas como secrets del repo — nadie ve ni
 * pega ninguna clave para esto.
 *
 * Tema, idioma, estilo, duración y modo de guion son parametrizables (ver
 * .github/workflows/seed-test-request.yml, inputs del workflow_dispatch,
 * pasados por `env:` — nunca interpolados en el comando de shell, así un
 * tema con comillas/backticks no puede inyectar nada). La validación de
 * esos inputs y la orquestación (buscar/crear usuario, protección contra
 * duplicados, generar guion, insertar) viven en scripts/lib/seed-request.ts,
 * separadas de este archivo para poder probarlas con `node:test` sin
 * Supabase ni el SDK de Anthropic — ver scripts/lib/seed-request.test.ts.
 *
 * - SEED_MODE=fixture (por defecto): guion determinístico, sin llamar a
 *   Claude — para probar solo voz/footage/música/render sin gastar en LLM.
 * - SEED_MODE=real: exige ANTHROPIC_API_KEY y usa el proveedor real
 *   (Claude) — falla explícitamente si no se resuelve a "anthropic" (no
 *   cae en silencio al fixture).
 * Sin ninguna variable SEED_* configurada, el comportamiento es idéntico
 * al de antes de parametrizarlo (mismo tema/estilo/duración/modo fixture).
 *
 * Uso: npx tsx scripts/seed-test-request.ts
 * (opcionalmente con SEED_TOPIC, SEED_LANGUAGE, SEED_MODE, SEED_STYLE,
 * SEED_DURATION_SECONDS en el entorno)
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

import { resolveScriptProvider, resolveSeedInput, seedTestRequest } from "./lib/seed-request";

async function main() {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { fixtureScriptProvider } = await import("../src/lib/providers/script/fixture");

  const inputResult = resolveSeedInput({
    topic: process.env.SEED_TOPIC,
    style: process.env.SEED_STYLE,
    language: process.env.SEED_LANGUAGE,
    mode: process.env.SEED_MODE,
    durationSeconds: process.env.SEED_DURATION_SECONDS,
  });
  if (!inputResult.ok) {
    throw new Error(`Input inválido: ${inputResult.reason}`);
  }
  const { topic, style, language, mode, durationSeconds } = inputResult.value;

  console.log(
    `Sembrando solicitud — tema: "${topic}" | idioma: ${language} | estilo: ${style} | ` +
      `duración: ${durationSeconds}s | modo de guion: ${mode}`,
  );

  const providerResult = await resolveScriptProvider(mode, {
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    resolveRealProvider: async () => {
      const { getScriptProvider } = await import("../src/lib/providers/script");
      return getScriptProvider();
    },
    fixtureProvider: fixtureScriptProvider,
  });
  if (!providerResult.ok) {
    throw new Error(providerResult.reason);
  }
  // resolveScriptProvider ya validó que esto resuelve a "anthropic" en
  // modo real (o falla antes de llegar aquí) — se vuelve a resolver el
  // proveedor concreto (en vez de castear providerResult.value, que solo
  // tiene `.name` por diseño) para no perder el tipo real de ScriptProvider.
  const scriptProvider =
    mode === "real"
      ? (await import("../src/lib/providers/script")).getScriptProvider()
      : fixtureScriptProvider;

  const service = createServiceClient();

  const outcome = await seedTestRequest(inputResult.value, scriptProvider, {
    getFirstUserId: async () => {
      const { data, error } = await service.auth.admin.listUsers({ perPage: 1 });
      if (error) {
        throw new Error(`No se pudo consultar los usuarios existentes: ${error.message}`);
      }
      return data?.users?.[0]?.id ?? null;
    },
    createInternalTestUser: async () => {
      console.log(
        "No hay ningún usuario registrado todavía — creando una cuenta de prueba interna solo para esta validación técnica.",
      );
      const { data, error } = await service.auth.admin.createUser({
        email: `worker-test+${Date.now()}@atomivid-internal.test`,
        password: crypto.randomUUID(),
        email_confirm: true,
        user_metadata: { atomivid_internal_test_account: true },
      });
      if (error || !data?.user) {
        throw new Error(`No se pudo crear un usuario de prueba: ${error?.message}`);
      }
      return data.user.id;
    },
    // Protección por mejor esfuerzo contra duplicar la solicitud si este
    // workflow se reintenta manualmente justo después de un fallo — no es
    // atómica (sin constraint UNIQUE en la base de datos), ver el
    // comentario de DUPLICATE_WINDOW_MS en lib/seed-request.ts.
    findRecentDuplicate: async ({ userId, topic: dupTopic, sinceISO }) => {
      const { data } = await service
        .from("video_requests")
        .select("id")
        .eq("user_id", userId)
        .eq("topic", dupTopic)
        .in("status", ["processing", "script_ready"])
        .gte("created_at", sinceISO)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string }>();
      return data?.id ?? null;
    },
    insertVideoRequest: async (payload) => {
      const { data, error } = await service
        .from("video_requests")
        .insert(payload)
        .select("id")
        .single<{ id: string }>();
      if (error || !data) {
        throw new Error(`No se pudo crear la solicitud de prueba: ${error?.message}`);
      }
      return data.id;
    },
  });

  if (outcome.reused) {
    console.log(
      "Ya existe una solicitud reciente con el mismo tema y usuario — se reutiliza en vez de crear una nueva.",
    );
  } else {
    console.log(`Guion generado (${outcome.scriptProviderName}) e insertado.`);
  }
  console.log(`REQUEST_ID=${outcome.requestId}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const fs = await import("node:fs/promises");
    await fs.appendFile(githubOutput, `request_id=${outcome.requestId}\n`);
  }
}

main().catch((err) => {
  console.error("Fallo al crear la solicitud de prueba:", err);
  process.exit(1);
});

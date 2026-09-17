import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAvatarVideo, AvatarPipelineError } from "./pipeline";
import type { GeneratedScript } from "@/lib/providers/types";

const KEYS = ["AVATAR_MODE_ENABLED", "AVATAR_PROVIDER", "HEYGEN_API_KEY", "MAX_AVATAR_DURATION_SECONDS"];

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

type AvatarRow = {
  id: string;
  user_id: string;
  status: string;
  consent_given: boolean;
  provider_avatar_id: string | null;
  provider: string;
};

/**
 * Fake mínimo de SupabaseClient — solo implementa las cadenas de métodos
 * que generateAvatarVideo() realmente usa (select/eq/maybeSingle en
 * "avatars", update/eq en "video_requests", select/eq/maybeSingle +
 * upsert en "generation_costs" vía recordVideoGeneration, y
 * storage.from().upload()). No es un reemplazo de Supabase — solo lo
 * suficiente para probar la lógica de generateAvatarVideo() en
 * aislamiento, sin red.
 */
function makeFakeSupabase(avatarRow: AvatarRow | null) {
  const updates: Record<string, unknown>[] = [];
  const uploads: Array<{ path: string; bytes: number }> = [];

  const fake = {
    from(table: string) {
      if (table === "avatars") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: avatarRow };
          },
        };
      }
      if (table === "video_requests") {
        return {
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "generation_costs") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: null };
          },
          async upsert() {
            return { error: null };
          },
        };
      }
      throw new Error(`tabla no soportada por el fake: ${table}`);
    },
    storage: {
      from() {
        return {
          async upload(objectPath: string, buffer: Buffer) {
            uploads.push({ path: objectPath, bytes: buffer.byteLength });
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

  return { fake, updates, uploads };
}

function makeScript(): GeneratedScript {
  return { title: "t", segments: [{ text: "Hola, este es un guion de prueba.", visualQuery: "person" }] };
}

test("lanza mode_disabled si AVATAR_MODE_ENABLED no está encendido, sin tocar ninguna tabla", async () => {
  await withEnv({}, async () => {
    const { fake } = makeFakeSupabase(null);
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "mode_disabled",
    );
  });
});

test("lanza avatar_not_found si el avatar no existe", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake } = makeFakeSupabase(null);
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "avatar_not_found",
    );
  });
});

test("lanza avatar_not_owned si el avatar pertenece a OTRO usuario — nunca confía en el avatarId recibido", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake } = makeFakeSupabase({
      id: "a1",
      user_id: "otro-usuario",
      status: "ready",
      consent_given: true,
      provider_avatar_id: "prov-1",
      provider: "fixture",
    });
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "avatar_not_owned",
    );
  });
});

test("lanza consent_missing si el avatar del dueño correcto no tiene consentimiento", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake } = makeFakeSupabase({
      id: "a1",
      user_id: "u1",
      status: "ready",
      consent_given: false,
      provider_avatar_id: "prov-1",
      provider: "fixture",
    });
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "consent_missing",
    );
  });
});

test("lanza avatar_not_ready si el avatar está failed/deleted", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake } = makeFakeSupabase({
      id: "a1",
      user_id: "u1",
      status: "failed",
      consent_given: true,
      provider_avatar_id: "prov-1",
      provider: "fixture",
    });
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "avatar_not_ready",
    );
  });
});

test("lanza duration_exceeded si la narración estimada supera MAX_AVATAR_DURATION_SECONDS, sin llamar al proveedor", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", MAX_AVATAR_DURATION_SECONDS: "2" }, async () => {
    const { fake } = makeFakeSupabase({
      id: "a1",
      user_id: "u1",
      status: "ready",
      consent_given: true,
      provider_avatar_id: "prov-1",
      provider: "fixture",
    });
    const longScript: GeneratedScript = {
      title: "t",
      segments: [{ text: "una dos tres cuatro cinco seis siete ocho nueve diez once doce", visualQuery: "person" }],
    };
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: longScript, avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "duration_exceeded",
    );
  });
});

test("ciclo completo exitoso con el proveedor fixture: registra el job id y sube el video", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake, updates, uploads } = makeFakeSupabase({
      id: "a1",
      user_id: "u1",
      status: "ready",
      consent_given: true,
      provider_avatar_id: "fixture-avatar-existing",
      provider: "fixture",
    });

    const result = await generateAvatarVideo({
      supabase: fake,
      requestId: "r1",
      userId: "u1",
      script: makeScript(),
      avatarId: "a1",
    });

    assert.equal(result.videoPath, "r1/final.mp4");
    assert.ok(uploads.some((u) => u.path === "r1/final.mp4" && u.bytes > 0));
    // Confirma que se sintetizó y alojó narración propia (audioUrl) ANTES
    // de llamar al proveedor — el flujo real de ATOMIVID, no la síntesis
    // interna del proveedor (ver providers/types.ts → AvatarVideoRequest.audioUrl).
    assert.ok(uploads.some((u) => u.path.startsWith("r1/avatar-narration.") && u.bytes > 0));
    assert.ok(updates.some((u) => "avatar_provider_video_job_id" in u));
  });
});

test("idempotencia: con un providerVideoJobId ya completado no se vuelve a llamar generateVideo (nunca cobra dos veces)", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true" }, async () => {
    const { fake } = makeFakeSupabase({
      id: "a1",
      user_id: "u1",
      status: "ready",
      consent_given: true,
      provider_avatar_id: "fixture-avatar-existing",
      provider: "fixture",
    });

    // El fixture SIEMPRE devuelve "completed" en checkVideoStatus — el
    // camino de idempotencia debe detenerse ahí, sin volver a generar.
    await assert.rejects(
      () =>
        generateAvatarVideo({
          supabase: fake,
          requestId: "r1",
          userId: "u1",
          script: makeScript(),
          avatarId: "a1",
          existingProviderVideoJobId: "job-anterior",
        }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "provider_error",
    );
  });
});

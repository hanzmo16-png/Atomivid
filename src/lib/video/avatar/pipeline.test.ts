import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fixtureAvatarProvider } from "@/lib/providers/avatar/fixture";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { generateAvatarVideo, AvatarPipelineError } from "./pipeline";
import type { GeneratedScript } from "@/lib/providers/types";

const KEYS = ["AVATAR_MODE_ENABLED", "AVATAR_PROVIDER", "HEYGEN_API_KEY", "MAX_AVATAR_DURATION_SECONDS", "VOICE_PROVIDER", "ELEVENLABS_API_KEY"];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  process.env.VOICE_PROVIDER = "fixture";
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
function makeFakeSupabase(avatarRow: AvatarRow | null, claimError = false) {
  let claimed = false;
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
              eq() { return this; },
              is() { return this; },
              select() { return this; },
              async maybeSingle() {
                if ("avatar_generation_started_at" in payload) {
                  if (claimError) return { data: null, error: { message: "database unavailable" } };
                  if (claimed) return { data: null, error: null };
                  claimed = true;
                }
                return { data: { id: "r1" }, error: null };
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


for (const failure of ["synthesis", "upload", "sign"] as const) {
  test(`narration ${failure} failure never calls avatar provider or leaks private details`, async () => {
    await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture" }, async () => {
      const { fake } = makeFakeSupabase({
        id: "a1", user_id: "u1", status: "ready", consent_given: true,
        provider_avatar_id: "fixture-avatar-existing", provider: "fixture",
      });
      const generate = mock.method(fixtureAvatarProvider, "generateVideo", async () => {
        throw new Error("must not call avatar");
      });
      const synthesize = failure === "synthesis"
        ? mock.method(fixtureVoiceProvider, "synthesize", async () => { throw new Error("private-token"); })
        : null;
      const originalFrom = fake.storage.from;
      fake.storage.from = () => {
        const storage = originalFrom();
        if (failure === "upload") storage.upload = async () => ({ error: { message: "private-token" } });
        if (failure === "sign") storage.createSignedUrl = async () => ({ data: null, error: { message: "private-token" } });
        return storage;
      };
      try {
        await assert.rejects(
          () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1", voiceId: "fallback-voice" }),
          (err: unknown) => err instanceof AvatarPipelineError && err.code === "narration_failed" && !err.message.includes("private-token"),
        );
        assert.equal(generate.mock.callCount(), 0);
      } finally {
        generate.mock.restore();
        synthesize?.mock.restore();
      }
    });
  });
}

test("existing avatar job does not synthesize narration again", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture" }, async () => {
    const { fake, uploads } = makeFakeSupabase({
      id: "a1", user_id: "u1", status: "ready", consent_given: true,
      provider_avatar_id: "fixture-avatar-existing", provider: "fixture",
    });
    const synthesize = mock.method(fixtureVoiceProvider, "synthesize", async () => { throw new Error("must not synthesize"); });
    try {
      await assert.rejects(
        () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1", existingProviderVideoJobId: "existing" }),
        (err: unknown) => err instanceof AvatarPipelineError && err.code === "provider_error",
      );
      assert.equal(synthesize.mock.callCount(), 0);
      assert.equal(uploads.length, 0);
    } finally {
      synthesize.mock.restore();
    }
  });
});

for (const databaseFailure of [false, true]) {
  test(`durable claim blocks repeat/concurrent consumption (databaseFailure=${databaseFailure})`, async () => {
    await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture" }, async () => {
      const { fake } = makeFakeSupabase({
        id: "a1", user_id: "u1", status: "ready", consent_given: true,
        provider_avatar_id: "fixture-avatar-existing", provider: "fixture",
      }, databaseFailure);
      const voice = mock.method(fixtureVoiceProvider, "synthesize", async () => { throw new Error("ambiguous timeout"); });
      const generate = mock.method(fixtureAvatarProvider, "generateVideo");
      const run = () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" });
      try {
        const results = await Promise.allSettled([run(), run()]);
        assert.ok(results.every(r => r.status === "rejected"));
        await assert.rejects(run, (e: unknown) => e instanceof AvatarPipelineError && e.code === "attempt_blocked");
        assert.equal(voice.mock.callCount(), databaseFailure ? 0 : 1);
        assert.equal(generate.mock.callCount(), 0);
      } finally {
        voice.mock.restore(); generate.mock.restore();
      }
    });
  });
}

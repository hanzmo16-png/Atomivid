import { recordingFormat } from "./recording";
import { generateToneWav } from "@/lib/providers/wav";
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
  process.env.AVATAR_PROVIDER ??= "fixture";
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
function makeFakeSupabase(avatarRow: AvatarRow | null, claimError = false, existingJob: string | null = null, recordedPath: string | null = null) {
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
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: { avatar_provider_video_job_id: existingJob, recorded_audio_path: recordedPath }, error: null }; },
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

for (const invalid of [false, true]) {
  test(`actual audio blocks provider before upload (invalid=${invalid})`, async () => {
    await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture", MAX_AVATAR_DURATION_SECONDS: "15" }, async () => {
      const { fake, uploads } = makeFakeSupabase({ id: "a1", user_id: "u1", status: "ready", consent_given: true, provider_avatar_id: "fixture-avatar", provider: "fixture" });
      const original = fixtureVoiceProvider.synthesize.bind(fixtureVoiceProvider);
      const voice = mock.method(fixtureVoiceProvider, "synthesize", async () => {
        const result = await original(Array(100).fill("hola").join(" "), "es");
        return { ...result, durationSeconds: 1, audioBuffer: invalid ? Buffer.from("not audio") : result.audioBuffer };
      });
      const generate = mock.method(fixtureAvatarProvider, "generateVideo");
      try {
        const script = makeScript();
        script.segments = [{ ...script.segments[0], text: "Hola" }];
        await assert.rejects(() => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script, avatarId: "a1" }), (err: unknown) => err instanceof AvatarPipelineError && err.code === (invalid ? "narration_failed" : "duration_exceeded"));
        assert.equal(generate.mock.callCount(), 0);
        assert.equal(uploads.length, 0);
      } finally { voice.mock.restore(); generate.mock.restore(); }
    });
  });
}

for (const storedJob of ["existing", "different", null]) {
  test(`recovery uses only the job owned by this request (stored=${storedJob})`, async () => {
    await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture" }, async () => {
      const { fake, uploads, updates } = makeFakeSupabase({
        id: "a1", user_id: "u1", status: "ready", consent_given: true,
        provider_avatar_id: "fixture-avatar-existing", provider: "fixture",
      }, false, storedJob);
      const synthesize = mock.method(fixtureVoiceProvider, "synthesize", async () => { throw new Error("must not synthesize"); });
      const generate = mock.method(fixtureAvatarProvider, "generateVideo", async () => { throw new Error("must not generate"); });
      try {
        const run = () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1", existingProviderVideoJobId: "existing" });
        if (storedJob === "existing") {
          assert.equal((await run()).videoPath, "r1/final.mp4");
          assert.ok(uploads.some(u => u.path === "r1/final.mp4"));
        } else {
          await assert.rejects(run, (err: unknown) => err instanceof AvatarPipelineError && err.code === "attempt_blocked");
          assert.equal(uploads.length, 0);
        }
        assert.equal(synthesize.mock.callCount(), 0);
        assert.equal(generate.mock.callCount(), 0);
        assert.ok(!updates.some(u => "avatar_generation_started_at" in u));
      } finally { synthesize.mock.restore(); generate.mock.restore(); }
    });
  });
}

test("provider mismatch blocks before voice or generation", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture" }, async () => {
    const { fake, uploads, updates } = makeFakeSupabase({
      id: "a1", user_id: "u1", status: "ready", consent_given: true,
      provider_avatar_id: "did-avatar", provider: "did",
    });
    await assert.rejects(
      () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", script: makeScript(), avatarId: "a1" }),
      (err: unknown) => err instanceof AvatarPipelineError && err.code === "provider_unavailable",
    );
    assert.equal(uploads.length, 0);
    assert.equal(updates.length, 0);
  });
});

for (const scenario of ["valid", "missing", "cross-user", "unassociated", "invalid", "too-long"] as const) {
  test(`recorded narration ${scenario}: no TTS fallback and validation before consumption`, async () => {
    await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_PROVIDER: "fixture", MAX_AVATAR_DURATION_SECONDS: "10" }, async () => {
      const selected = scenario === "cross-user" ? "other/r1/recording.wav" : "u1/r1/recording.wav";
      const { fake, updates } = makeFakeSupabase({ id: "a1", user_id: "u1", status: "ready", consent_given: true, provider_avatar_id: "fixture-avatar-existing", provider: "fixture" }, false, null, scenario === "unassociated" ? null : selected);
      const recording = scenario === "invalid" ? Buffer.from("not audio") : generateToneWav({ durationSeconds: scenario === "too-long" ? 11 : 2, frequencyHz: 220, amplitude: .15 });
      const originalFrom = fake.storage.from;
      const stored: Buffer[] = [];
      fake.storage.from = () => ({ ...originalFrom(),
        download: async () => ({ data: scenario === "missing" ? null : new Blob([new Uint8Array(recording)]), error: null }),
        upload: async (name: string, bytes: Buffer) => { if (name.includes("avatar-narration")) stored.push(bytes); return { error: null }; },
      });
      const tts = mock.method(fixtureVoiceProvider, "synthesize", async () => { throw new Error("TTS must never run"); });
      const originalGenerate = fixtureAvatarProvider.generateVideo.bind(fixtureAvatarProvider);
      const avatar = mock.method(fixtureAvatarProvider, "generateVideo", originalGenerate);
      try {
        const execute = () => generateAvatarVideo({ supabase: fake, requestId: "r1", userId: "u1", avatarId: "a1", script: makeScript(), recordedAudioPath: selected });
        if (scenario === "valid") {
          await execute();
          assert.equal(avatar.mock.callCount(), 1);
          assert.deepEqual(stored[0], recording);
          assert.equal(avatar.mock.calls[0].arguments[0].audioDurationSeconds, 2);
        } else {
          await assert.rejects(execute, AvatarPipelineError);
          assert.equal(avatar.mock.callCount(), 0);
          assert.equal(updates.length, 0);
        }
        assert.equal(tts.mock.callCount(), 0);
      } finally { tts.mock.restore(); avatar.mock.restore(); }
    });
  });
}

test("Samsung M4A with 3gp4 brand is accepted for worker decoding", () => {
  const header = Buffer.from("0000001866747970336770340000000069736f6d33677034", "hex");
  assert.equal(recordingFormat(header).extension, "m4a");
});

test("HeyGen recorded pipeline preserves owner association, uses full audio and only creates after claim", async () => {
  const { heygenAvatarProvider } = await import("@/lib/providers/avatar/heygen");
  const { readFileSync } = await import("node:fs");
  const photo = readFileSync("scripts/test-avatar-photo.jpg");
  const audio = generateToneWav({durationSeconds:2.25,frequencyHz:220,amplitude:.1});
  const avatar = {id:"a1",user_id:"u1",status:"uploaded",consent_given:true,provider_avatar_id:null,provider:"heygen",source_photo_path:"u1/r1/photo.jpeg"};
  const {fake,updates}=makeFakeSupabase(avatar,false,null,"u1/r1/recording.wav");
  const baseFrom=fake.from.bind(fake);
  fake.from=(table:string)=>{
    const q=baseFrom(table);
    if(table==="avatars")q.update=()=>({eq(){return this;},then(resolve:(v:unknown)=>unknown){return Promise.resolve(resolve({error:null}));}});
    return q;
  };
  const baseStorage=fake.storage.from.bind(fake.storage);
  fake.storage.from=(name:string)=>({...baseStorage(name),download:async(objectPath:string)=>({data:new Blob([new Uint8Array(objectPath.endsWith("jpeg")?photo:audio)]),error:null})});
  const originalCreate=heygenAvatarProvider.createAvatar,originalGenerate=heygenAvatarProvider.generateVideo;
  let creations=0;
  heygenAvatarProvider.createAvatar=async request=>{
    assert.ok(updates.some(u=>u.avatar_generation_started_at));
    assert.deepEqual(request.photoBuffer,photo);assert.equal(request.consentGiven,true);
    return {providerAvatarId:"asset:photo",status:"completed"};
  };
  heygenAvatarProvider.generateVideo=async request=>{
    creations++;assert.equal(request.audioDurationSeconds,2.25);assert.equal(request.voiceId,undefined);
    assert.equal(request.providerAvatarId,"asset:photo");assert.ok(request.audioUrl?.includes(".wav"));
    await request.onJobCreated?.("heygen-job");
    return {...await fixtureAvatarProvider.generateVideo({...request,providerAvatarId:"fixture"}),providerJobId:"heygen-job"};
  };
  try {
    await withEnv({AVATAR_MODE_ENABLED:"true",AVATAR_PROVIDER:"heygen",HEYGEN_API_KEY:"fake"},async()=>{
      await generateAvatarVideo({supabase:fake,requestId:"r1",userId:"u1",script:{title:"recorded",segments:[]},avatarId:"a1",recordedAudioPath:"u1/r1/recording.wav"});
    });
    assert.equal(creations,1);
  } finally {heygenAvatarProvider.createAvatar=originalCreate;heygenAvatarProvider.generateVideo=originalGenerate;}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript } from "@/lib/providers/types";
import { resolveDirection } from "./direction";
import type { AudiovisualSelection } from "./catalog";

/**
 * Pipeline dirigido SIN render (no llega a Remotion): comprueba que los
 * problemas de música/imágenes/disponibilidad detienen la producción ANTES
 * de la voz (el primer gasto por segundo narrado) y que nunca se recurre a
 * stock realista ni a otra pista. Todo con proveedores fixture y un
 * Supabase simulado — cero red, cero gasto.
 */
const script: GeneratedScript = {
  title: "El faro",
  segments: [
    { text: "Nadie sabe qué pasó aquella noche en el faro abandonado.", visualQuery: "old lighthouse night", energy: "low" },
    { text: "El guardián desapareció y solo quedó un grito en la grabación.", visualQuery: "empty stairway", energy: "medium" },
    { text: "Entonces encontraron la puerta cerrada por dentro.", visualQuery: "locked door", energy: "high" },
  ],
};

function fakeSupabase(opts: { failUploadsMatching?: RegExp } = {}) {
  const uploads: string[] = [];
  const client = {
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        upload: async (p: string) => {
          if (opts.failUploadsMatching?.test(p)) return { error: { message: "simulado: bucket no disponible" } };
          uploads.push(p);
          return { error: null };
        },
        createSignedUrl: async (p: string) => ({ data: { signedUrl: `http://127.0.0.1/${p}` }, error: null }),
      }),
    },
    from: () => ({ insert: async () => ({ error: null }), upsert: async () => ({ error: null }) }),
  };
  return { client: client as unknown as SupabaseClient, uploads };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const FIXTURES = { SCRIPT_PROVIDER: "fixture", VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture" };
const directionFor = (selection: Omit<AudiovisualSelection, "version">) =>
  resolveDirection({ selection: { version: 1, ...selection }, style: "Curiosidades", topic: "El faro", scenes: script.segments });

test("perfil ilustrado: si la imagen de una escena falla, se detiene antes de la voz y sin stock realista", async () => {
  const { generateDirectedVideoFromScript, DirectedProductionError } = await import("./directed-reel");
  const { client, uploads } = fakeSupabase({ failUploadsMatching: /styled/ });
  const stages: string[] = [];
  await withEnv({ ...FIXTURES, OPENAI_IMAGE_GENERATION_ENABLED: "true" }, async () => {
    await assert.rejects(
      generateDirectedVideoFromScript({ supabase: client, requestId: "req-a", script, direction: directionFor({ profile: "comic" }), onProgress: (s) => { stages.push(s); } }),
      (err: unknown) => err instanceof DirectedProductionError && /No se sustituyó por stock realista/.test(err.message),
    );
  });
  assert.ok(!stages.includes("voice"), `etapas: ${stages.join(",")}`);
  assert.ok(!uploads.some((p) => /scene-\d+-\d+\./.test(p)), "ningún clip de stock subido");
});

test("perfil ilustrado sin generación habilitada: se bloquea antes de cualquier etapa", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const { client, uploads } = fakeSupabase();
  const stages: string[] = [];
  await withEnv({ ...FIXTURES, OPENAI_IMAGE_GENERATION_ENABLED: "false" }, async () => {
    await assert.rejects(
      generateDirectedVideoFromScript({ supabase: client, requestId: "req-b", script, direction: directionFor({ profile: "anime" }), onProgress: (s) => { stages.push(s); } }),
      /la generación de imágenes no está habilitada/,
    );
  });
  assert.deepEqual(stages, []);
  assert.deepEqual(uploads, []);
});

test("música dirigida no disponible: se detiene antes de la voz, sin otra pista ni música de pago", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const { client } = fakeSupabase();
  const stages: string[] = [];
  // Biblioteca curada real sin credenciales de Supabase → no se puede obtener la pista compatible.
  await withEnv({ ...FIXTURES, MUSIC_PROVIDER: "curated-library", NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    await assert.rejects(
      generateDirectedVideoFromScript({ supabase: client, requestId: "req-c", script, direction: directionFor({ profile: "horror_mystery" }), onProgress: (s) => { stages.push(s); } }),
      /No se usó otra pista ni música de pago/,
    );
  });
  assert.deepEqual(stages, ["music"]);
});

test("orden del pipeline dirigido: música e imágenes antes de la voz; el flujo anterior solo delega si hay dirección", () => {
  const source = readFileSync(path.join(__dirname, "directed-reel.ts"), "utf8");
  const voice = source.indexOf("await voiceProvider.synthesize(");
  assert.ok(source.indexOf("musicProvider.getTrack(") < voice);
  assert.ok(source.indexOf("await resolveGeneratedImageForScene(") < voice);
  assert.ok(source.indexOf("evaluateDirectionReadiness(") < source.indexOf("musicProvider.getTrack("));
  assert.ok(source.indexOf("validateTimeline(") < source.indexOf("await renderVerticalReel("));
  // El catch de la imagen generada nunca llama a stock.
  const catchStart = source.indexOf("} catch (err) {", source.indexOf("await resolveGeneratedImageForScene("));
  const catchEnd = source.indexOf("}\n    }\n  }", catchStart);
  assert.ok(!source.slice(catchStart, catchEnd).includes("selectFootageForScene"));

  const legacy = readFileSync(path.join(__dirname, "..", "generate-video.ts"), "utf8");
  assert.match(legacy, /if \(direction\) \{\n\s+return generateDirectedVideoFromScript\(/);
});

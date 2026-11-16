import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  applyInput, estimate, musicPlan, newProject, parseStored, readinessIssues, scriptLines, ValidationError, voicePreset, voiceRate, MAX_SCRIPT,
} from "./model";
import type { AudioProject } from "./model";
import { memoryStore, projectPath, storageStore, AUDIO_STUDIO_PREFIX } from "./store";
import {
  createProject, ensureSeed, getProject, GENERATION_BLOCKED, listProjects, markReady, requestGeneration, saveProject, seedId, setArchived,
} from "./service";
import { SEED_EPISODE } from "./seed";
import { canAccessAudioStudio } from "./access";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-16T12:00:00.000Z";
let n = 0;
const ids = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;
const deps = (store = memoryStore()) => ({ store, now: () => NOW, newId: ids, env: {} });

test("un proyecto nuevo nace en borrador, con una voz, sin gasto ni audio", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW, title: "  Hola   mundo " });
  assert.equal(p.title, "Hola mundo");
  assert.equal(p.status, "borrador");
  assert.equal(p.voiceCount, 1);
  assert.equal(p.voices.length, 1);
  assert.equal(p.spentUsd, 0);
  assert.equal(p.audio, null);
  assert.equal(p.revision, 1);
});

test("dos voces: deben ser distintas y del catálogo; pasar a dos propone una segunda voz de otro género", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW });
  const two = applyInput(p, { voiceCount: 2 }, NOW);
  assert.equal(two.voices.length, 2);
  assert.notEqual(voicePreset(two.voices[0])!.gender, voicePreset(two.voices[1])!.gender);
  assert.throws(() => applyInput(p, { voiceCount: 2, voices: [p.voices[0], p.voices[0]] }, NOW), ValidationError);
  assert.throws(() => applyInput(p, { voices: ["no-existe"] }, NOW), ValidationError);
  assert.throws(() => applyInput(p, { voiceCount: 3 as never }, NOW), ValidationError);
  const back = applyInput(two, { voiceCount: 1 }, NOW);
  assert.deepEqual(back.voices, [two.voices[0]]);
});

test("validación: título vacío, guion demasiado largo, presupuesto no positivo y controles quitados", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW });
  assert.throws(() => applyInput(p, { title: "   " }, NOW), ValidationError);
  assert.throws(() => applyInput(p, { script: "x".repeat(MAX_SCRIPT + 1) }, NOW), ValidationError);
  assert.throws(() => applyInput(p, { budgetUsd: 0 }, NOW), ValidationError);
  assert.equal(applyInput(p, { budgetUsd: 999 }, NOW).budgetUsd, 20);
  assert.equal(applyInput(p, { targetMinutes: 500 }, NOW).targetMinutes, 60);
  assert.equal(applyInput(p, { script: "a\u0000b\r\nc" }, NOW).script, "ab\nc");
});

test("el cliente no puede fijar dueño, estado, gasto ni fechas", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW });
  const q = applyInput(p, { ownerId: B, status: "listo_para_autorizar", spentUsd: 5, createdAt: "x" } as never, NOW);
  assert.equal(q.ownerId, A);
  assert.equal(q.status, "borrador");
  assert.equal(q.spentUsd, 0);
  assert.equal(q.createdAt, NOW);
});

test("guion: con dos voces «Voz 2:» cambia de voz; los títulos «##» no se narran ni se cobran", () => {
  const s = "## Intro\nVoz 1: Hola a todos.\nVoz 2: Hola, ¿cómo están?\nSeguimos con la voz dos.\n[1]: Vuelve la uno.";
  const l = scriptLines(s, 2);
  assert.deepEqual(l.map((x) => x.voice), [0, 1, 1, 0]);
  assert.ok(!l.some((x) => x.text.includes("Intro")));
  const one = scriptLines(s, 1);
  assert.ok(one.every((x) => x.voice === 0));
  const e = estimate({ script: s, voiceCount: 2, targetMinutes: 1, budgetUsd: 1, spentUsd: 0 });
  assert.equal(e.perVoiceCharacters.length, 2);
  assert.ok(e.perVoiceCharacters[1] > 0);
  assert.equal(e.paidCallsEnabled, false);
});

test("costo: nunca usa una tarifa menor que la de producción (0.20 / 1K)", () => {
  assert.equal(voiceRate({}), 0.2);
  assert.equal(voiceRate({ PRICING_ELEVENLABS_USD_PER_1K_CHARS: "0.1" }), 0.2);
  assert.equal(voiceRate({ PRICING_ELEVENLABS_USD_PER_1K_CHARS: "0.3" }), 0.3);
  assert.equal(voiceRate({ PRICING_ELEVENLABS_USD_PER_1K_CHARS: "basura" }), 0.2);
  const e = estimate({ script: "a".repeat(10_000), voiceCount: 1, targetMinutes: 1, budgetUsd: 1, spentUsd: 0 }, 0.2);
  assert.equal(e.estimatedUsd, 2);
  assert.equal(e.withinBudget, false);
});

test("música inteligente: un ambiente por sección según el texto; fija usa uno; sin música no planifica", () => {
  const s = "## Uno\nRespira, busca la calma y el silencio.\n## Dos\nEl miedo, la ira y la angustia nos golpean.\n## Tres\nTexto neutro.";
  const plan = musicPlan(s, { mode: "inteligente", mood: "reflexiva", volume: 20, ducking: true, intro: true, outro: true });
  assert.deepEqual(plan.map((x) => x.mood), ["calma", "intensa", "reflexiva"]);
  assert.ok(musicPlan(s, { mode: "fija", mood: "inspiradora", volume: 20, ducking: true, intro: true, outro: true }).every((x) => x.mood === "inspiradora"));
  assert.deepEqual(musicPlan(s, { mode: "sin_musica", mood: "calma", volume: 20, ducking: true, intro: true, outro: true }), []);
});

test("primer episodio: título exacto, voz masculina profesional latina, 18 min, música inteligente, listo para revisar y dentro del tope", () => {
  assert.equal(SEED_EPISODE.title, "El día que entiendes que no puedes controlarlo todo");
  const v = voicePreset(SEED_EPISODE.voice)!;
  assert.equal(v.gender, "masculina");
  assert.match(v.accent, /latinoamericano/);
  assert.match(v.label, /profesional/);
  assert.equal(SEED_EPISODE.targetMinutes, 18);
  assert.equal(SEED_EPISODE.music.mode, "inteligente");
  const p = applyInput(newProject({ id: ids(), ownerId: A, now: NOW, title: SEED_EPISODE.title }), { voices: [SEED_EPISODE.voice], targetMinutes: 18, script: SEED_EPISODE.script, music: SEED_EPISODE.music, budgetUsd: SEED_EPISODE.budgetUsd }, NOW);
  const e = estimate(p, 0.2);
  assert.ok(Math.abs(e.estimatedMinutes - 18) <= 1, `duración estimada ${e.estimatedMinutes}`);
  assert.ok(e.estimatedUsd < SEED_EPISODE.budgetUsd);
  assert.deepEqual(readinessIssues(p, e), []);
  assert.ok(musicPlan(p.script, p.music).length >= 10);
  assert.match(SEED_EPISODE.script, /estoic/i);
});

test("parseStored descarta archivos de otra cuenta, de otra versión o corruptos", () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW, title: "X" });
  assert.ok(parseStored(JSON.parse(JSON.stringify(p)), A));
  assert.equal(parseStored(JSON.parse(JSON.stringify(p)), B), null);
  assert.equal(parseStored({ ...p, version: "otra" }, A), null);
  assert.equal(parseStored({ ...p, voices: ["x"] }, A), null);
  assert.equal(parseStored("basura", A), null);
});

test("servicio: crear, guardar con revisión, conflicto entre pestañas sin perder trabajo", async () => {
  const d = deps();
  const c = await createProject(d, A, { title: "Ep", voiceCount: 2 });
  assert.equal(c.status, 201);
  const p = c.body as { id: string; revision: number; voices: string[] };
  const s1 = await saveProject(d, A, p.id, { revision: p.revision, script: "Voz 1: hola\nVoz 2: chao" });
  assert.equal(s1.status, 200);
  const stale = await saveProject(d, A, p.id, { revision: p.revision, script: "pisaría" });
  assert.equal(stale.status, 409);
  const g = await getProject(d, A, p.id);
  assert.equal((g.body as { script: string }).script, "Voz 1: hola\nVoz 2: chao");
  assert.equal((await saveProject(d, A, p.id, { script: "sin revisión" })).status, 400);
  assert.equal((await saveProject(d, A, p.id, { revision: 2, voices: ["no"] })).status, 400);
});

test("aislamiento: otra cuenta no ve, no lee, no edita ni archiva proyectos ajenos", async () => {
  const store = memoryStore();
  const d = deps(store);
  const c = await createProject(d, A, { title: "Privado" });
  const id = (c.body as { id: string }).id;
  assert.equal(((await listProjects(d, B)).body as { projects: unknown[] }).projects.length, 0);
  assert.equal((await getProject(d, B, id)).status, 404);
  assert.equal((await saveProject(d, B, id, { revision: 1, title: "robado" })).status, 404);
  assert.equal((await setArchived(d, B, id, true)).status, 404);
  assert.equal((await markReady(d, B, id, 1)).status, 404);
  assert.equal((await requestGeneration(d, B, id)).status, 404);
  assert.ok(store.paths().every((k) => k.startsWith(`${AUDIO_STUDIO_PREFIX}/${A}/`)));
  assert.equal((await getProject(d, A, "../../etc/passwd")).status, 404);
  assert.throws(() => projectPath(A, "../x"));
  assert.throws(() => projectPath("..", ids()));
});

test("archivar no borra: restaurar devuelve el proyecto intacto; archivado no se edita", async () => {
  const d = deps();
  const c = await createProject(d, A, { title: "Ep" });
  const id = (c.body as { id: string }).id;
  await saveProject(d, A, id, { revision: 1, script: "texto que debe sobrevivir" });
  const a = await setArchived(d, A, id, true);
  assert.ok((a.body as { archivedAt: string | null }).archivedAt);
  assert.equal((await saveProject(d, A, id, { revision: (a.body as { revision: number }).revision, title: "no" })).status, 409);
  const r = await setArchived(d, A, id, false);
  assert.equal((r.body as { archivedAt: string | null }).archivedAt, null);
  assert.equal((r.body as { script: string }).script, "texto que debe sobrevivir");
  assert.equal(((await listProjects(d, A)).body as { projects: unknown[] }).projects.length, 1);
});

test("listo para autorizar exige guion completo y vuelve a borrador si el contenido cambia", async () => {
  const d = deps();
  const c = await createProject(d, A, { title: "Ep" });
  const id = (c.body as { id: string }).id;
  assert.equal((await markReady(d, A, id, 1)).status, 422);
  const s = await saveProject(d, A, id, { revision: 1, targetMinutes: 5, script: "palabra ".repeat(750) });
  const rev = (s.body as { revision: number }).revision;
  assert.equal((await markReady(d, A, id, rev - 1)).status, 409);
  const ok = await markReady(d, A, id, rev);
  assert.equal((ok.body as { status: string }).status, "listo_para_autorizar");
  const ed = await saveProject(d, A, id, { revision: (ok.body as { revision: number }).revision, script: "palabra ".repeat(751) });
  assert.equal((ed.body as { status: string }).status, "borrador");
});

test("generar audio real está bloqueado en 1.0 y no hace ninguna llamada de red", async () => {
  const d = deps();
  const c = await createProject(d, A, { title: "Ep" });
  const id = (c.body as { id: string }).id;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("red prohibida"); }) as typeof fetch;
  try {
    const r = await requestGeneration(d, A, id);
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, GENERATION_BLOCKED);
  } finally { globalThis.fetch = original; }
  assert.equal(calls, 0);
  const after = await getProject(d, A, id);
  assert.equal((after.body as { spentUsd: number }).spentUsd, 0);
});

test("episodio inicial: id estable por cuenta, idempotente y nunca pisa la versión editada", async () => {
  const d = deps();
  assert.equal(seedId(A), seedId(A));
  assert.notEqual(seedId(A), seedId(B));
  assert.equal(await ensureSeed(d, A), "created");
  assert.equal(await ensureSeed(d, A), "exists");
  const g = await getProject(d, A, seedId(A));
  assert.equal((g.body as { title: string }).title, SEED_EPISODE.title);
  await saveProject(d, A, seedId(A), { revision: (g.body as { revision: number }).revision, script: "mi edición" });
  await setArchived(d, A, seedId(A), true);
  assert.equal(await ensureSeed(d, A), "exists");
  assert.equal(((await getProject(d, A, seedId(A))).body as { script: string }).script, "mi edición");
});

test("errores del almacén se informan como 503 sin filtrar detalles internos", async () => {
  const broken = { ...memoryStore(), get: async () => { throw Object.assign(new Error("secreto interno"), { name: "Boom" }); } };
  const r = await getProject({ store: broken, env: {} }, A, ids());
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /secreto/);
});

test("almacén en Storage: solo bajo el prefijo del módulo, crear no sobrescribe, lista solo la cuenta", async () => {
  const objects = new Map<string, string>();
  const calls: string[] = [];
  const bucket = {
    async list(prefix: string) { calls.push(`list:${prefix}`); return { data: [...objects.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }; },
    async download(p: string) { calls.push(`get:${p}`); const v = objects.get(p); return v ? { data: new Blob([v]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } }; },
    async upload(p: string, body: string | Blob, o: { upsert: boolean }) {
      calls.push(`put:${p}`);
      if (!o.upsert && objects.has(p)) return { error: { message: "The resource already exists", statusCode: "409" } };
      objects.set(p, typeof body === "string" ? body : await body.text()); return { error: null };
    },
  };
  const store = storageStore(bucket);
  const d = { store, now: () => NOW, newId: ids, env: {} };
  const c = await createProject(d, A, { title: "Ep" });
  const id = (c.body as { id: string }).id;
  assert.equal(await store.create({ ...(c.body as unknown as AudioProject), title: "pisado" }), false);
  assert.equal(((await getProject(d, A, id)).body as { title: string }).title, "Ep");
  assert.equal((await getProject(d, A, ids())).status, 404);
  await createProject(d, B, { title: "De B" });
  const la = (await listProjects(d, A)).body as { projects: { title: string }[] };
  assert.deepEqual(la.projects.map((p) => p.title), ["Ep"]);
  assert.ok(calls.every((c) => c.split(":")[1].startsWith(AUDIO_STUDIO_PREFIX + "/")), calls.join("\n"));
});

test("acceso: lista privada existente; interruptor AUDIO_STUDIO_DISABLED; sin sesión no hay acceso", () => {
  const owner = { id: A, email: "o@x.test", email_confirmed_at: NOW };
  const env = { INTERNAL_PRODUCTION_OWNER_USER_ID: A };
  const prev = process.env.INTERNAL_PRODUCTION_OWNER_USER_ID;
  process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = A;
  try {
  assert.equal(canAccessAudioStudio(owner, env), true);
  assert.equal(canAccessAudioStudio(owner, { ...env, AUDIO_STUDIO_DISABLED: "1" }), false);
  assert.equal(canAccessAudioStudio(null, env), false);
  assert.equal(canAccessAudioStudio({ id: B, email: "z@x.test", email_confirmed_at: NOW }, env), false);
  } finally { if (prev === undefined) delete process.env.INTERNAL_PRODUCTION_OWNER_USER_ID; else process.env.INTERNAL_PRODUCTION_OWNER_USER_ID = prev; }
});

test("aislamiento de código: solo reutiliza motores de Podcast en modo lectura; nada de Premium, ledger ni proveedores directos", () => {
  const roots = ["src/lib/audio-studio", "src/app/dashboard/audio-studio", "src/app/api/audio-studio"];
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p); } };
  roots.forEach(walk);
  assert.ok(files.length >= 10);
  // Motores reutilizados sin modificarlos (audio, ffmpeg, biblioteca CC0, tipos, adaptador de voz real y voz espeak de pruebas).
  const ALLOWED = new Set(["@/lib/podcast/v3/audio", "@/lib/podcast/v3/ffmpeg", "@/lib/podcast/v3/music-library", "@/lib/podcast/v3/spec", "@/lib/podcast/v3/pipeline", "@/lib/podcast/v2/espeak-provider"]);
  // Fuera de Podcast, el único motor compartido que se reutiliza es el constructor de la solicitud de ElevenLabs.
  const SHARED = new Set(["@/lib/ai/voice", "@/lib/supabase/env", "@/lib/supabase/server", "@/lib/billing/internal-production", "@/lib/video/long-form/private-access"]);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/from "(@\/[^"]+)"/g)) {
      if (m[1].startsWith("@/lib/podcast")) assert.ok(ALLOWED.has(m[1]), `${f}: ${m[1]}`);
      else if (m[1].startsWith("@/lib/") && !m[1].startsWith("@/lib/audio-studio")) assert.ok(SHARED.has(m[1]), `${f}: ${m[1]}`);
      assert.doesNotMatch(m[1], /@\/app\/dashboard\/podcast|@\/components\/podcast|paid-calls|ledger|production-intelligence/, f);
    }
    assert.doesNotMatch(src, /elevenlabs\.io|api\.anthropic|openai\.com|podcast_studio_|podcast_episodes|pi_paid/i, f);
  }
  const voice = readFileSync("src/lib/audio-studio/voice.ts", "utf8");
  assert.match(voice, /AUDIO_STUDIO_PAID_TTS === "1"/, "el adaptador real solo con el interruptor explícito");
});

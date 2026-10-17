// Handlers REALES de POST /api/podcast y POST /api/podcast/[id]/video con autenticación, repositorio y cola simulados.
// La propiedad A/B usa el loadOwnedEpisode REAL sobre un repositorio en memoria que respeta los filtros .eq().
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCreateEpisode, handleVideoRequest, deliveryLinks, readJsonObject, type VideoDeps } from "./route-handlers";
import { loadOwnedEpisode } from "./server";
import { productionFingerprint } from "./production-confirm";
import type { PodcastEpisode } from "./episode";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const EP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const episodeA = { id: EP_A, user_id: A, title: "Episodio de A", language: "es", source: "tts", script: "Guion de A con más de veinte caracteres.", voice_id: "v1", voice_name: "Lucía",
  status: "ready", audio_sha256: null, video_status: "none", video_path: null } as unknown as PodcastEpisode;

/** Repositorio en memoria con la forma de supabase-js que usa loadOwnedEpisode (from→select→eq→eq→maybeSingle). */
function repo(rows: PodcastEpisode[]) {
  return { from: () => ({ select: () => {
    const f: Record<string, unknown> = {};
    const q = { eq: (k: string, v: unknown) => { f[k] = v; return q; }, maybeSingle: async () => ({ data: rows.find((r) => Object.entries(f).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)) ?? null }) };
    return q;
  } }) } as never;
}
const req = (body: string | undefined) => new Request("http://local/api", { method: "POST", headers: { "content-type": "application/json" }, body });
const BAD_BODIES = ["null", "[]", '[{"cancel":true}]', "1", "0", "true", "false", '"texto"', "{", "", "no es json"];

function videoDeps(userId: string, rows: PodcastEpisode[] = [episodeA]) {
  const calls = { request: 0, cancel: 0, load: 0, lastOptions: null as unknown };
  const d: VideoDeps = {
    user: async () => ({ id: userId }), service: () => repo(rows),
    loadOwnedEpisode: async (s, u, i) => { calls.load++; return loadOwnedEpisode(s, u, i); },
    cancelScheduledProduction: async () => { calls.cancel++; return { ok: true, status: "cancelled" } as const; },
    requestPodcastVideo: async (_s, _e, o) => { calls.request++; calls.lastOptions = o; return { ok: true, status: "queued" } as const; },
    episodeSpend: async () => ({ spentUsd: 0, uncertain: 0 }), pendingNarration: async () => ({ usd: 0, chunks: 1 }), readRunBudget: async () => ({ available: true }),
  };
  return { d, calls };
}

test("readJsonObject: solo objetos; JSON inválido, null, arrays y primitivos → null", async () => {
  for (const b of BAD_BODIES) assert.equal(await readJsonObject(req(b)), null, b);
  assert.deepEqual(await readJsonObject(req('{"a":1}')), { a: 1 });
});

test("crear: cuerpos inválidos → 400 estable sin llamar a createEpisode; modos no soportados → 400; válido → createEpisode con el usuario autenticado", async () => {
  let created = 0, lastUser = "";
  const d = { user: async () => ({ id: A }), service: () => ({}) as never, createEpisode: async (_s: unknown, u: string) => { created++; lastUser = u; return { id: EP_A }; } };
  for (const b of BAD_BODIES) {
    const r = await handleCreateEpisode(req(b), d);
    assert.equal(r.status, 400, b); assert.deepEqual(await r.json(), { error: "Cuerpo de la solicitud inválido" });
  }
  const dos = await handleCreateEpisode(req('{"title":"t","narrationMode":"dos_narradores"}'), d);
  assert.equal(dos.status, 400); assert.match((await dos.json()).error, /un narrador/);
  assert.equal(created, 0, "ninguna entrada rechazada llega a crear");
  const ok = await handleCreateEpisode(req('{"title":"t","script":"x","voiceId":"v1"}'), d);
  assert.equal(ok.status, 200); assert.equal(created, 1); assert.equal(lastUser, A);
  const anon = await handleCreateEpisode(req('{"title":"t"}'), { ...d, user: async () => ({ error: "No autenticado", status: 401 }) });
  assert.equal(anon.status, 401); assert.equal(created, 1);
});

test("producir: cuerpo inválido (incluida la cancelación) → 400 sin cargar el episodio ni encolar", async () => {
  const { d, calls } = videoDeps(A);
  for (const b of BAD_BODIES) assert.equal((await handleVideoRequest(req(b), EP_A, d)).status, 400, b);
  assert.deepEqual([calls.load, calls.request, calls.cancel], [0, 0, 0]);
});

test("producir: incompatible 400, confirmación ausente 400, obsoleta 409, válida 202 (encola una vez con lo revisado)", async () => {
  const { d, calls } = videoDeps(A);
  const fp = productionFingerprint(episodeA);
  const cases: Array<[string, number]> = [
    [JSON.stringify({ montageEngine: "director", confirm: fp }), 400],
    [JSON.stringify({ narrationMode: "mixto", confirm: fp }), 400],
    [JSON.stringify({ budgetUsd: 1 }), 400],
    [JSON.stringify({ budgetUsd: 1, confirm: "huella-de-otra-revision" }), 409],
    [JSON.stringify({ budgetUsd: "abc", confirm: fp }), 400],
  ];
  for (const [b, status] of cases) assert.equal((await handleVideoRequest(req(b), EP_A, d)).status, status, b);
  assert.equal(calls.request, 0, "nada rechazado llega a la cola");
  const ok = await handleVideoRequest(req(JSON.stringify({ budgetUsd: 1.5, runBudgetUsd: null, scheduleAt: null, confirm: fp })), EP_A, d);
  assert.equal(ok.status, 202); assert.equal(calls.request, 1);
  assert.equal((calls.lastOptions as { budgetUsd: number }).budgetUsd, 1.5);
});

test("cancelar: no exige confirmación y no encola", async () => {
  const { d, calls } = videoDeps(A);
  const r = await handleVideoRequest(req('{"cancel":true}'), EP_A, d);
  assert.equal(r.status, 200); assert.deepEqual([calls.cancel, calls.request], [1, 0]);
});

test("propiedad A/B: B no ve ni produce ni cancela el episodio de A (404), aunque conozca su id y su huella", async () => {
  const { d, calls } = videoDeps(B);
  const fp = productionFingerprint(episodeA);
  for (const b of [JSON.stringify({ confirm: fp }), '{"cancel":true}']) assert.equal((await handleVideoRequest(req(b), EP_A, d)).status, 404, b);
  assert.deepEqual([calls.request, calls.cancel], [0, 0]);
  assert.equal(await loadOwnedEpisode(repo([episodeA]), A, EP_A), episodeA, "A sí lo ve");
  assert.equal(await loadOwnedEpisode(repo([episodeA]), A, "no-es-un-uuid"), null);
});

test("entrega: los enlaces firmados salen del video_path del episodio autorizado; sin entrega lista no hay enlace", async () => {
  const asked: Array<[string, unknown]> = [];
  const storage = { createSignedUrl: async (p: string, _ttl: number, o?: { download: string }) => { asked.push([p, o?.download ?? null]); return { data: { signedUrl: `https://firmado/${p}${o ? `?d=${o.download}` : ""}` } }; } };
  const ready = { title: "Caso: Roswell / 1947", video_status: "ready", video_path: `${A}/podcasts/${EP_A}/video/v2/episodio.mp4` } as const;
  const links = await deliveryLinks(storage, ready, 3600);
  assert.deepEqual(asked.map(([p]) => p), [ready.video_path, ready.video_path], "solo la ruta del propio episodio");
  assert.equal(links.downloadUrl, `https://firmado/${ready.video_path}?d=Caso Roswell  1947.mp4`);
  assert.deepEqual(await deliveryLinks(storage, { ...ready, video_status: "running" }, 3600), { playUrl: null, downloadUrl: null });
  assert.deepEqual(await deliveryLinks(storage, { ...ready, video_path: null }, 3600), { playUrl: null, downloadUrl: null });
  assert.equal(asked.length, 2, "sin entrega lista no se firma nada");
});

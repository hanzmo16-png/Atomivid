import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attemptsDecision, budgetDecision, buildVideoChecks, MAX_PRODUCTION_ATTEMPTS, noticeText, remainingCostUsd, scheduleDecision, summarizeSpend } from "./pilot";
import { claimScheduled, deliverGithubNotice, recordNotice } from "./pilot-server";
import { requestPodcastVideo } from "./video-jobs";
import type { PodcastEpisode } from "./episode";

function episode(over: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return { id: "11111111-1111-4111-8111-111111111111", user_id: "u", title: "t", language: "es", source: "tts", script: "x".repeat(40), voice_id: "v", voice_name: "n",
    characters: 27_000, estimated_usd: 5.4, status: "draft", run_token: null, run_started_at: null, audio_path: null, audio_mime: null, duration_seconds: null,
    audio_sha256: null, audio_bytes: null, loudness: null, cost_usd: null, error: null, created_at: "", updated_at: "", video_status: "none", video_attempts: 0, ...over };
}

/** Records updates/filters; `select` answers with `rowsMatched` rows; `insert` can simulate a duplicate. */
function fakeService(rowsMatched = 1, insertDuplicate = false) {
  const updates: Record<string, unknown>[] = [], inserts: Record<string, unknown>[] = [], filters: string[] = [];
  const self: Record<string, unknown> = new Proxy({}, { get: (_t, k: string) => {
    if (k === "update") return (patch: Record<string, unknown>) => { updates.push(patch); return self; };
    if (k === "insert") return (row: Record<string, unknown>) => { inserts.push(row); return { select: () => ({ single: async () => (insertDuplicate ? { data: null, error: { code: "23505" } } : { data: { id: "n1" }, error: null }) }) }; };
    if (k === "select") return async () => ({ data: Array.from({ length: rowsMatched }, () => ({ id: "x" })) });
    if (k === "then") return (r: (v: unknown) => unknown) => r({ data: null });
    return (...a: unknown[]) => { filters.push(`${k}:${JSON.stringify(a)}`); return self; };
  } });
  return { service: { from: () => self } as never, updates, inserts, filters };
}

test("presupuesto: el costo pendiente debe caber en el máximo; narración pagada = USD 0; sin máximo no empieza un gasto", () => {
  assert.equal(remainingCostUsd(episode()), 5.4);
  assert.equal(remainingCostUsd(episode({ status: "ready" })), 0, "narration already paid and stored");
  assert.equal(remainingCostUsd(episode({ source: "upload" })), 0);
  assert.deepEqual(budgetDecision(episode(), 6), { ok: true, remainingUsd: 5.4 });
  const short = budgetDecision(episode(), 5);
  assert.equal(short.ok, false);
  assert.match((short as { message: string }).message, /Presupuesto insuficiente: .*USD 5\.40.*USD 5\.00\. No se cobró nada/);
  assert.equal(budgetDecision(episode(), null).ok, false, "a paid production needs an explicit maximum");
  assert.equal(budgetDecision(episode({ status: "ready" }), null).ok, true, "nothing left to pay → no maximum needed");
  assert.equal(budgetDecision(episode(), 101).ok, false);
});

test("gasto: comprometido + entregado; un cargo abierto sin resultado guardado es incierto", () => {
  const rows = [
    { idempotency_key: "a", status: "COMMITTED", reserved_usd: "1.8", committed_usd: "1.8" },
    { idempotency_key: "b", status: "SUBMITTED", reserved_usd: "1.8", committed_usd: null },
    { idempotency_key: "c", status: "RECONCILIATION_REQUIRED", reserved_usd: "1.8", committed_usd: null },
    { idempotency_key: "d", status: "REFUNDED", reserved_usd: "1.8", committed_usd: null },
  ];
  assert.deepEqual(summarizeSpend(rows, new Set(["b"])), { calls: 4, committedUsd: 1.8, deliveredOpenUsd: 1.8, uncertain: 1, uncertainUsd: 1.8, spentUsd: 3.6 });
  assert.equal(summarizeSpend(rows.slice(0, 2), new Set(["b"])).uncertain, 0, "result stored → certain, reused at $0");
});

test("reintentos acotados y programación de un solo disparo", () => {
  assert.deepEqual(attemptsDecision(episode({ video_status: "ready", retry_count: 3, video_attempts: 40 })), { ok: true, retryCount: 0 }, "a new production after a delivery starts from zero, whatever the history");
  assert.deepEqual(attemptsDecision(episode({ video_status: "failed", retry_count: 2 })), { ok: true, retryCount: 3 });
  assert.equal(attemptsDecision(episode({ video_status: "blocked", retry_count: MAX_PRODUCTION_ATTEMPTS - 1 })).ok, false);
  assert.equal(attemptsDecision(episode({ video_status: "running", retry_count: MAX_PRODUCTION_ATTEMPTS - 1 }), true).ok, false, "retaking a dead run is a retry");
  const now = Date.parse("2026-10-11T10:00:00Z");
  assert.deepEqual(scheduleDecision(null, now), { ok: true, at: null });
  assert.equal(scheduleDecision("2026-10-11T10:01:00Z", now).ok, false, "too soon");
  assert.equal(scheduleDecision("2026-11-11T10:00:00Z", now).ok, false, "too far");
  assert.deepEqual(scheduleDecision("2026-10-11T12:00:00Z", now), { ok: true, at: "2026-10-11T12:00:00.000Z" });
  assert.equal(scheduleDecision("mañana", now).ok, false);
});

test("solicitud: presupuesto insuficiente → 402 sin tocar la fila; programada → sin despacho ni intento; tope de intentos", async () => {
  let f = fakeService();
  assert.equal((await requestPodcastVideo(f.service, episode(), { budgetUsd: 5 }) as { status: number }).status, 402);
  assert.equal(f.updates.length, 0, "nothing recorded, nothing charged");
  f = fakeService();
  const at = new Date(Date.now() + 3600_000).toISOString();
  const out = await requestPodcastVideo(f.service, episode(), { budgetUsd: 6, scheduleAt: at });
  assert.deepEqual(out, { ok: true, status: "scheduled" });
  assert.equal(f.updates[0].video_status, "scheduled");
  assert.equal(f.updates[0].budget_usd, 6);
  assert.equal(f.updates[0].video_attempts, undefined, "the attempt is counted when it really starts");
  assert.equal(f.updates[0].publish_status, "held");
  assert.equal(f.updates[0].review_status, "pending");
  f = fakeService();
  assert.equal((await requestPodcastVideo(f.service, episode({ video_status: "failed", retry_count: MAX_PRODUCTION_ATTEMPTS - 1 }), { budgetUsd: 6 }) as { status: number }).status, 429);
  f = fakeService();
  await requestPodcastVideo(f.service, episode({ status: "ready", video_status: "ready", video_attempts: 30, retry_count: 0 }), {});
  assert.equal(f.updates[0].video_status, "queued", "not refused by a history of 30 attempts");
  assert.equal(f.updates[0].retry_count, 0);
});

test("programación: el tick reclama una vez (CAS) y re-chequea presupuesto al iniciar", async () => {
  let f = fakeService();
  const claim = await claimScheduled(f.service, episode({ video_status: "scheduled", budget_usd: 6 }));
  assert.equal(claim.claimed, true);
  assert.equal(f.updates[0].video_status, "queued");
  assert.equal(f.updates[0].video_attempts, 1);
  assert.ok(f.filters.some((x) => x === 'eq:["video_status","scheduled"]'));
  assert.equal((await claimScheduled(fakeService(0).service, episode({ video_status: "scheduled", budget_usd: 6 }))).claimed, false, "another tick or request won");
  f = fakeService();
  const blocked = await claimScheduled(f.service, episode({ video_status: "scheduled", budget_usd: 1 }));
  assert.equal(blocked.claimed, false);
  assert.equal((blocked as { blocked?: { kind: string } }).blocked?.kind, "budget");
  assert.equal(f.updates[0].video_status, "blocked");
});

test("revisión: comprobaciones técnicas y defectos, nunca una aprobación", () => {
  const c = buildVideoChecks({
    editorOk: true, editorChecks: [{ name: "video_stream", ok: true }, { name: "loudness", ok: true }], videoSeconds: 1800.04, audioSeconds: 1800, bytes: 600 * 1048576, maxBytes: 900 * 1048576,
    subtitles: true, shots: { videos: 100, photos: 15, cards: 5, total: 120 }, credits: 80,
    spend: { calls: 4, committedUsd: 5.4, deliveredOpenUsd: 0, uncertain: 0, uncertainUsd: 0, spentUsd: 5.4 }, budgetUsd: 6, now: new Date(0),
  });
  assert.ok(c.checks.find((x) => x.id === "budget")?.ok);
  assert.equal(c.checks.find((x) => x.id === "picture")?.ok, false);
  assert.ok(c.defects.some((d) => d.id === "cards" && d.severity === "media"));
  assert.ok(c.defects.some((d) => d.id === "relevance"), "creative relevance is always left to the owner");
  assert.equal("approved" in c, false);
  const over = buildVideoChecks({ editorOk: true, editorChecks: [], videoSeconds: 30, audioSeconds: 30, bytes: 1, maxBytes: 2, subtitles: false, shots: { videos: 0, photos: 3, cards: 0, total: 3 }, credits: 3,
    spend: { calls: 1, committedUsd: 7, deliveredOpenUsd: 0, uncertain: 1, uncertainUsd: 1, spentUsd: 7 }, budgetUsd: 6 });
  assert.ok(over.defects.some((d) => d.id === "budget" && d.severity === "alta"));
  assert.ok(over.defects.some((d) => d.id === "uncertain"));
  assert.ok(over.defects.some((d) => d.id === "photos"));
});

test("avisos: uno por ejecución y tipo; GitHub recibe solo un texto genérico con enlace (repositorio público)", async () => {
  const ep = episode();
  assert.ok(await recordNotice(fakeService().service, ep, "delivered", "run-1"));
  assert.equal(await recordNotice(fakeService(1, true).service, ep, "delivered", "run-1"), null, "duplicate → no second notice");
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes("/issues?")) return new Response("[]", { status: 200 });
    if (url.endsWith("/issues")) return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const f = fakeService();
  const secret = "Presupuesto insuficiente: la producción cuesta hasta USD 5.40 y el título es Mi Secreto";
  const ok = await deliverGithubNotice(f.service, { id: "n1", kind: "budget", message: noticeText("budget", secret) }, { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", NOTICE_MENTION: "hanzmo16-png" }, fetchImpl);
  assert.equal(ok, true);
  const comment = calls.find((c) => c.url.endsWith("/issues/7/comments"));
  assert.ok(comment);
  assert.match(comment!.body!, /@hanzmo16-png .*presupuesto insuficiente/);
  assert.doesNotMatch(comment!.body!, /Secreto|5\.40/, "details stay in the app");
  assert.equal(f.updates[0].channel, "github");
  const unconfigured = fakeService();
  assert.equal(await deliverGithubNotice(unconfigured.service, { id: "n2", kind: "blocked", message: "x" }, {}, fetchImpl), false);
  assert.match(String(unconfigured.updates[0].delivery_error), /sin configurar/);
});

test("worker: comprobación previa antes de cualquier cobro, bloqueo distinto de error, aviso único y publicación detenida", () => {
  const w = readFileSync("scripts/podcast-video-worker.ts", "utf8");
  const pre = w.indexOf("productionSpend(service, episodeId)"), narr = w.indexOf("await runGeneration(service, episode)", w.indexOf("async function produce"));
  assert.ok(pre > 0 && narr > pre, "spend/uncertain/budget preflight runs before the narration");
  assert.match(w, /spendBefore\.uncertain > 0\) throw new BlockError\(UNCERTAIN_CHARGE_MESSAGE\)/);
  assert.match(w, /video_status: blocked \? "blocked" : "failed"/);
  assert.match(w, /review_status: "pending", publish_status: "held", retry_count: 0/);
  assert.match(w, /kind === "notices"[\s\S]*deliverPendingNotices\(service\)/, "app-recorded notices are delivered by the Actions bot");
  assert.match(w, /dueScheduled\(service, EPISODE_COLUMNS, new Date\(\), 1\)/, "one production per scheduled tick");
  const wf = readFileSync(".github/workflows/podcast-video.yml", "utf8");
  assert.match(wf, /schedule:\n\s+- cron: "7,22,37,52 \* \* \* \*"/);
  assert.match(wf, /issues: write/);
  assert.doesNotMatch(wf, /contents: write/);
  const mig = readFileSync("supabase/migrations/20261011010000_production_pilot.sql", "utf8");
  assert.match(mig, /publish_status text not null default 'held'/);
  assert.match(mig, /unique \(episode_id, kind, run_key\)/);
});

/** Query-builder fake: every chain resolves to `answer(table, ops)`; records updates per table. */
function scriptedService(answer: (table: string, ops: string[]) => unknown) {
  const updates: { table: string; patch: Record<string, unknown>; ops: string[] }[] = [];
  const from = (table: string) => {
    const ops: string[] = [];
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = new Proxy({}, { get: (_t, k: string) => {
      if (k === "then") return (r: (v: unknown) => unknown) => { if (patch) updates.push({ table, patch, ops }); return r(answer(table, ops)); };
      if (k === "maybeSingle" || k === "single") return async () => answer(table, [...ops, k]);
      if (k === "update") return (p: Record<string, unknown>) => { patch = p; ops.push("update"); return b; };
      if (k === "insert") return (row: Record<string, unknown>) => { ops.push("insert"); updates.push({ table, patch: row, ops }); return b; };
      return (...a: unknown[]) => { ops.push(`${k}:${JSON.stringify(a)}`); return b; };
    } });
    return b;
  };
  return { service: { from } as never, updates };
}

test("tick programado: token en tabla de servicio, reclama y despacha; si el despacho falla vuelve a programada; bloqueo con un aviso", async () => {
  const { authorizedSchedulerTick, runSchedulerTick } = await import("./pilot-server");
  const token = "a".repeat(64);
  const auth = scriptedService(() => ({ data: { token }, error: null }));
  assert.equal(await authorizedSchedulerTick(auth.service, token), true);
  assert.equal(await authorizedSchedulerTick(auth.service, "b".repeat(64)), false);
  assert.equal(await authorizedSchedulerTick(auth.service, null), false);
  const due = [episode({ id: "e1", video_status: "scheduled", budget_usd: 6 }), episode({ id: "e2", video_status: "scheduled", budget_usd: 1 })];
  const s = scriptedService((table, ops) => {
    if (table === "podcast_episodes" && ops.some((o) => o.startsWith("lte:"))) return { data: due };
    if (table === "podcast_episodes" && ops.includes("update")) return { data: [{ id: "x" }] };
    if (table === "production_notices" && ops.includes("insert")) return { data: { id: "n" }, error: null };
    return { data: null };
  });
  const dispatched: string[] = [];
  const out = await runSchedulerTick(s.service, "*", async (id, kind) => { dispatched.push(`${id}:${kind}`); return false; });
  assert.deepEqual(out, { due: 2, dispatched: 0, blocked: 1, requeued: 1 });
  assert.deepEqual(dispatched, ["e1:video", "e2:notices"], "the over-budget production is never dispatched; its notice goes through the Actions bot");
  const eps = s.updates.filter((u) => u.table === "podcast_episodes").map((u) => u.patch.video_status);
  assert.deepEqual(eps, ["queued", "scheduled", "blocked"], "claimed → dispatch failed → back to scheduled; e2 blocked");
  assert.equal(s.updates.filter((u) => u.table === "production_notices" && u.ops.includes("insert")).length, 1);
});

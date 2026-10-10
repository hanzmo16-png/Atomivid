import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { minimumRunBudgetUsd, narrationCapUsd, runBudgetDecision, runUpperBoundUsd } from "./pilot";
import { narrateEpisode, NarrationCapError } from "./narrate";
import { deliverGithubNotice, isNoticeIssue, pendingNarration } from "./pilot-server";
import type { PodcastEpisode } from "./episode";

test("límite por ejecución: cubre la cota superior (estimación + redondeo por fragmento); nunca se deduce del total", () => {
  assert.equal(runUpperBoundUsd(0, 10), 0);
  assert.equal(runUpperBoundUsd(5.4, 30), 5.403);
  assert.equal(minimumRunBudgetUsd(5.4, 30), 5.41);
  assert.deepEqual(runBudgetDecision(0, 1, { available: false, value: null }), { ok: true, capUsd: null }, "nothing new to pay → no limit needed, even before the migration");
  assert.match((runBudgetDecision(5.4, 30, { available: false, value: null }) as { message: string }).message, /migración/);
  assert.match((runBudgetDecision(5.4, 30, { available: true, value: null }) as { message: string }).message, /máximo de gasto nuevo/);
  assert.match((runBudgetDecision(5.4, 30, { available: true, value: 5.4 }) as { message: string }).message, /insuficiente.*Fija al menos USD 5\.41/);
  assert.deepEqual(runBudgetDecision(5.4, 30, { available: true, value: 5.41 }), { ok: true, capUsd: 5.41 });
  assert.equal(runBudgetDecision(5.4, 30, { available: true, value: 101 }).ok, false);
  // Hard cap for the narration: the lower of the run limit and what is left of the episode's total budget.
  assert.equal(narrationCapUsd(5.41, 6, 1), 5);
  assert.equal(narrationCapUsd(2, 6, 1), 2);
  assert.equal(narrationCapUsd(null, 6, 7), 0, "total already exceeded → nothing new may be charged");
  assert.equal(narrationCapUsd(null, null, 3), null);
});

const EP = { id: "11111111-1111-4111-8111-111111111111", user_id: "u", script: "Una frase de prueba para la narración.", language: "es" as const };

test("narración: se detiene ANTES de un fragmento pagado que superaría el límite (ni proveedor ni registro)", async () => {
  let synth = 0, ledgerTouched = 0;
  const ledger = new Proxy({}, { get: () => () => { ledgerTouched++; throw new Error("ledger must not be touched"); } });
  const deps = {
    ledger, results: { getJson: async () => null, getBytes: async () => null, putBytes: async () => undefined, putJson: async () => undefined },
    voiceProvider: { name: "elevenlabs", synthesize: async () => { synth++; throw new Error("provider must not be called"); } },
    voiceIdentity: { voiceId: "v", modelId: "m", voiceSettingsJson: "{}" }, putAudio: async () => undefined, capUsd: 0,
  } as never;
  await assert.rejects(narrateEpisode(deps, EP), (e: unknown) => e instanceof NarrationCapError && e.capUsd === 0 && e.spentUsd === 0);
  assert.equal(synth, 0);
  assert.equal(ledgerTouched, 0);
  const src = readFileSync("src/lib/podcast/narrate.ts", "utf8");
  assert.match(src, /deps\.capUsd != null && newSpendUsd \+ estimatedCostUsd > deps\.capUsd[\s\S]*storedVoiceResult[\s\S]*throw new NarrationCapError[\s\S]*gatedVoiceSynthesize/, "cap check precedes the paid call; a stored chunk never blocks");
  const worker = readFileSync("scripts/podcast-video-worker.ts", "utf8");
  assert.match(worker, /runBudgetDecision\(budget\.remainingUsd, pending\.chunks, runBudget, [^)]*\)\)?;[\s\S]*runGeneration\(service, episode, Date\.now, \{ capUsd: narrationCapUsd/);
  assert.match(worker, /kind === "narration"[\s\S]*runGeneration\(service, episode, Date\.now, \{ capUsd \}\)/, "background narration is capped too");
  assert.match(readFileSync("src/app/api/podcast/[id]/generate/route.ts", "utf8"), /runGeneration\(service, episode, Date\.now, \{ capUsd \}\)/, "short narration is capped too");
});

function storageService(stored: boolean) {
  const json = JSON.stringify({ audioPath: "x", bytes: 1, sha256: "y" });
  return { storage: { from: () => ({ download: async () => (stored ? { data: new Blob([json]), error: null } : { data: null, error: { message: "not found" } }) }) } } as never;
}
const episode = (over: Partial<PodcastEpisode> = {}): PodcastEpisode => ({ id: EP.id, user_id: "u", title: "t", language: "es", source: "tts", script: "x".repeat(6000), voice_id: "v", voice_name: "n",
  characters: 6000, estimated_usd: 1.2, status: "draft", run_token: null, run_started_at: null, audio_path: null, audio_mime: null, duration_seconds: null,
  audio_sha256: null, audio_bytes: null, loudness: null, cost_usd: null, error: null, created_at: "", updated_at: "", video_status: "none", video_attempts: 0, ...over });

test("pendiente neto: los fragmentos ya pagados y guardados no se cuentan dos veces", async () => {
  const none = await pendingNarration(storageService(false), episode());
  assert.ok(none.usd > 0 && none.chunks >= 1, "nothing stored → the whole narration is pending");
  assert.deepEqual(await pendingNarration(storageService(true), episode()), { usd: 0, chunks: 1 }, "every chunk stored → nothing pending");
  assert.deepEqual(await pendingNarration(storageService(false), episode({ status: "ready" })), { usd: 0, chunks: 1 });
});

test("avisos: solo el issue del propietario o del bot; un issue imitador con el mismo título se ignora", async () => {
  const title = "Avisos de producción de Atomivid";
  assert.equal(isNoticeIssue({ title, user: { login: "hanzmo16-png" } }, "hanzmo16-png"), true);
  assert.equal(isNoticeIssue({ title, user: { login: "github-actions[bot]" } }, "hanzmo16-png"), true);
  assert.equal(isNoticeIssue({ title, user: { login: "intruso" } }, "hanzmo16-png"), false);
  assert.equal(isNoticeIssue({ title, user: { login: "hanzmo16-png" }, pull_request: {} }, "hanzmo16-png"), false);
  const posted: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.includes("/issues?")) return new Response(JSON.stringify([{ number: 3, title, user: { login: "intruso" } }, { number: 7, title, user: { login: "hanzmo16-png" } }]), { status: 200 });
    posted.push(url);
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const service = { from: () => ({ update: () => ({ eq: async () => ({}) }) }) } as never;
  assert.equal(await deliverGithubNotice(service, { id: "n", kind: "delivered", message: "x" }, { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", NOTICE_MENTION: "hanzmo16-png" }, fetchImpl), true);
  assert.deepEqual(posted, ["https://api.github.com/repos/o/r/issues/7/comments"]);
});

test("migración del límite por ejecución: aditiva, acotada y leída aparte (la app funciona antes de aplicarla)", () => {
  const sql = readFileSync("supabase/migrations/20261011040000_pilot_run_budget.sql", "utf8");
  assert.match(sql, /add column if not exists run_budget_usd numeric\(10,4\) check \(run_budget_usd is null or \(run_budget_usd >= 0 and run_budget_usd <= 100\)\)/);
  assert.doesNotMatch(sql, /\b(drop|delete|truncate|update)\b/i);
  assert.doesNotMatch(readFileSync("src/lib/podcast/server.ts", "utf8").match(/EPISODE_COLUMNS = "[^"]*"/)![0], /run_budget_usd/, "never in the shared column list: queries keep working before the migration");
});

test("compatibilidad: una producción solicitada antes del límite por ejecución conserva la autorización que el propietario dio entonces", () => {
  // Column readable, value empty (request older than the column): the old per-production maximum is the run limit.
  assert.deepEqual(runBudgetDecision(5.4, 30, { available: true, value: null }, 6), { ok: true, capUsd: 6 });
  assert.match((runBudgetDecision(5.4, 30, { available: true, value: null }, 5) as { message: string }).message, /insuficiente/, "an old authorisation below the run's upper bound still refuses");
  assert.match((runBudgetDecision(5.4, 30, { available: true, value: null }, null) as { message: string }).message, /máximo de gasto nuevo/);
  assert.match((runBudgetDecision(5.4, 30, { available: false, value: null }, 6) as { message: string }).message, /migración/, "never without the column");
  assert.deepEqual(runBudgetDecision(5.4, 30, { available: true, value: 5.41 }, 99), { ok: true, capUsd: 5.41 }, "a stored run limit always wins");
  // New requests always write the column (0 when nothing new can be charged), so "empty" only means "older".
  const jobs = readFileSync("src/lib/podcast/video-jobs.ts", "utf8");
  assert.match(jobs, /options\.runBudgetColumn \? \{ run_budget_usd: runBudgetUsd \?\? 0 \}/);
  assert.doesNotMatch(jobs, /runBudgetDecision\([^)]*budgetUsd\)/, "the request never falls back to the total budget");
  assert.match(readFileSync("scripts/podcast-video-worker.ts", "utf8"), /runBudgetDecision\(budget\.remainingUsd, pending\.chunks, runBudget, episode\.budget_usd/);
});

test("migración del límite: no la detiene el detector de SQL destructivo del aplicador", () => {
  const re = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|update\s+public\.|alter\s+column\s+\w+\s+type|rename\s+(table|column))\b/i;
  const src = readFileSync("scripts/apply-supabase-migration.ts", "utf8");
  assert.ok(src.includes(re.source), "same pattern as the applier");
  const sql = readFileSync("supabase/migrations/20261011040000_pilot_run_budget.sql", "utf8");
  assert.deepEqual(sql.split("\n").filter((l) => re.test(l.split("--")[0])), []);
});

/**
 * Control de costos (2026-10-18) — B/D: reservations, recovery and honest states. ROJO = behaviour on main
 * (bb3e4549), VERDE = this branch. Interruption before/after sending, timeouts with uncertain result and
 * recovery without duplicate spend are already proven by paid-calls/gate.test.ts (B1-1/2, B1-4, B1-5,
 * B1-9, COST-6) and the T32 suites (anthropic-401/-http-policy/-http-concurrency, gate-settlement), which
 * run in the same `test:spend`/`test:unit` batteries; this file covers what those do not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { submitWithSupply } from "./server";
import { JobEnvelopeExhaustedError, JobEnvelopeMismatchError } from "./job";
import { RESUME_SUPPLY_UNAVAILABLE, START_SUPPLY_UNAVAILABLE } from "./readiness";
import { DirectorUnavailableError } from "@/lib/video/director/render-access";
import { DeliverableUnverifiedError, verifyDeliverableMp4 } from "@/lib/video/deliverable-check";
import { simulatedIssueText, SIMULATION_NOTICE, type ReelInspection } from "@/lib/video/director/reel-inspection";
import { DirectorInspectionPanel } from "@/components/video/DirectorInspectionPanel";
import { STALE_ATTEMPT_CLOSED } from "@/lib/video/start-outcome";

const ROOT = path.resolve(__dirname, "../../..");
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const NO_CHARGE_CLAIM = /no se (gener[oó]|cobr[oó]|reserv[oó])|ningún cargo|sin cobro/i;

test("ROJO/VERDE: retrying a STALLED render could never reserve (state predicate of pi_reserve_job_supply); now the stalled attempt is closed first", () => {
  const sql = src("supabase/migrations/20261005150229_provider_supply_job_reservations.sql");
  // The deployed predicate, verbatim:
  assert.ok(sql.includes("not ((v.status='processing' and v.render_attempts=p_attempt)\n or (v.status in ('script_ready','failed') and v.render_attempts+1=p_attempt))"));
  const accepts = (status: string, attempts: number, p: number) => (status === "processing" && attempts === p) || (["script_ready", "failed"].includes(status) && attempts + 1 === p);
  // A stalled attempt N=1: the route asks for N+1.
  assert.equal(accepts("processing", 1, 2), false, "ROJO: «request state changed» → shown to the customer as missing capacity");
  assert.equal(accepts("failed", 1, 2), true, "VERDE: after closing the stalled attempt the same reservation is accepted");
  const route = src("src/app/api/generate/[id]/render/route.ts");
  const close = route.indexOf('if (videoRequest.status === "processing") {');
  const reserve = route.indexOf("await reserveJobSupply(service, id, videoRequest.render_attempts + 1, demands);");
  assert.ok(close > 0 && close < reserve, "the stalled attempt is closed before the new reservation");
  const block = route.slice(close, reserve);
  assert.match(block, /\.eq\("status", "processing"\)\.eq\("render_attempts", videoRequest\.render_attempts\)/, "compare-and-set on the very attempt judged stale");
  assert.match(block, /render_started_at/, "…and on its start time");
  assert.match(block, /if \(!closed\.data\?\.length\) return NextResponse\.json\(\{ error: "El estado cambió/, "a lost race starts nothing");
  assert.match(block, /await releaseUnusedJobSupply\(service, id, videoRequest\.render_attempts\)/, "only the stalled attempt's UNUSED envelope is released");
  assert.doesNotMatch(STALE_ATTEMPT_CLOSED, NO_CHARGE_CLAIM, "the stalled attempt may have paid steps: no zero-charge claim");
});

test("release only what is provably unused: pi_release_job_supply touches OPEN envelopes; uncertain paid calls stay held in the ledger", () => {
  const sql = src("supabase/migrations/20261005150229_provider_supply_job_reservations.sql");
  assert.match(sql, /update public\.pi_supply_job_reservations set status='RELEASED'[\s\S]*?where project_id=p_request_id::text and render_attempt=p_attempt and status='OPEN';/);
  // Held capacity counts uncertain rows regardless of envelopes (pi_supply_state).
  assert.match(src("supabase/migrations/20261005143935_provider_supply_controls.sql"), /'SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED'/);
  // ROJO: a timed-out worker left its envelope OPEN forever. VERDE: released only after this cleanup closed the attempt.
  const mark = src("scripts/mark-render-failed.ts");
  const cas = mark.indexOf('.eq("render_attempts", saved.attempt)');
  const release = mark.indexOf("await releaseUnusedJobSupply(service, requestId, saved.attempt)");
  assert.ok(cas > 0 && release > cas && mark.slice(cas, release).includes("if (closed?.length)"), "release gated on the CAS that closed THIS attempt");
});

test("ROJO/VERDE: an envelope used up in the MIDDLE of a production no longer says «no se generó ni se cobró nada»", async () => {
  const service = { rpc: async () => ({ data: { submitted: false, reason: "job envelope exhausted" }, error: null }) } as unknown as SupabaseClient;
  const op = { idempotencyKey: "k", provider: "openai", reservedUsd: 0.5, capacityUnits: null } as never;
  await assert.rejects(submitWithSupply(service, op), (e: unknown) => e instanceof JobEnvelopeExhaustedError);
  const old = "La configuración de límites de producción no coincide entre el inicio y el procesamiento. No se generó ni se cobró nada; avisa a soporte para corregirla antes de reintentar.";
  assert.match(old, NO_CHARGE_CLAIM, "ROJO: the text main stored after real spend");
  const exhausted = new JobEnvelopeExhaustedError("openai").customerMessage;
  assert.doesNotMatch(exhausted, NO_CHARGE_CLAIM);
  assert.match(exhausted, /pueden haber tenido costo/);
  assert.doesNotMatch(new JobEnvelopeMismatchError("openai").customerMessage, NO_CHARGE_CLAIM, "a resumed attempt may hold earlier paid steps");
  // Neither is retried blindly: support reviews it first.
  assert.match(src("src/lib/video/run-job.ts"), /error instanceof JobEnvelopeMismatchError \|\| error instanceof JobEnvelopeExhaustedError \|\| error instanceof DeliverableUnverifiedError/);
});

test("ROJO/VERDE: Director refusal and resume claims now only state what is proven", () => {
  const director = new DirectorUnavailableError("account_not_enabled").customerMessage;
  assert.doesNotMatch(director, /No se reservó ni se cobró nada/, "the route had already reserved");
  assert.match(director, /antes de cualquier llamada de pago nueva/);
  // The start (nothing ran yet) keeps its proven claim; the resume of an advanced production does not make it.
  assert.match(START_SUPPLY_UNAVAILABLE, /ningún cargo/);
  assert.doesNotMatch(RESUME_SUPPLY_UNAVAILABLE, NO_CHARGE_CLAIM);
  assert.match(RESUME_SUPPLY_UNAVAILABLE, /no tienes que recargar nada/);
  assert.match(src("src/app/api/generate/[id]/resume/route.ts"), /error: RESUME_SUPPLY_UNAVAILABLE/);
});

test("«completed» requires a playable file: a real MP4 passes; garbage, audio-only or too short is refused (and never claims no charge)", async (t) => {
  const ffmpeg = ffmpegInstaller.path;
  if (!fs.existsSync(ffmpeg)) { t.skip("ffmpeg not installed"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deliverable-"));
  const mp4 = path.join(dir, "ok.mp4"), audio = path.join(dir, "audio.mp4"), junk = path.join(dir, "junk.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mp4]);
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "2", "-c:a", "aac", audio]);
  fs.writeFileSync(junk, Buffer.from("not a video at all"));
  const ok = await verifyDeliverableMp4(mp4, { minSeconds: 1 });
  assert.ok(ok.durationSeconds > 1.5 && ok.width === 320 && ok.hasAudio);
  for (const [file, opts, reason] of [[junk, {}, "probe failed"], [audio, {}, "no video stream"], [mp4, { minSeconds: 10 }, "shorter than narration"]] as const) {
    await assert.rejects(verifyDeliverableMp4(file, opts), (e: unknown) => e instanceof DeliverableUnverifiedError && e.reason === reason, `${file} ${reason}`);
  }
  assert.doesNotMatch(new DeliverableUnverifiedError("x").customerMessage, NO_CHARGE_CLAIM);
  // Wired before the upload that precedes «completed», in both Reel and Avatar (Long Form already verifies).
  for (const file of ["src/lib/video/generate-video.ts", "src/lib/video/avatar/pipeline.ts"]) {
    const s = src(file);
    assert.ok(s.indexOf("await verifyDeliverableMp4(outputPath") > 0 && s.indexOf("await verifyDeliverableMp4(outputPath") < s.lastIndexOf("final.mp4"), file);
  }
});

test("D. the simulated Director panel never reads like the customer's balance: BUDGET_EXCEEDED / LICENSE_PENDING are worded as simulation", () => {
  const rojo = "BUDGET_EXCEEDED: 0.04 > 0 (estimates, never an authorisation)";
  assert.match(rojo, /^BUDGET_EXCEEDED/, "ROJO: the raw line the panel printed");
  const budget = simulatedIssueText({ code: "BUDGET_EXCEEDED", detail: "0.04 > 0 (estimates, never an authorisation)" });
  assert.match(budget, /^Simulación: este plan pediría material nuevo \(máx\. estimado USD 0\.04\)/);
  assert.match(budget, /No es tu saldo\./);
  assert.match(simulatedIssueText({ code: "LICENSE_PENDING", detail: "asset x licence NEEDS_REVIEW", shotId: "s1" }), /^Simulación \(plano s1\): la licencia del material se confirma con el clip real al generar\./);
  const inspection = { status: "issues", mode: "proposal", executable: false, paidCalls: 0, storyboardSource: "simulated", totalSeconds: 10, shots: [],
    issues: [{ code: "BUDGET_EXCEEDED", severity: "error", detail: "0.04 > 0 (estimates, never an authorisation)" }], metrics: null, sequences: [], renderRequest: "proposal_only",
    note: "n", dataCards: [], preflightBlockers: [] } as unknown as ReelInspection;
  const html = renderToStaticMarkup(DirectorInspectionPanel({ inspection }));
  assert.ok(html.includes(SIMULATION_NOTICE.replace(/&/g, "&amp;")) || html.includes("Observaciones de la simulación del Director"));
  assert.doesNotMatch(html, /BUDGET_EXCEEDED:/, "no raw code line");
});

test("D. a failed attempt keeps a visible «Revisar guion» (navigation only) and the review page decodes the stored failure", () => {
  const card = src("src/components/video/RequestCard.tsx");
  assert.match(card, /request\.status === "failed" && Boolean\(request\.script_json\) && !isLongForm && \(\s*<Link href=\{`\/dashboard\/review\/\$\{request\.id\}`\}/);
  const view = src("src/components/video/ResultView.tsx");
  assert.match(view, /request\.status === "failed" && Boolean\(request\.script_json\) && !isLongForm && \(\s*<div className="mt-4 flex justify-center">\s*<LinkButton href=\{`\/dashboard\/review\/\$\{request\.id\}`\}>/);
  // ROJO: the raw `[[action:…]]`-tagged text reached the review screen.
  const page = src("src/app/dashboard/review/[id]/page.tsx");
  assert.doesNotMatch(page, /errorMessage=\{data\.error_message\}/);
  assert.match(page, /errorMessage=\{data\.error_message \? renderFailureMessage\(data\.error_message\) : null\}/);
  // Opening the review generates nothing: the page only reads and runs the zero-cost simulated inspection.
  assert.doesNotMatch(page, /generateScriptForRequest|reserveJobSupply|fetch\(/);
  // The cost-change confirmation keeps the script (no reset) and sends the accepted ceiling explicitly.
  const review = src("src/app/dashboard/review/[id]/ScriptReview.tsx");
  assert.match(review, /body: JSON\.stringify\(\{ acceptedCeilingUsd \}\)/);
  assert.match(review, /onClick=\{\(\) => generateFinalVideo\(\)\}/, "the main button never passes the click event as an accepted ceiling");
});

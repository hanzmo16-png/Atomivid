import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { decideAvatarRecovery, loadAvatarRecovery, type AvatarRecovery } from "./recovery";
import { RequestCard } from "@/components/video/RequestCard";
import { ScriptReview } from "@/app/dashboard/review/[id]/ScriptReview";
import type { VideoRequestSummary } from "@/lib/video/request-view";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{el}</AppRouterContext.Provider>);

// The real production state of avatar 6dad04ec (2026-10-09): failed on attempt 1 before reaching HeyGen.
const REAL = { status: "failed", render_attempts: 1, avatar_provider_video_job_id: null, video_path: null };
const RESERVED_ONLY = [{ status: "RESERVED", method: "generate_video", provider_job_id: null }];

test("avatar fallido antes del proveedor (estado real 6dad04ec): reintento seguro", () => {
  const r = decideAvatarRecovery(REAL, RESERVED_ONLY);
  assert.equal(r.action, "retry");
  assert.equal(decideAvatarRecovery(REAL, []).action, "retry");
  assert.equal(decideAvatarRecovery(REAL, [{ status: "REFUNDED", method: "generate_video", provider_job_id: null }]).action, "retry");
});

test("enviado, incierto o completado: nunca otra generación; job aceptado: se recupera ese resultado", () => {
  for (const status of ["SUBMITTED", "RECONCILIATION_REQUIRED"]) {
    const r = decideAvatarRecovery(REAL, [{ status, method: "generate_video", provider_job_id: null }]);
    assert.deepEqual([r.action, r.action === "none" && r.reason], ["none", "reconcile"], status);
  }
  for (const op of [{ status: "COMMITTED", method: "generate_video", provider_job_id: null }, { status: "PROVIDER_JOB_RECORDED", method: "generate_video", provider_job_id: "j" }]) {
    assert.equal(decideAvatarRecovery(REAL, [op]).action, "none", op.status);
  }
  const accepted = decideAvatarRecovery({ ...REAL, avatar_provider_video_job_id: "job-1" }, [{ status: "PROVIDER_JOB_RECORDED", method: "generate_video", provider_job_id: "job-1" }]);
  assert.equal(accepted.action, "recover_provider_job");
  assert.equal(decideAvatarRecovery({ ...REAL, video_path: "u/r/final.mp4" }, []).action, "none");
  assert.equal(decideAvatarRecovery({ ...REAL, render_attempts: 3 }, RESERVED_ONLY).action, "none");
});

test("si el historial de cobros no se puede leer, no se ofrece reintento (falla cerrado)", async () => {
  const broken = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: "down" } }) }) }) } as never;
  assert.equal((await loadAvatarRecovery(broken, "r", REAL)).action, "none");
  const ok = { from: () => ({ select: () => ({ eq: async () => ({ data: RESERVED_ONLY, error: null }) }) }) } as never;
  assert.equal((await loadAvatarRecovery(ok, "r", REAL)).action, "retry");
});

const card = (over: Partial<VideoRequestSummary>, avatarRecovery?: AvatarRecovery) => wrap(<RequestCard nowMs={Date.parse("2026-10-09T01:00:00Z")} avatarRecovery={avatarRecovery}
  request={{ id: "6dad04ec-c77f-4df7-9391-73382ac8d9f5", mode: "avatar", topic: "Prueba avatar", style: "s", duration_seconds: 35, language: "es", status: "failed", video_path: null,
    error_message: "No se pudo reservar un intento único. (Código: 278cc35b)", script_json: { segments: [] }, progress_stage: null, render_attempts: 1, render_started_at: null,
    created_at: "2026-10-08T21:59:50Z", ...over } as VideoRequestSummary} />);

test("historial: el avatar fallido muestra «Reintentar» solo si el ledger lo permite; si no, explica por qué", () => {
  assert.match(card({}, decideAvatarRecovery(REAL, RESERVED_ONLY)), />Reintentar</);
  const blocked = card({}, decideAvatarRecovery(REAL, [{ status: "RECONCILIATION_REQUIRED", method: "generate_video", provider_job_id: null }]));
  assert.doesNotMatch(blocked, />Reintentar</);
  assert.match(blocked, /debe conciliarse antes de reintentar/);
  assert.match(card({ avatar_provider_video_job_id: "job-1" }, decideAvatarRecovery({ ...REAL, avatar_provider_video_job_id: "job-1" }, [])), />Recuperar video</);
  // No decision computed (e.g. not loaded): no button — never a guess.
  assert.doesNotMatch(card({}), />Reintentar</);
  // Other modes unchanged.
  assert.match(card({ mode: "visual" }), />Reintentar</);
});

const review = (recovery?: Parameters<typeof ScriptReview>[0]["recovery"]) => wrap(<ScriptReview requestId="r" status="failed" initialScript={{ segments: [{ text: "hola", visualQuery: "x" }] } as never}
  errorMessage="No se pudo reservar un intento único." usesRecording recovery={recovery} />);

test("revisar grabación (fallido): la acción segura está en la misma pantalla; nunca promete una acción inexistente", () => {
  const action = review({ kind: "action", label: "Reintentar", note: "Se reutilizan la misma foto y grabación." });
  assert.match(action, />Reintentar</);
  assert.match(action, /Se reutilizan la misma foto y grabación/);
  assert.doesNotMatch(action, /Vuelve al historial para reintentar/);
  const blocked = review({ kind: "blocked", message: "Hay un envío al proveedor con resultado incierto." });
  assert.doesNotMatch(blocked, /Vuelve al historial para reintentar/);
  assert.match(blocked, /resultado incierto/);
  assert.doesNotMatch(blocked, />Reintentar</);
});

test("detalle del video (fallido): misma acción segura o el motivo; nunca una acción inexistente", async () => {
  const { ResultView } = await import("@/components/video/ResultView");
  const req = { id: "6dad04ec-c77f-4df7-9391-73382ac8d9f5", mode: "avatar", topic: "Prueba avatar", style: "s", duration_seconds: 35, language: "es", status: "failed",
    video_path: null, error_message: "No se pudo reservar un intento único. (Código: 278cc35b)", script_json: null, progress_stage: null, render_attempts: 1, render_started_at: null,
    created_at: "2026-10-08T21:59:50Z" } as unknown as VideoRequestSummary;
  const ok = wrap(<ResultView request={req} nowMs={0} avatarRecovery={decideAvatarRecovery(REAL, RESERVED_ONLY)} />);
  assert.match(ok, />Reintentar</);
  assert.match(ok, /misma foto y grabación/);
  const blocked = wrap(<ResultView request={req} nowMs={0} avatarRecovery={decideAvatarRecovery(REAL, [{ status: "SUBMITTED", method: "generate_video", provider_job_id: null }])} />);
  assert.doesNotMatch(blocked, />Reintentar</);
  assert.match(blocked, /debe conciliarse/);
});

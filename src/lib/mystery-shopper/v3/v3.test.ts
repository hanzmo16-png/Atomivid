import test from "node:test";
import assert from "node:assert/strict";
import { classifyAuth } from "./auth-outcome";
import { sanitize, detectDeadButton, detectFrozenScreen, detectJsErrors, detectNavigationFailure, detectProgress, detectMedia, detectProviderFailure, detectDuplicateCharges, detectMobileLayout, detectRegressions, sortIncidents } from "./detect";
import { certifyModule, certificationMatrix, evidenceFromJob, type RunEvidence } from "./certify";
import { costMatrix, costTotals, spendGuard } from "./costs";
import { smoke } from "../../../../scripts/mystery-shopper/smoke";
import { preflight } from "../../../../scripts/mystery-shopper/qa-preflight";
import { dailySummary } from "../../../../scripts/mystery-shopper/daily-report";

const ctx = { module: "reels" as const, screen: "/dashboard/new", repro: ["Entrar con la cuenta QA", "Abrir Reels"] };

test("run #18: /login?error=Correo o contraseña incorrectos → BLOCKED bad_credentials P0 (no timeout genérico)", () => {
  const o = classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://atomivid.vercel.app/login?error=Correo%20o%20contrase%C3%B1a%20incorrectos.", timedOut: false });
  assert.equal(o.kind, "bad_credentials"); assert.equal(o.state, "BLOCKED"); assert.equal(o.severity, "P0");
  assert.match(o.humanGate!, /MYSTERY_SHOPPER_QA/);
});
test("auth: panel = PASS; sin secretos = BLOCKED; sin confirmar; rate limit; timeout sin error = FAIL", () => {
  assert.equal(classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://x/dashboard" }).state, "PASS");
  assert.equal(classifyAuth({ hasEmail: false, hasPassword: true, finalUrl: null }).kind, "missing_secrets");
  assert.equal(classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://x/login", alertText: "Confirma tu correo antes de iniciar sesión" }).kind, "email_unconfirmed");
  assert.equal(classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://x/login?error=Demasiados%20intentos" }).kind, "rate_limited");
  const t = classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://x/login", timedOut: true });
  assert.equal(t.kind, "timeout"); assert.equal(t.state, "FAIL");
  assert.equal(classifyAuth({ hasEmail: true, hasPassword: true, finalUrl: "https://x/dashboardx" }).state, "FAIL");
});

test("sanitize: quita secretos, JWT, tokens, claves y enmascara correos", () => {
  const s = sanitize("pw=Sup3rS3cret! jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop Bearer abcdefghijklmnopqrstu sk-abcdefghijklmnop1234 hola qa.tester@example.com ?token=xyz&a=1", ["Sup3rS3cret!"]);
  assert.doesNotMatch(s, /Sup3rS3cret|eyJhbGci|abcdefghijklmnopqrstu|sk-abcdefghijklmnop1234|tester@|token=xyz/);
  assert.match(s, /qa\.\*\*\*@example\.com/);
  assert.equal(sanitize(s), s);
});

test("detección: botón inoperante, congelada, JS, navegación, sesión perdida", () => {
  assert.equal(detectDeadButton(ctx, { label: "Generar", urlChanged: false, domMutations: 0, requests: 0, dialogOrToast: false, disabled: false, waitedMs: 3000 })?.severity, "P1");
  assert.equal(detectDeadButton(ctx, { label: "Generar", urlChanged: false, domMutations: 0, requests: 0, dialogOrToast: false, disabled: true, waitedMs: 3000 }), null);
  assert.equal(detectDeadButton(ctx, { label: "Generar", urlChanged: false, domMutations: 3, requests: 0, dialogOrToast: false, disabled: false, waitedMs: 3000 }), null);
  assert.equal(detectFrozenScreen(ctx, { identicalFrames: 13, frameIntervalMs: 5000, spinnerVisible: true, mainThreadBlockedMs: 0 })?.kind, "frozen_screen");
  assert.equal(detectFrozenScreen(ctx, { identicalFrames: 1, frameIntervalMs: 5000, spinnerVisible: false, mainThreadBlockedMs: 6000 })?.severity, "P0");
  assert.equal(detectFrozenScreen(ctx, { identicalFrames: 3, frameIntervalMs: 5000, spinnerVisible: true, mainThreadBlockedMs: 0 }), null);
  const js = detectJsErrors(ctx, { pageErrors: ["TypeError: x is undefined", "ResizeObserver loop limit exceeded"], consoleErrors: ["a", "b", "c"] });
  assert.deepEqual(js.map((i) => i.severity), ["P1", "P2"]);
  assert.equal(detectNavigationFailure(ctx, { url: "/x", httpStatus: 502, timedOut: false, redirectedToLogin: false, authenticated: true })?.severity, "P0");
  assert.equal(detectNavigationFailure(ctx, { url: "/x", httpStatus: 200, timedOut: false, redirectedToLogin: true, authenticated: true })?.kind, "auth_error");
  assert.equal(detectNavigationFailure(ctx, { url: "/x", httpStatus: 200, timedOut: false, redirectedToLogin: false, authenticated: true }), null);
});

test("detección: progreso interminable, retroceso, fuera de rango, estancado", () => {
  const endless = detectProgress(ctx, [{ t: 0, pct: 10 }, { t: 31 * 60_000, pct: 40 }], { maxTotalMs: 30 * 60_000, maxStallMs: 120_000 });
  assert.ok(endless.some((i) => i.kind === "endless_generation" && i.severity === "P0"));
  const back = detectProgress(ctx, [{ t: 0, pct: 50 }, { t: 1000, pct: 20 }, { t: 2000, pct: 120 }], { maxTotalMs: 9e9, maxStallMs: 9e9 });
  assert.equal(back.filter((i) => i.kind === "wrong_progress").length, 2);
  const stall = detectProgress(ctx, [{ t: 0, pct: 60 }, { t: 100_000, pct: 60 }, { t: 200_000, pct: 60 }], { maxTotalMs: 9e9, maxStallMs: 150_000 });
  assert.ok(stall.some((i) => /quieto/.test(i.title)));
  assert.equal(detectProgress(ctx, [{ t: 0, pct: 0 }, { t: 60_000, pct: 50 }, { t: 120_000, pct: 100, state: "completado" }], { maxTotalMs: 30 * 60_000, maxStallMs: 120_000 }).length, 0);
});

test("detección: archivos corruptos, duración (2,16 s para 10 min = P0), silencio, aspecto 9:16", () => {
  assert.equal(detectMedia(ctx, { file: "a.mp3", decodeOk: false, container: null, durationSeconds: null, requestedSeconds: 600, expectKind: "mp3" })[0].kind, "corrupt_file");
  const d = detectMedia(ctx, { file: "a.mp3", decodeOk: true, container: "mp3", durationSeconds: 2.16, requestedSeconds: 600, expectKind: "mp3" });
  assert.equal(d[0].kind, "wrong_duration"); assert.equal(d[0].severity, "P0");
  assert.equal(detectMedia(ctx, { file: "r.mp4", decodeOk: true, container: "mov,mp4,m4a", durationSeconds: 30.4, requestedSeconds: 30, width: 1080, height: 1920, expectAspect: "9:16", expectKind: "mp4" }).length, 0);
  const wrong = detectMedia(ctx, { file: "r.mp4", decodeOk: true, container: "mov,mp4,m4a", durationSeconds: 30, requestedSeconds: 30, width: 1920, height: 1080, expectAspect: "9:16", expectKind: "mp4", meanVolumeDb: -70, maxSilenceSeconds: 5 });
  assert.deepEqual(wrong.map((i) => i.severity).sort(), ["P0", "P1", "P2"]);
});

test("detección: proveedores, cobros duplicados, móvil, regresiones; orden por severidad", () => {
  assert.deepEqual(detectProviderFailure(ctx, [{ provider: "ElevenLabs", status: 402, message: "quota" }, { provider: "fal", status: 200, message: "" }]).map((i) => i.severity), ["P0"]);
  const dup = detectDuplicateCharges(ctx, [{ id: "c1", key: "k1", projectId: "p", action: "render", amount: 5, at: 0 }, { id: "c2", key: "k1", projectId: "p", action: "render", amount: 5, at: 1000 }]);
  assert.ok(dup.length >= 1 && dup.every((i) => i.severity === "P0"));
  assert.equal(detectDuplicateCharges(ctx, [{ id: "c1", key: "k1", projectId: "p", action: "render", amount: 5, at: 0 }, { id: "c2", key: "k2", projectId: "p", action: "render", amount: 5, at: 10 * 60_000 }]).length, 0);
  assert.equal(detectMobileLayout(ctx, { viewportWidth: 390, horizontalOverflowPx: 60, smallTargets: 6, clippedTexts: 1 }).length, 3);
  assert.equal(detectMobileLayout(ctx, { viewportWidth: 1440, horizontalOverflowPx: 60, smallTargets: 60 }).length, 0);
  const reg = detectRegressions(ctx, { login: true, menu: true }, { login: true, menu: false }, "aaaaaaaaaaaa", "bbbbbbbbbbbb");
  assert.equal(reg.length, 1);
  const all = sortIncidents([...reg, ...dup]);
  assert.equal(all[0].severity, "P0");
  for (const i of all) { assert.ok(i.module && i.repro.length && i.fixProposal); }
});

const ev = (o: Partial<RunEvidence>): RunEvidence => ({ module: "reels", kind: "free", target: "production", authenticated: true, allCriteriaMet: true, p0Count: 0, confirmedFailure: null, externalBlock: null, spendUsd: 0, mediaValidated: false, at: "2026-11-24T10:00:00Z", ...o });

test("certificación: un fixture/simulado NUNCA es GO; real validado con gasto = GO_REAL; gratuito OK = GO_TECNICO", () => {
  assert.equal(certifyModule("reels", [ev({ kind: "fixture" }), ev({ kind: "simulated", spendUsd: 1, mediaValidated: true })]).cls, "BLOCKED");
  assert.equal(certifyModule("reels", [ev({ kind: "free", target: "local" })]).cls, "BLOCKED");
  assert.equal(certifyModule("reels", [ev({})]).cls, "GO_TECNICO");
  assert.equal(certifyModule("reels", [ev({ kind: "real", spendUsd: 0.5, mediaValidated: true })]).cls, "GO_REAL");
  assert.equal(certifyModule("reels", [ev({ kind: "real", spendUsd: 0, mediaValidated: true })]).cls, "GO_TECNICO");
  assert.equal(certifyModule("reels", [ev({ kind: "real", spendUsd: 0.5, mediaValidated: false })]).cls, "GO_TECNICO");
});
test("certificación: fallo confirmado = NO_GO aunque antes hubo GO; bloqueo externo = BLOCKED con motivo", () => {
  const rows = [ev({ kind: "real", spendUsd: 0.5, mediaValidated: true, at: "2026-11-20T00:00:00Z" }), ev({ confirmedFailure: "El MP4 dura 2 s", allCriteriaMet: false })];
  assert.equal(certifyModule("reels", rows).cls, "NO_GO");
  const b = certifyModule("account-nav", [ev({ module: "account-nav", authenticated: false, allCriteriaMet: false, externalBlock: "La cuenta QA no entra" })]);
  assert.equal(b.cls, "BLOCKED"); assert.match(b.reason, /QA/);
  assert.equal(certificationMatrix([]).length, 7);
  assert.ok(certificationMatrix([]).every((r) => r.cls === "BLOCKED"));
});
test("certificación: adaptador del trabajo 2.0 (run #18 BLOQUEADO por login) → BLOCKED", () => {
  const e = evidenceFromJob({ job: { product: "account-nav", mode: "gratuito", target: { kind: "production" } }, status: { state: "bloqueada", finishedAt: "2026-11-24T01:22:50Z", updatedAt: "2026-11-24T01:22:50Z", workerRunUrl: "u", result: { verdict: "BLOQUEADO", coverage: "NO_EVALUADO", critical: "No se pudo entrar a ATOMIVID.", humanGate: null } } });
  assert.ok(e); assert.equal(e!.authenticated, false);
  assert.equal(certifyModule("account-nav", [e!]).cls, "BLOCKED");
});

test("costos: una sola matriz consolidada con topes; guardia de gasto con USD 0 lo rechaza todo", () => {
  const m = costMatrix(); const t = costTotals(m);
  assert.ok(m.every((l) => l.capUsd >= l.estimateUsd && l.cancel));
  assert.ok(t.estimateUsd > 0 && t.capUsd <= 10);
  assert.equal(spendGuard({ approvedBudgetUsd: 0, spentUsd: 0, nextEstimateUsd: 0.1, enabled: true }).ok, false);
  assert.equal(spendGuard({ approvedBudgetUsd: 5, spentUsd: 4.95, nextEstimateUsd: 0.1, enabled: true }).ok, false);
  assert.equal(spendGuard({ approvedBudgetUsd: 5, spentUsd: 0, nextEstimateUsd: 0.1, enabled: false }).ok, false);
  assert.equal(spendGuard({ approvedBudgetUsd: 5, spentUsd: 0, nextEstimateUsd: 0.1, enabled: true }).ok, true);
});

test("smoke: detecta ruta privada abierta sin sesión y API admin abierta (con fetch simulado)", async () => {
  const fake = (async (u: string) => {
    const p = new URL(u).pathname;
    const h = new Headers();
    if (p === "/dashboard/new") return new Response("", { status: 200 });
    if (p.startsWith("/dashboard")) { h.set("location", "/login?redirectedFrom=" + p); return new Response(null, { status: 307, headers: h }); }
    if (p.startsWith("/api/admin")) return new Response("{}", { status: 200 });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await smoke("https://atomivid.vercel.app", fake);
  assert.equal(r.total, 10); assert.equal(r.pass, 8); assert.equal(r.critical, 2);
});

test("preflight QA: distingue correo inexistente / contraseña incorrecta / OK, sin imprimir secretos", async () => {
  const base = { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key", MYSTERY_SHOPPER_QA_EMAIL: "qa.shopper@example.com", MYSTERY_SHOPPER_QA_PASSWORD: "pw-should-not-leak" };
  const mkFetch = (users: object[], pwOk: boolean) => (async (u: string) => {
    const url = String(u);
    if (url.includes("/auth/v1/admin/users")) return new Response(JSON.stringify({ users, aud: "authenticated" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("grant_type=password")) return new Response(JSON.stringify(pwOk ? { access_token: "t" } : { error: "invalid_grant" }), { status: pwOk ? 200 : 400 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const orig = globalThis.fetch;
  try {
    const user = { id: "1", email: "qa.shopper@example.com", email_confirmed_at: "2026-11-24T00:00:00Z", banned_until: null, app_metadata: {} };
    globalThis.fetch = mkFetch([], false); let r = await preflight(base as never, globalThis.fetch);
    assert.equal(r.user_exists, false);
    globalThis.fetch = mkFetch([user], false); r = await preflight(base as never, globalThis.fetch);
    assert.equal(r.user_exists, true); assert.equal(r.password_ok, false); assert.match(r.diagnosis, /contraseña/);
    globalThis.fetch = mkFetch([user], true); r = await preflight(base as never, globalThis.fetch);
    assert.equal(r.password_ok, true); assert.equal(r.is_admin, false); assert.match(r.diagnosis, /verificada/);
    assert.doesNotMatch(JSON.stringify(r), /pw-should-not-leak|qa\.shopper@/);
    assert.equal((await preflight({} as never)).secrets_present, false);
  } finally { globalThis.fetch = orig; }
});

test("reporte diario: matriz de 7 módulos y conteo de 24 h", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const r = dailySummary([{ job: { product: "account-nav", mode: "gratuito", target: { kind: "production" } }, status: { state: "bloqueada", finishedAt: "2026-11-24T01:22:50Z", updatedAt: "2026-11-24T01:22:50Z", workerRunUrl: null, result: { verdict: "BLOQUEADO", coverage: "NO_EVALUADO", critical: "No se pudo entrar a ATOMIVID.", humanGate: null, score: null, findings: 1 } }, hasReport: true } as never], now);
  assert.equal(r.matrix.length, 7); assert.equal(r.jobsLast24h, 1); assert.equal(r.byState.bloqueada, 1); assert.equal(r.spendUsd, 0);
});

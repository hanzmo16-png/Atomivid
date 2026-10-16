/**
 * Saldo/cuota insuficiente ANTES de reservar o cobrar, y doble clic de render,
 * sobre las funciones reales del producto:
 *  - src/lib/billing/quota.ts assertCanGenerate (suscripción + límite mensual por modo)
 *  - src/lib/video/render-guard.ts evaluateRenderStart (doble render / colgado / máximo de intentos)
 * La garantía atómica real (UPDATE condicional en la ruta de render) la cubren
 * test:saas (render-route-cas.test.ts), ejecutado aparte.
 */
import { createFakeSupabase } from "../lib/fake-supabase";
import { Scenario, type ScenarioResult } from "../lib/report";

export async function runBillingScenarios(): Promise<ScenarioResult[]> {
  const { assertCanGenerate } = await import("../../../src/lib/billing/quota");
  const { evaluateRenderStart } = await import("../../../src/lib/video/render-guard");
  const { PLAN_CONFIGS } = await import("../../../src/lib/billing/plans");
  const results: ScenarioResult[] = [];
  const nowIso = new Date().toISOString();
  const service = (used: number, mode: string) => {
    const db = createFakeSupabase({ signedUrlBase: "https://sim-storage.local" });
    db.table("subscriptions").push({ user_id: "sim-user-q", status: "active", price_id: null });
    for (let i = 0; i < used; i++) db.table("video_requests").push({ id: `q-${i}`, user_id: "sim-user-q", status: "completed", mode, render_started_at: nowIso, created_at: nowIso });
    return db.client as never;
  };
  const limit = PLAN_CONFIGS.starter.monthlyNormalLimit;

  const run = async (id: string, title: string, body: (s: Scenario) => Promise<void>) => {
    const s = new Scenario(id, "billing", title);
    let error: unknown;
    try { await body(s); } catch (e) { error = e; }
    results.push(s.finish({}, error));
  };

  await run("BI-01", `Cuota mensual agotada (Starter, ${limit} Reels) → bloqueo antes de reservar o llamar a proveedores`, async (s) => {
    const under = await assertCanGenerate(service(limit - 1, "visual"), "sim-user-q", "visual");
    const at = await assertCanGenerate(service(limit, "visual"), "sim-user-q", "visual");
    s.check(`con ${limit - 1} usados: permitido`, under.allowed === true, under);
    s.check(`con ${limit} usados: bloqueado con motivo`, at.allowed === false && /límite/.test((at as { reason: string }).reason), at);
    const avatar = await assertCanGenerate(service(0, "avatar"), "sim-user-q", "avatar");
    s.check("Starter sin avatar incluido: bloqueado", avatar.allowed === false, avatar);
    const noSub = createFakeSupabase({ signedUrlBase: "https://x" });
    const none = await assertCanGenerate(noSub.client as never, "sim-user-q", "visual");
    s.check("sin suscripción activa: bloqueado", none.allowed === false, none);
  });

  await run("BI-02", "Doble clic en Render: ya procesando → 409; colgado → se permite reintentar; tope de intentos → 409", async (s) => {
    const now = Date.now();
    const fresh = evaluateRenderStart({ status: "processing", render_attempts: 1, render_started_at: new Date(now - 60_000).toISOString() }, now);
    const stale = evaluateRenderStart({ status: "processing", render_attempts: 1, render_started_at: new Date(now - 20 * 60_000).toISOString() }, now);
    const max = evaluateRenderStart({ status: "failed", render_attempts: 3, render_started_at: null }, now);
    const ok = evaluateRenderStart({ status: "script_ready", render_attempts: 0, render_started_at: null }, now);
    s.check("segundo clic mientras procesa → 409", !fresh.allowed && fresh.status === 409, fresh);
    s.check("render colgado (> 15 min) → permitido", stale.allowed, stale);
    s.check("3 intentos agotados → 409", !max.allowed, max);
    s.check("primer render → permitido", ok.allowed, ok);
    const lf = evaluateRenderStart({ status: "processing", render_attempts: 1, render_started_at: new Date(now - 40 * 60_000).toISOString(), mode: "long_form", long_form_progress: { updatedAt: new Date(now - 30_000).toISOString() } }, now);
    s.check("Long Form con latido reciente (40 min en curso) NO se considera colgado → 409", !lf.allowed, lf);
  });

  return results;
}

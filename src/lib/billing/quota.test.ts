import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCanGenerate, avatarEntitlementPreview } from "./quota";

const BETA_EMAIL = "beta-qa@example.test";
const BETA_USER = { email: BETA_EMAIL, email_confirmed_at: "2026-09-18" };

/** Fija AVATAR_PREPARATION_OWNER_EMAIL durante el test y lo restaura después — mismo patrón que STRIPE_PRICE_ID_PRO más abajo. */
function withBetaOwnerEnv(t: { after: (fn: () => void) => void }) {
  const original = process.env.AVATAR_PREPARATION_OWNER_EMAIL;
  process.env.AVATAR_PREPARATION_OWNER_EMAIL = BETA_EMAIL;
  t.after(() => {
    if (original === undefined) delete process.env.AVATAR_PREPARATION_OWNER_EMAIL;
    else process.env.AVATAR_PREPARATION_OWNER_EMAIL = original;
  });
}

/**
 * Cliente de Supabase mínimo y falso — solo implementa la forma
 * encadenada que assertCanGenerate necesita (.from().select().eq()...),
 * devolviendo respuestas fijas por tabla. No llama a ningún servicio
 * real.
 */
function fakeService(responses: {
  subscriptions?: { data: unknown; error: unknown };
  video_requests?: { data: unknown; count: number | null; error: unknown };
}) {
  const chain = (response: { data: unknown; error: unknown; count?: number | null }) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      in: () => builder,
      gte: () => builder,
      maybeSingle: async () => response,
      then: (resolve: (v: typeof response) => unknown) => resolve(response),
    };
    return builder;
  };

  return {
    from(table: string) {
      if (table === "subscriptions") {
        return chain(responses.subscriptions ?? { data: null, error: null });
      }
      if (table === "video_requests") {
        const r = responses.video_requests ?? { data: null, count: 0, error: null };
        return chain(r);
      }
      throw new Error(`tabla no esperada en el fake: ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Regresión exacta del incidente en producción (Código: 7bd9fef1): un
 * error real de Supabase al consultar `subscriptions` o `video_requests`
 * (no "sin fila", sino un fallo de la propia consulta) se ignoraba por
 * completo — `const { data } = await ...` descartaba `error` — y el
 * código seguía como si `data` fuera null, devolviendo "Necesitas una
 * suscripción activa" (o dejando pasar el límite mensual) en vez de
 * propagar el fallo real para que route.ts lo clasifique de forma segura
 * como un problema de conexión con la base de datos.
 */
test("assertCanGenerate relanza un error real de la consulta de subscriptions (no lo trata como 'sin suscripción')", async () => {
  const service = fakeService({
    subscriptions: { data: null, error: { message: "connection refused", code: "08006" } },
  });
  await assert.rejects(
    () => assertCanGenerate(service, "user-1", "visual"),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: string }).code, "08006");
      return true;
    },
  );
});

test("assertCanGenerate relanza un error real de la consulta de video_requests (no lo trata como 'bajo el límite')", async () => {
  const service = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
    video_requests: { data: null, count: null, error: { message: "timeout", code: "57014" } },
  });
  await assert.rejects(
    () => assertCanGenerate(service, "user-1", "visual"),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: string }).code, "57014");
      return true;
    },
  );
});

test("assertCanGenerate permite generar cuando hay suscripción activa y no se alcanzó el límite", async () => {
  const service = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
    video_requests: { data: null, count: 1, error: null },
  });
  const result = await assertCanGenerate(service, "user-1", "visual");
  assert.deepEqual(result, { allowed: true });
});

test("assertCanGenerate rechaza (sin error) cuando de verdad no hay suscripción (data null, sin error)", async () => {
  const service = fakeService({
    subscriptions: { data: null, error: null },
  });
  const result = await assertCanGenerate(service, "user-1", "visual");
  assert.equal(result.allowed, false);
});

test("assertCanGenerate con price_id sin coincidencia cae al plan Starter (15 normales, 0 avatar)", async () => {
  const belowLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_desconocido" }, error: null },
    video_requests: { data: null, count: 14, error: null },
  });
  assert.deepEqual(await assertCanGenerate(belowLimit, "user-1", "visual"), { allowed: true });

  const atLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_desconocido" }, error: null },
    video_requests: { data: null, count: 15, error: null },
  });
  const result = await assertCanGenerate(atLimit, "user-1", "visual");
  assert.equal(result.allowed, false);

  // El plan Starter (fallback) no incluye avatar en absoluto — nunca
  // llega a contar videos, rechaza antes de la consulta.
  const avatarBlocked = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_desconocido" }, error: null },
  });
  const avatarResult = await assertCanGenerate(avatarBlocked, "user-1", "avatar");
  assert.equal(avatarResult.allowed, false);
});

test("assertCanGenerate respeta el price_id del plan Pro configurado (STRIPE_PRICE_ID_PRO)", async (t) => {
  const original = process.env.STRIPE_PRICE_ID_PRO;
  process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
  t.after(() => {
    if (original === undefined) delete process.env.STRIPE_PRICE_ID_PRO;
    else process.env.STRIPE_PRICE_ID_PRO = original;
  });

  // Pro incluye 5 videos con avatar/mes — con 4 ya usados, el 5º debe pasar.
  const underAvatarLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_pro_test" }, error: null },
    video_requests: { data: null, count: 4, error: null },
  });
  assert.deepEqual(await assertCanGenerate(underAvatarLimit, "user-1", "avatar"), { allowed: true });

  // Con los 5 ya usados, el 6º debe rechazarse.
  const atAvatarLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_pro_test" }, error: null },
    video_requests: { data: null, count: 5, error: null },
  });
  const result = await assertCanGenerate(atAvatarLimit, "user-1", "avatar");
  assert.equal(result.allowed, false);
  assert.match(result.allowed ? "" : result.reason, /Pro/);
});

/**
 * Regresión del QA blocker real (2026-09-25, "BETA ACCOUNT BLOCKED BY
 * STARTER ENTITLEMENT"): la cuenta beta/admin allowlisted (canPrepareAvatar)
 * usada deliberadamente para hacer QA real de Avatar quedó bloqueada por
 * "Tu plan (Starter) no incluye videos con avatar" — el gate de
 * entitlement no distinguía esa cuenta de un usuario Starter normal.
 */
test("[1] Starter normal (sin acceso beta) + avatar → bloqueado, exactamente como antes", async () => {
  const service = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
  });
  const normalUser = { email: "usuario-normal@example.test", email_confirmed_at: "2026-09-01" };
  const result = await assertCanGenerate(service, "user-normal", "avatar", normalUser);
  assert.equal(result.allowed, false);
  assert.match(result.allowed ? "" : result.reason, /no incluye videos con avatar/);
});

test("[2] cuenta beta allowlisted + Starter + avatar → bypass de entitlement, ÚNICAMENTE para esa cuenta", async (t) => {
  withBetaOwnerEnv(t);

  // La cuenta beta, en Starter, SÍ puede generar (bypass).
  const betaService = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
    video_requests: { data: null, count: 0, error: null },
  });
  assert.deepEqual(await assertCanGenerate(betaService, "user-beta", "avatar", BETA_USER), { allowed: true });

  // Una cuenta CUALQUIERA OTRA, en el mismo plan Starter, sigue bloqueada
  // — el bypass nunca "convierte Starter en un plan con avatar" globalmente.
  const otherService = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
  });
  const otherResult = await assertCanGenerate(otherService, "user-other", "avatar", {
    email: "otro@example.test",
    email_confirmed_at: "2026-09-01",
  });
  assert.equal(otherResult.allowed, false);
});

test("[3] el bypass es server-side: sin pasar `user`, o con un `user` que no coincide con el allowlist, Starter+avatar sigue bloqueado", async (t) => {
  withBetaOwnerEnv(t);
  // Sin argumento `user` en absoluto (llamada antigua, o si algo lo omite) —
  // nunca debe interpretarse como "bypass por defecto".
  const noUserService = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
  });
  const noUserResult = await assertCanGenerate(noUserService, "user-x", "avatar");
  assert.equal(noUserResult.allowed, false);

  // Un `user` cuyo email el cliente podría intentar falsificar en teoría —
  // pero que no coincide con AVATAR_PREPARATION_OWNER_EMAIL — tampoco activa el bypass.
  const fakeClaimService = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
  });
  const fakeClaimResult = await assertCanGenerate(fakeClaimService, "user-y", "avatar", {
    email: "no-soy-beta@example.test",
    email_confirmed_at: "2026-09-01",
  });
  assert.equal(fakeClaimResult.allowed, false);
});

test("[4] el cost guard (conteo mensual) sigue aplicando para la cuenta beta — el bypass NO es ilimitado", async (t) => {
  withBetaOwnerEnv(t);
  // BETA_QA_AVATAR_MONTHLY_LIMIT reutiliza el límite del plan Pro (5) — con 5 ya usados, el 6º debe rechazarse igual que a un usuario Pro real.
  const atLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
    video_requests: { data: null, count: 5, error: null },
  });
  const result = await assertCanGenerate(atLimit, "user-beta", "avatar", BETA_USER);
  assert.equal(result.allowed, false);
  assert.match(result.allowed ? "" : result.reason, /Alcanzaste el límite/);

  const underLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: null }, error: null },
    video_requests: { data: null, count: 4, error: null },
  });
  assert.deepEqual(await assertCanGenerate(underLimit, "user-beta", "avatar", BETA_USER), { allowed: true });
});

test("[2b] el bypass nunca REDUCE el límite de un plan real que sí incluye avatar (Math.max, no reemplazo)", async (t) => {
  withBetaOwnerEnv(t);
  const original = process.env.STRIPE_PRICE_ID_BUSINESS;
  process.env.STRIPE_PRICE_ID_BUSINESS = "price_business_test";
  t.after(() => {
    if (original === undefined) delete process.env.STRIPE_PRICE_ID_BUSINESS;
    else process.env.STRIPE_PRICE_ID_BUSINESS = original;
  });
  // Business ya incluye 15 videos con avatar/mes — más que el piso de QA
  // (5, del plan Pro). La cuenta beta en Business debe seguir teniendo 15,
  // no bajar a 5.
  const atBusinessLimit = fakeService({
    subscriptions: { data: { status: "active", price_id: "price_business_test" }, error: null },
    video_requests: { data: null, count: 14, error: null },
  });
  assert.deepEqual(await assertCanGenerate(atBusinessLimit, "user-beta", "avatar", BETA_USER), { allowed: true });
});

test("avatarEntitlementPreview: refleja el mismo resultado que assertCanGenerate para el caso bloqueante (sin la consulta de conteo)", async (t) => {
  withBetaOwnerEnv(t);
  const normalBlocked = await avatarEntitlementPreview(
    fakeService({ subscriptions: { data: { status: "active", price_id: null }, error: null } }),
    "user-normal",
    { email: "normal@example.test", email_confirmed_at: "2026-09-01" },
  );
  assert.equal(normalBlocked.blocked, true);
  assert.match(normalBlocked.reason ?? "", /no incluye videos con avatar/);

  const betaAllowed = await avatarEntitlementPreview(
    fakeService({ subscriptions: { data: { status: "active", price_id: null }, error: null } }),
    "user-beta",
    BETA_USER,
  );
  assert.equal(betaAllowed.blocked, false);
});

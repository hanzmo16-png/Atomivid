import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCanGenerate } from "./quota";

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

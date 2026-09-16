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
    () => assertCanGenerate(service, "user-1"),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: string }).code, "08006");
      return true;
    },
  );
});

test("assertCanGenerate relanza un error real de la consulta de video_requests (no lo trata como 'bajo el límite')", async () => {
  const service = fakeService({
    subscriptions: { data: { status: "active" }, error: null },
    video_requests: { data: null, count: null, error: { message: "timeout", code: "57014" } },
  });
  await assert.rejects(
    () => assertCanGenerate(service, "user-1"),
    (error: unknown) => {
      assert.ok(error && typeof error === "object" && "code" in error);
      assert.equal((error as { code: string }).code, "57014");
      return true;
    },
  );
});

test("assertCanGenerate permite generar cuando hay suscripción activa y no se alcanzó el límite", async () => {
  const service = fakeService({
    subscriptions: { data: { status: "active" }, error: null },
    video_requests: { data: null, count: 1, error: null },
  });
  const result = await assertCanGenerate(service, "user-1");
  assert.deepEqual(result, { allowed: true });
});

test("assertCanGenerate rechaza (sin error) cuando de verdad no hay suscripción (data null, sin error)", async () => {
  const service = fakeService({
    subscriptions: { data: null, error: null },
  });
  const result = await assertCanGenerate(service, "user-1");
  assert.equal(result.allowed, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanQuotaNote } from "./PlanQuotaNote";

/** Cierre comercial 26-nov: el cliente ve cuántos videos le quedan de su plan antes de crear. */
test("aviso de plan: restantes, agotado, sin plan, dueño interno y fallo de lectura", () => {
  const ok = renderToStaticMarkup(<PlanQuotaNote preview={{ kind: "plan", planName: "Pro", used: 4, limit: 30, remaining: 26 }} />);
  assert.match(ok, /Tu plan Pro:/);
  assert.match(ok, /te quedan 26 de 30 videos este mes/);
  assert.match(ok, /no consume; se descuenta\s+al producir el video final/);
  assert.doesNotMatch(ok, /Mejorar plan/);

  const full = renderToStaticMarkup(<PlanQuotaNote preview={{ kind: "plan", planName: "Starter", used: 15, limit: 15, remaining: 0 }} />);
  assert.match(full, /ya usaste los 15 videos de este mes/);
  assert.match(full, /href="\/dashboard\/billing"[^>]*>Mejorar plan</);
  assert.match(full, /min-h-11/, "enlace de 44 px");

  const none = renderToStaticMarkup(<PlanQuotaNote preview={{ kind: "inactive", reason: "Necesitas una suscripción activa para generar videos." }} />);
  assert.match(none, /Necesitas una suscripción activa/);
  assert.match(none, />Ver planes</);

  assert.equal(renderToStaticMarkup(<PlanQuotaNote preview={{ kind: "internal" }} />), "");
  assert.equal(renderToStaticMarkup(<PlanQuotaNote preview={null} />), "", "si la lectura falla no se inventa un número");
});

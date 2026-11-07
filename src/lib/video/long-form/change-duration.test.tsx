import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { changeDurationHref, clock, MAX_PREFILL_URL } from "./change-duration";
import { DurationNotice } from "@/app/dashboard/long-form/configure/[id]/DurationNotice";

const fields = { topic: "¿Evolución o manipulación genética? El misterio de los Anunnaki", language: "es", durationMinutes: "7", sources: "https://example.org/a", openQuestions: "¿Quiénes eran?" };

test("Cambiar duración: mismos datos, duración vacía (se vuelve a escribir a propósito)", () => {
  const { href, sourcesDropped } = changeDurationHref(fields, "x");
  const q = new URL(href, "http://h").searchParams;
  assert.equal(new URL(href, "http://h").pathname, "/dashboard/long-form/new");
  assert.equal(q.get("topic"), fields.topic);
  assert.equal(q.get("language"), "es");
  assert.equal(q.get("sources"), fields.sources);
  assert.equal(q.get("open_questions"), fields.openQuestions);
  assert.equal(q.get("duration_minutes"), null);
  assert.equal(sourcesDropped, false);
});

test("Cambiar duración: referencias muy largas no viajan en la URL y se avisa", () => {
  const { href, sourcesDropped } = changeDurationHref({ ...fields, sources: "x".repeat(12000) }, "x");
  assert.ok(href.length <= MAX_PREFILL_URL);
  assert.equal(new URL(href, "http://h").searchParams.get("sources"), null);
  assert.equal(new URL(href, "http://h").searchParams.get("topic"), fields.topic);
  assert.equal(sourcesDropped, true);
});

test("Cambiar duración: sin trabajo original, usa el tema de la solicitud", () => {
  const q = new URL(changeDurationHref(null, "Tema").href, "http://h").searchParams;
  assert.equal(q.get("topic"), "Tema"); assert.equal(q.get("language"), "es");
});

test("clock", () => { assert.equal(clock(369), "6:09"); assert.equal(clock(1800), "30:00"); assert.equal(clock(3725), "1:02:05"); });

test("DurationNotice: duración pedida y estimada a la vista, con salida clara y sin promesa de cobro", () => {
  const html = renderToStaticMarkup(<DurationNotice requestedSeconds={420} estimatedSeconds={369} fields={fields} topic="x" />);
  assert.match(html, /Duración pedida: <strong>7 min<\/strong>/);
  assert.match(html, /~6:09/);
  assert.match(html, /Cambiar duración/);
  assert.match(html, /queda guardado/);
  assert.match(html, /href="\/dashboard\/long-form\/new\?/);
});

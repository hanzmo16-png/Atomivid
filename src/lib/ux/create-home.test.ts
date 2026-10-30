/** Simple UX 1.0 — inicio «¿Qué quieres crear hoy?» y menú del cliente. Sin red. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_NAV, cleanIdea, continueHref, createFormats, midFlow, splitHistory } from "./create-home";
import { defaultDraft, withIdea } from "../podcast/v3/wizard";

test("tres formatos, siempre visibles; sin acceso se muestran «Disponible pronto», nunca como si funcionaran", () => {
  const none = createFormats({ podcast: false, youtube: false });
  assert.deepEqual(none.map((f) => [f.id, f.title, f.available]), [["reel", "Reel", true], ["podcast", "Podcast", false], ["youtube", "Video de YouTube", false]]);
  assert.ok(none.filter((f) => !f.available).every((f) => /Disponible pronto/.test(f.unavailableReason ?? "")));
  assert.ok(createFormats({ podcast: true, youtube: true }).every((f) => f.available && f.unavailableReason === null));
});

test("«Continuar» lleva a la ruta real de cada formato con la idea escrita (codificada y con el límite del destino)", () => {
  assert.equal(continueHref("reel", "  5 datos   del espacio "), "/dashboard/new?formato=reel&idea=5%20datos%20del%20espacio");
  assert.equal(continueHref("reel", ""), "/dashboard/new?formato=reel");
  assert.equal(continueHref("podcast", "¿Qué pasó en Roswell?"), `/dashboard/podcast?idea=${encodeURIComponent("¿Qué pasó en Roswell?")}`);
  assert.equal(continueHref("youtube", ""), "/dashboard/long-form/new");
  const long = "a".repeat(800);
  assert.equal(decodeURIComponent(continueHref("youtube", long).split("topic=")[1]).length, 200, "Long Form admite 200 caracteres");
  assert.equal(cleanIdea(long).length, 500);
  assert.ok(!continueHref("reel", "x&y=1#z").includes("&y=1"), "la idea no inyecta parámetros");
});

test("menú del cliente: Mis proyectos, Facturación, Mi cuenta y Ayuda; nada interno", () => {
  assert.deepEqual(CLIENT_NAV.map((n) => n.label), ["Mis proyectos", "Facturación", "Mi cuenta", "Ayuda"]);
  assert.ok(!CLIENT_NAV.some((n) => /visual-test|command-center|admin|dev|github|log/i.test(n.href + n.label)));
});

test("a mitad de un flujo el historial va primero; los fallos de hace más de 7 días se pliegan sin borrarse", () => {
  assert.equal(midFlow({}), false); assert.equal(midFlow({ created: "1" }), true); assert.equal(midFlow({ script_job: "j" }), true);
  const now = Date.parse("2026-10-30T18:00:00Z"), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const r = [{ id: 1, status: "failed", created_at: d(10) }, { id: 2, status: "failed", created_at: d(2) }, { id: 3, status: "completed", created_at: d(90) }, { id: 4, status: "processing", created_at: d(30) }];
  const { visible, old } = splitHistory(r, now);
  assert.deepEqual(visible.map((x) => x.id), [2, 3, 4]); assert.deepEqual(old.map((x) => x.id), [1]);
});

test("Podcast: la idea pasa a tema y título solo si el borrador no tiene tema ni episodio en curso", () => {
  const d = defaultDraft();
  const a = withIdea(d, "  La vida   después de la visa ");
  assert.equal(a.topic, "La vida después de la visa"); assert.equal(a.title, "La vida después de la visa");
  assert.equal(withIdea({ ...d, topic: "Otro tema" }, "idea").topic, "Otro tema", "no pisa un tema escrito");
  assert.equal(withIdea({ ...d, episodeId: "e1" }, "idea").topic, "", "no toca un borrador que ya produce");
  assert.equal(withIdea({ ...d, title: "Mi título" }, "idea").title, "Mi título");
  assert.equal(withIdea(d, "   ").topic, "");
});

test("Reel en modo Automático: el estilo sale de la idea (y siempre es uno de los del formulario)", async () => {
  const { autoStyle, REEL_STYLES } = await import("./create-home");
  const { readFileSync } = await import("node:fs");
  const form = readFileSync(new URL("../../app/dashboard/new/NewVideoForm.tsx", import.meta.url), "utf8");
  for (const s of REEL_STYLES) assert.ok(form.includes(`"${s}"`), `estilo «${s}» existe en el formulario`);
  assert.equal(autoStyle("La leyenda urbana del fantasma del metro"), "Historias de terror");
  assert.equal(autoStyle("5 chistes sobre programadores"), "Humor");
  assert.equal(autoStyle("Cómo funciona un agujero negro"), "Educativo");
  assert.equal(autoStyle("Hábitos de disciplina para lograr tus metas"), "Motivacional");
  assert.equal(autoStyle("Mi historia: me pasó en un aeropuerto"), "Storytelling personal");
  assert.equal(autoStyle("5 datos sobre el espacio"), "Curiosidades");
  assert.equal(autoStyle(""), "Curiosidades");
});

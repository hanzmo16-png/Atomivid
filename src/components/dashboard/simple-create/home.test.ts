import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { autoStyle, cleanIdea, continueHref, createFormats, ideaNote, midFlow, SECONDARY_LINKS, splitHistory } from "./home";
import { isFreshHomeEntry } from "../../../lib/podcast/v3/wizard";

test("tres formatos y solo tres; sin acceso se dice «Disponible pronto», nunca se finge", () => {
  const all = createFormats({ podcast: true, youtube: true });
  assert.deepEqual(all.map((f) => f.title), ["Reel", "Podcast", "Video de YouTube"]);
  assert.ok(all.every((f) => f.available));
  const none = createFormats({ podcast: false, youtube: false });
  assert.equal(none[0].available, true);
  assert.deepEqual(none.slice(1).map((f) => [f.available, f.unavailableReason]), [[false, "Disponible pronto para tu cuenta."], [false, "Disponible pronto para tu cuenta."]]);
});

test("«Continuar» abre las rutas reales; la idea viaja solo donde la ruta la lee", () => {
  assert.equal(continueHref("reel", "  Datos  del   espacio "), "/dashboard/new?formato=reel&idea=Datos+del+espacio");
  assert.equal(continueHref("reel", "x", "custom"), "/dashboard/new?formato=reel&idea=x&modo=personalizado");
  assert.equal(continueHref("reel", ""), "/dashboard/new?formato=reel");
  assert.equal(continueHref("podcast", "lo que sea"), "/dashboard/podcast");
  assert.equal(continueHref("youtube", "Roma"), "/dashboard/long-form/new?topic=Roma");
  assert.equal(continueHref("youtube", "Roma", "custom"), "/dashboard/long-form/new?topic=Roma", "YouTube no gana pasos ni modo");
  assert.equal(new URL(continueHref("youtube", "a".repeat(400)), "http://x").searchParams.get("topic")!.length, 200);
  assert.equal(cleanIdea("b".repeat(900)).length, 500);
  assert.match(ideaNote("podcast", "idea")!, /Personalizado/);
  assert.match(ideaNote("podcast", "idea")!, /Automático/);
  assert.equal(ideaNote("podcast", "  "), null);
  assert.equal(ideaNote("reel", "idea"), null);
});

test("Podcast Personalizado abre una URL inequívoca y conserva la idea; Automático no la toca", () => {
  const href = continueHref("podcast", "  La señal   Wow! ", "custom");
  const u = new URL(href, "http://x");
  assert.equal(u.pathname, "/dashboard/podcast");
  assert.equal(u.searchParams.get("modo"), "personalizado");
  assert.match(u.searchParams.get("entrada") ?? "", /^nueva-/);
  assert.equal(u.searchParams.get("idea"), "La señal Wow!");
  assert.equal(isFreshHomeEntry({ modo: u.searchParams.get("modo"), entrada: u.searchParams.get("entrada") }), true);
  const again = new URL(continueHref("podcast", "La señal Wow!", "custom"), "http://x");
  assert.notEqual(again.searchParams.get("entrada"), u.searchParams.get("entrada"), "cada clic es una entrada nueva");
  assert.equal(again.searchParams.get("idea"), "La señal Wow!");
  const empty = new URL(continueHref("podcast", "   ", "custom"), "http://x");
  assert.equal(empty.searchParams.get("idea"), null);
  assert.equal(empty.searchParams.get("modo"), "personalizado");
  assert.match(empty.searchParams.get("entrada") ?? "", /^nueva-/);
  assert.equal(continueHref("podcast", "tema", "auto"), "/dashboard/podcast");
  assert.equal(continueHref("reel", "x", "custom"), "/dashboard/new?formato=reel&idea=x&modo=personalizado");
});

test("las rutas de destino existen en la app (no se inventan pantallas)", () => {
  const app = path.resolve(__dirname, "../../../app");
  for (const r of ["dashboard/new", "dashboard/podcast", "dashboard/long-form/new", "dashboard/billing"]) assert.ok(fs.existsSync(path.join(app, r, "page.tsx")), r);
  assert.deepEqual(SECONDARY_LINKS.map((l) => l.href), ["#proyectos", "/dashboard/billing"]);
});

test("Automático elige un estilo a partir de la idea; si nada encaja, «Curiosidades»", () => {
  assert.equal(autoStyle("La leyenda urbana del fantasma del metro"), "Historias de terror");
  assert.equal(autoStyle("Cómo funciona un motor"), "Educativo");
  assert.equal(autoStyle("Pulpos"), "Curiosidades");
});

test("historial: a mitad de flujo va primero; los fallos viejos se pliegan sin borrarse", () => {
  assert.equal(midFlow({}), false);
  assert.equal(midFlow({ created: "1" }), true);
  const now = Date.parse("2026-10-30T00:00:00Z"), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const items = [{ id: "a", status: "failed", created_at: d(10) }, { id: "b", status: "failed", created_at: d(1) }, { id: "c", status: "completed", created_at: d(30) }];
  const { visible, old } = splitHistory(items, now);
  assert.deepEqual(visible.map((r) => r.id), ["b", "c"]);
  assert.deepEqual(old.map((r) => r.id), ["a"]);
});

test("la portada no enlaza herramientas internas ni llama a la red", () => {
  const src = fs.readFileSync(path.join(__dirname, "CreateHome.tsx"), "utf8") + fs.readFileSync(path.join(__dirname, "home.ts"), "utf8");
  assert.doesNotMatch(src, /visual-test|command-center|dry ?run|\/admin|\/dev\b|fetch\(|\/api\//i);
});

test("preparaciones de guion: las fallidas de hace más de 7 días se pliegan; la abierta (?script_job=) sigue a la vista", () => {
  const now = Date.parse("2026-10-31T00:00:00Z"), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const jobs = [{ id: "j1", status: "failed", created_at: d(20) }, { id: "j2", status: "running", created_at: d(30) }, { id: "j3", status: "failed", created_at: d(2) }];
  const { visible, old } = splitHistory(jobs, now);
  assert.deepEqual(visible.map((j) => j.id), ["j2", "j3"], "lo que sigue en curso nunca se pliega, aunque sea antiguo");
  assert.deepEqual(old.map((j) => j.id), ["j1"]);
  const page = fs.readFileSync(path.resolve(__dirname, "../../../app/dashboard/page.tsx"), "utf8");
  assert.match(page, /splitHistory\(\(scriptJobs \?\? \[\]\)\.filter\(\(j\) => j\.id !== script_job\), nowMs\)/);
  assert.match(page, /data-testid="guiones-antiguos"/);
  assert.doesNotMatch(page, /from\("documentary_script_jobs"\)[^;]*\.(delete|update)\(/, "plegar no escribe nada");
});

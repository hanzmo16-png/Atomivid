/**
 * Podcast — el borrador del asistente y su episodio (incidente 2026-10-29, falso 0 % → 100 %): tras producir un episodio
 * el borrador conservaba su episodeId/draftId; al configurar OTRO podcast, «Generación» mostraba el anterior ya listo y
 * no creaba nada. Puras, sin red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindEpisode, defaultDraft, releaseEpisode, specKey, STEP, withHost, type WizardDraft } from "./wizard";

const PREV = "ec30c594-21ca-49f8-8d09-817a07147fd8";
function produced(): WizardDraft {
  const d = defaultDraft();
  const base: WizardDraft = { ...d, modality: "dialogo", mode: "dialogo", count: 2, title: "Cosmonautas mito o realidad", topic: "Cosmonautas perdidos",
    script: "Valeria Montclair: Hola.\nVíctor Albarrán: Hola.", participants: [withHost(d.participants[0], "valeria"), withHost(d.participants[1], "victor")], budgetUsd: 20 };
  // Lo que deja «Generar episodio» al terminar bien: borrador creado, autorizado, en «Generación».
  return { ...base, step: STEP.generacion, authorized: true, draftId: PREV, episodeId: PREV, boundSpec: specKey(base) };
}

test("reproducción: sin la regla, el borrador de un episodio terminado sigue apuntándolo al configurar otro podcast", () => {
  const d = { ...produced(), step: STEP.tema, title: "Las pirámides de Egipto", topic: "Pirámides" };
  // Lo que hacía b19d3b46: nada soltaba el episodio → «Generación» lo mostraba (listo, 100 %) y no se creaba nada.
  assert.equal(d.episodeId, PREV); assert.equal(d.draftId, PREV);
  const fixed = bindEpisode(d);
  assert.equal(fixed.episodeId, null); assert.equal(fixed.draftId, null); assert.equal(fixed.authorized, false, "la autorización del episodio anterior no vale para el nuevo");
  assert.equal(fixed.title, "Las pirámides de Egipto", "la configuración nueva se conserva");
});

test("cualquier cambio de configuración suelta el episodio (título, guion, anfitrión, presupuesto, estudio)", () => {
  const p = produced();
  const changes: Partial<WizardDraft>[] = [{ title: "Otro" }, { script: p.script + "\nValeria Montclair: Más." }, { participants: [withHost(p.participants[0], "victor"), p.participants[1]] },
    { budgetUsd: 15 }, { set: "calido" }, { minutes: 12 }];
  for (const c of changes) assert.equal(bindEpisode({ ...p, ...c }).episodeId, null, JSON.stringify(Object.keys(c)));
});

test("control negativo: revisar los pasos sin cambiar nada conserva el episodio (no se crea ni cobra otro)", () => {
  const p = produced();
  for (const step of [STEP.modalidad, STEP.tema, STEP.visuales, STEP.vista, STEP.generacion]) {
    const b = bindEpisode({ ...p, step });
    assert.equal(b.episodeId, PREV, `paso ${step}`); assert.equal(b.draftId, PREV); assert.equal(b.authorized, true);
  }
});

test("episodio fallido: «Reintentar» reutiliza el mismo borrador solo si la configuración no cambió", () => {
  const p = produced();
  const retry = { ...p, draftId: PREV, episodeId: null, authorized: false }; // lo que deja «Reintentar»
  assert.equal(bindEpisode(retry).draftId, PREV, "mismo episodio: lo ya pagado se reutiliza");
  assert.equal(bindEpisode({ ...retry, topic: "Otro tema" }).draftId, null, "otra configuración: episodio nuevo");
});

test("borradores guardados antes de la regla (sin huella): se sueltan fuera de «Generación»; en «Generación» se ligan", () => {
  const { boundSpec: _b, ...legacy } = produced();
  assert.equal(bindEpisode({ ...legacy, step: STEP.tema }).episodeId, null, "el caso de Hans: volvió atrás con el borrador viejo");
  const kept = bindEpisode({ ...legacy, step: STEP.generacion });
  assert.equal(kept.episodeId, PREV, "una producción en curso no pierde su pantalla de avance");
  assert.equal(kept.boundSpec, specKey(kept));
});

test("«Crear otro episodio» y borrador vacío", () => {
  const r = releaseEpisode(produced());
  assert.deepEqual([r.episodeId, r.draftId, r.authorized, r.boundSpec], [null, null, false, null]);
  assert.equal(r.title, "Cosmonautas mito o realidad", "la configuración se conserva para ajustarla");
  const empty = defaultDraft();
  assert.equal(bindEpisode(empty), empty, "sin episodio: no cambia nada");
});

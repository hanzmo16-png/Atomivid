/**
 * Podcast Studio Premium 4.0 — fase 1 (auditoría del episodio real 51883d1c, 2026-10-30). La voz fue fiel al guion
 * (98,4 % oído en orden); los defectos de audio venían del GUION: plantilla con el tema pegado tal cual («despurs de la
 * muerte», leído «despurse» cinco veces) y nombres por defecto («me acompaña Invitado», «Gracias a ti, Anfitrión»)
 * porque el guion se generaba antes de elegir a los participantes. Puras, sin red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTopic, templateConversation } from "./script";
import { defaultDraft, firstNameOf, renameInScript, syncScriptNames, withHost, withOwnAvatar, type WizardDraft } from "./wizard";

const REAL = "Anfitrión: Bienvenidos a un nuevo episodio. Hoy hablamos de A donde vamos despurs de la muerte, y me acompaña Invitado. ¡Gracias por venir!\nInvitado: Gracias a ti, Anfitrión. Es un tema que me apasiona y que mucha gente entiende a medias.\nAnfitrión: Nos quedamos aquí por hoy. Invitado, gracias por acompañarnos.\nInvitado: Un placer. Ningún invitado sobra.";

test("reproducción 51883d1c: elegir los participantes DESPUÉS del guion renombra etiquetas y menciones", () => {
  const d0: WizardDraft = { ...defaultDraft(), count: 2, script: REAL };
  // Lo que hacía el asistente: nombrar a B (Valeria, del catálogo) no tocaba el guion → «me acompaña Invitado».
  const withValeria: WizardDraft = { ...d0, participants: [d0.participants[0], withHost(d0.participants[1], "valeria")] };
  const d1 = syncScriptNames(d0, withValeria);
  assert.doesNotMatch(d1.script, /\bInvitado\b/u, "ninguna mención ni etiqueta «Invitado» queda en el guion");
  assert.match(d1.script, /me acompaña Valeria Montclair\./); assert.match(d1.script, /^Valeria Montclair: Gracias a ti, Anfitrión\./m);
  assert.match(d1.script, /Ningún invitado sobra/, "la palabra común en minúscula no se toca");
  // A elige su propio avatar «Hans Estudio podcast»: toma «Hans» y el guion lo sigue.
  const d2 = syncScriptNames(d1, { ...d1, participants: [withOwnAvatar(d1.participants[0], { id: "6a3e434b", name: "Hans Estudio podcast" }, 0), d1.participants[1]] });
  assert.equal(d2.participants[0].name, "Hans"); assert.deepEqual(d2.participants[0].avatar, { kind: "existente", avatar_id: "6a3e434b" });
  assert.match(d2.script, /^Hans: Bienvenidos/m); assert.match(d2.script, /Gracias a ti, Hans\./);
  assert.doesNotMatch(d2.script, /\bAnfitrión\b/u);
});

test("nombres: un nombre ya escrito por el usuario no se pisa; avatares sin nombre de pila no inventan uno", () => {
  const p = { ...defaultDraft().participants[0], name: "Carlos" };
  assert.equal(withOwnAvatar(p, { id: "x", name: "Hans Estudio podcast" }, 0).name, "Carlos");
  assert.equal(firstNameOf("mi avatar 2"), ""); assert.equal(firstNameOf("Hans Estudio podcast"), "Hans");
  assert.equal(withOwnAvatar(defaultDraft().participants[0], { id: "x", name: "avatar nuevo" }, 0).name, "Anfitrión");
  assert.equal(renameInScript("A: hola", "", "B"), "A: hola"); assert.equal(renameInScript("Ana: hola", "Ana", "Ana"), "Ana: hola");
  const same = { ...defaultDraft(), script: REAL }, next = { ...same, title: "otro" };
  assert.equal(syncScriptNames(same, next), next, "sin cambio de nombres el guion no cambia");
});

test("plantilla: el tema se limpia y solo se nombra en la apertura (no se repite la errata en cada pregunta)", () => {
  assert.equal(cleanTopic("  ¿A donde vamos despues de la muerte?  "), "a donde vamos despues de la muerte");
  const turns = templateConversation({ topic: "¿A donde vamos despurs de la muerte?", hostName: "Hans", guestName: "Valeria Montclair", minutes: 5 });
  const all = turns.map((t) => t.text).join("\n");
  assert.equal((all.match(/despurs/g) ?? []).length, 1, "una sola mención del tema escrito por el usuario");
  assert.match(turns[0].text, /me acompaña Valeria Montclair/); assert.match(turns[1].text, /Gracias a ti, Hans\./);
  assert.doesNotMatch(all, /¿¿|\?\?/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSelection, previewSummary, type AudiovisualSelection } from "./catalog";
import {
  DirectionMismatchError,
  analyzeScriptIntent,
  assertDirectionMatches,
  directionForApprovedScript,
  resolveDirection,
} from "./direction";
import { PROFILES } from "./catalog";

const sel = (s: Partial<AudiovisualSelection> & { profile: AudiovisualSelection["profile"] }): AudiovisualSelection => ({ version: 1, ...s });

const MYSTERY_SCRIPT = [
  { text: "Nadie sabe qué pasó aquella noche en el faro abandonado.", energy: "low" },
  { text: "El guardián desapareció y solo quedó un grito en la grabación.", energy: "low" },
  { text: "Las sombras en la escalera no coincidían con ninguna persona.", energy: "medium" },
  { text: "Entonces encontraron la puerta cerrada por dentro. El misterio sigue.", energy: "high" },
];
const HUMOR_SCRIPT = [
  { text: "Mi gato decidió que el teclado era su cama, y fue ridículo.", energy: "medium" },
  { text: "Cada intento de trabajar terminaba en un chiste absurdo.", energy: "high" },
  { text: "Hasta mi jefe se rió a carcajadas en la videollamada.", energy: "high" },
];

test("aceptación 2: cómic de misterio y cómic de humor comparten dibujo y difieren en música y ritmo", () => {
  const mystery = resolveDirection({ selection: sel({ profile: "comic" }), style: "Curiosidades", topic: "El faro", scenes: MYSTERY_SCRIPT });
  const humor = resolveDirection({ selection: sel({ profile: "comic" }), style: "Humor", topic: "Mi gato", scenes: HUMOR_SCRIPT });
  assert.equal(mystery.profile, "comic");
  assert.equal(humor.profile, "comic");
  assert.equal(PROFILES[mystery.profile].visualSource, "generated_image");
  assert.equal(mystery.intent.id, "suspense");
  assert.equal(mystery.intent.source, "script");
  assert.equal(humor.intent.id, "humor");
  assert.notEqual(mystery.music.id, humor.music.id);
  assert.notEqual(mystery.pace.id, humor.pace.id);
  assert.equal(mystery.summary, "Suspenso · música de tensión · ritmo pausado");
});

test("aceptación 1: Horror y misterio mantiene la tensión aunque el guion hable de éxito, negocios y celebración", () => {
  const scenes = [
    { text: "Era la empresa de más éxito del pueblo; sus negocios crecían cada año.", energy: "low" },
    { text: "Celebraron la meta con una fiesta. Lograr el éxito parecía fácil.", energy: "medium" },
    { text: "Esa misma noche, el dueño desapareció sin dejar rastro.", energy: "high" },
  ];
  const d = resolveDirection({ selection: sel({ profile: "horror_mystery" }), style: "Motivacional", topic: "La empresa", scenes });
  assert.equal(d.intent.id, "suspense");
  assert.equal(d.intent.source, "profile");
  assert.equal(d.music.id, "tension");
});

test("palabras aisladas no cambian el género: una mención de «misterio» en un guion divulgativo no lo vuelve suspenso", () => {
  const scenes = [
    { text: "Las abejas producen miel a partir del néctar de las flores." },
    { text: "Un estudio muestra que visitan miles de flores al día." },
    { text: "El misterio de su danza se explicó hace décadas." },
    { text: "Según los científicos, así comunican dónde está el alimento." },
  ];
  assert.equal(analyzeScriptIntent(scenes)?.intent === "suspense", false);
  const d = resolveDirection({ selection: sel({ profile: "cinematic_realistic" }), style: "Educativo", scenes });
  assert.equal(d.intent.id, "informative");
});

test("prioridad: ajuste explícito > perfil > tono fuerte > guion completo > tono débil", () => {
  assert.equal(resolveDirection({ selection: sel({ profile: "anime", intent: "reflective" }), style: "Humor", scenes: HUMOR_SCRIPT }).intent.source, "override");
  assert.equal(resolveDirection({ selection: sel({ profile: "anime" }), style: "Humor", scenes: MYSTERY_SCRIPT }).intent.id, "humor");
  assert.equal(resolveDirection({ selection: sel({ profile: "anime" }), style: "Educativo", scenes: MYSTERY_SCRIPT }).intent.source, "script");
  assert.equal(resolveDirection({ selection: sel({ profile: "anime" }), style: "Storytelling personal", scenes: [{ text: "Hola." }] }).intent.id, "reflective");
  const overrides = resolveDirection({ selection: sel({ profile: "comic", music: "none", pace: "dynamic" }), style: "Humor", scenes: HUMOR_SCRIPT });
  assert.equal(overrides.music.id, "none");
  assert.equal(overrides.music.source, "override");
  assert.equal(overrides.summary, "Humor · sin música · ritmo dinámico");
});

test("validación de servidor: perfiles y ajustes cerrados; Horror no admite humor ni música alegre", () => {
  assert.equal(parseSelection({ profile: "anime" }).ok, true);
  assert.equal(parseSelection({ profile: "vaporwave" }).ok, false);
  assert.equal(parseSelection({ profile: "comic", intent: "sarcasm" }).ok, false);
  assert.equal(parseSelection({ profile: "horror_mystery", intent: "humor" }).ok, false);
  assert.equal(parseSelection({ profile: "horror_mystery", music: "uplifting" }).ok, false);
  const ok = parseSelection({ profile: "horror_mystery", intent: "auto", music: "none", pace: "" });
  assert.deepEqual(ok, { ok: true, selection: { version: 1, profile: "horror_mystery", music: "none" } });
});

test("resumen previo: antes del guion dice que la emoción depende de la historia, salvo perfil o tono explícitos", () => {
  assert.equal(previewSummary(sel({ profile: "horror_mystery" }), "Curiosidades"), "Suspenso · música de tensión · ritmo pausado");
  assert.equal(previewSummary(sel({ profile: "comic" }), "Humor"), "Humor · música ligera · ritmo dinámico");
  assert.match(previewSummary(sel({ profile: "comic" }), "Curiosidades"), /^Emoción según tu guion/);
});

test("persistencia y reintentos: misma entrada reutiliza la dirección; editar guion o estilo la invalida", () => {
  const input = { selection: sel({ profile: "comic" }), style: "Humor", topic: "Mi gato", scenes: HUMOR_SCRIPT };
  const first = directionForApprovedScript({ stored: null, ...input, now: new Date("2026-09-26T00:00:00Z") });
  assert.equal(first.reused, false);
  const retry = directionForApprovedScript({ stored: JSON.parse(JSON.stringify(first.direction)), ...input });
  assert.equal(retry.reused, true);
  assert.equal(retry.direction.resolvedAt, "2026-09-26T00:00:00.000Z");

  const edited = { ...input, scenes: [...HUMOR_SCRIPT.slice(0, 2), { text: "Otra escena distinta.", energy: "low" }] };
  assert.equal(directionForApprovedScript({ stored: first.direction, ...edited }).reused, false);
  const restyled = { ...input, selection: sel({ profile: "anime" }) };
  assert.equal(directionForApprovedScript({ stored: first.direction, ...restyled }).reused, false);

  assert.equal(assertDirectionMatches({ stored: first.direction, ...input }).fingerprint, first.direction.fingerprint);
  assert.throws(() => assertDirectionMatches({ stored: first.direction, ...edited }), DirectionMismatchError);
  assert.throws(() => assertDirectionMatches({ stored: null, ...input }), DirectionMismatchError);
  assert.throws(() => assertDirectionMatches({ stored: { ...first.direction, version: 99 }, ...input }), DirectionMismatchError);
});

test("energía por escena: se toma del guion aprobado; valores desconocidos cuentan como media", () => {
  const d = resolveDirection({ selection: sel({ profile: "cinematic_realistic" }), scenes: [{ text: "a", energy: "high" }, { text: "b", energy: "weird" }, { text: "c" }] });
  assert.deepEqual(d.sceneEnergy, ["high", "medium", "medium"]);
});

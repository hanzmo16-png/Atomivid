/**
 * P0 2026-11-02 («Base Dulce», captura real del dueño): con 30 min elegidos seguía visible «Usar la plantilla breve
 * (unos 5 min, sin IA)» y el cuadro «Guion» tenía 5,028 caracteres (~5,9 min) junto a «Continuar (bloque 1 de 3)».
 * La plantilla breve es solo del modo corto (≤ 12 min); un episodio largo muestra objetivo, lo recuperado, lo pendiente
 * (llamadas pagadas nuevas) y lo que hay en el cuadro, sin confundirlo con un episodio terminado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LongScriptStatus, longScriptStatus } from "./PodcastWizard";
import { briefTemplateAllowed, SINGLE_CALL_MAX_MINUTES } from "@/lib/podcast/v3/long-script";
import { studioAction, type ApiDeps } from "@/lib/podcast/v3/api";
import { estimateMinutes } from "@/lib/podcast/v3/wizard";

/** Guion con exactamente `n` caracteres (sin espacios al borde), con el formato «Nombre: turno». */
export function scriptOfLength(n: number): string {
  const lines: string[] = []; let i = 0;
  while (lines.join("\n").length < n) { lines.push(`${i % 2 ? "El Duro Hans" : "Valeria Moncler"}: Nivel ${i + 1} de Base Dulce, con un dato verificable y una pregunta.`); i++; }
  let s = lines.join("\n").slice(0, n); if (/\s$/.test(s)) s = s.slice(0, -1) + "."; return s;
}
const SCRIPT_5028 = scriptOfLength(5028);
const job = (segments: unknown[][], n = 3) => ({ v: 1, jobId: "j", input: {}, plan: { title: "t", segments: Array.from({ length: n }, () => ({ title: "B", points: ["a", "b"] })) }, segments, attempts: { plan: 1 }, partial: null });

test("la plantilla breve es solo del modo corto: hasta 12 min sí; 13, 20, 30, 45 y 60 min no", () => {
  assert.equal(SINGLE_CALL_MAX_MINUTES, 12);
  for (const m of [1, 2, 5, 10, 12]) assert.equal(briefTemplateAllowed(m), true, String(m));
  for (const m of [13, 20, 30, 44, 45, 60]) assert.equal(briefTemplateAllowed(m), false, String(m));
});

test("API: pedir la plantilla con 30, 45 o 60 min → 409 PLANTILLA_SOLO_CORTO sin guion; con 5 min sigue funcionando", async () => {
  const d = { userId: "u", voices: async () => [], enabled: true, llm: null, newJobId: () => "x", env: {}, insert: async () => null, load: async () => null, authorize: async () => false, dispatch: async () => false } as unknown as ApiDeps;
  for (const minutes of [30, 45, 60]) {
    const r = await studioAction(d, { action: "script", topic: "Base Dulce: los siete niveles del horror", minutes, hostName: "Valeria", guestName: "Hans" });
    assert.equal(r.status, 409, String(minutes)); assert.equal(r.body.code, "PLANTILLA_SOLO_CORTO"); assert.equal(r.body.script, undefined);
    assert.match(String(r.body.error), new RegExp(`Para ${minutes} min la conversación se escribe con IA por bloques`));
  }
  const ok = await studioAction(d, { action: "script", topic: "volcanes", minutes: 5, hostName: "Ana", guestName: "Luis" });
  assert.equal(ok.status, 200); assert.equal(ok.body.source, "plantilla");
});

test("caso del dueño: 30 min, 5,028 caracteres en el cuadro y bloque 1 de 3 pendiente → estado claro, no «terminado»", () => {
  assert.equal(SCRIPT_5028.trim().length, 5028);
  const st = longScriptStatus(30, SCRIPT_5028, job([]))!;
  assert.deepEqual({ target: st.target, blocks: st.blocks, saved: st.saved, planReady: st.planReady, boxChars: st.boxChars, boxShort: st.boxShort }, { target: 30, blocks: 3, saved: 0, planReady: true, boxChars: 5028, boxShort: true });
  assert.ok(Math.abs(st.boxMinutes - estimateMinutes(SCRIPT_5028)) < 1e-9 && st.boxMinutes < 10);
  const html = renderToStaticMarkup(<LongScriptStatus status={st} />);
  assert.match(html, /Episodio largo: objetivo 30 min\. La conversación se escribe con IA en 3 bloques; la plantilla breve de unos 5 min no aplica/);
  assert.match(html, /Recuperado y guardado \(no se vuelve a pagar\): 0 de 3 bloques/);
  assert.match(html, /Pendiente: 3 bloques\. Al continuar, cada paso pendiente es una nueva llamada de IA pagada/);
  assert.match(html, /Cuadro «Guion»: 5,028 caracteres, unos \d+,\d min de 30 min — no es el episodio terminado/);
});

test("progreso a medias: 1 de 3 guardado → recuperado 1, pendiente 2; sin escaleta → la escaleta también pendiente", () => {
  const one = longScriptStatus(30, "", job([[{ speaker: "A", text: "Hola, empezamos el nivel uno de Base Dulce." }, { speaker: "B", text: "Vamos." }]]))!;
  const html = renderToStaticMarkup(<LongScriptStatus status={one} />);
  assert.match(html, /Recuperado y guardado \(no se vuelve a pagar\): 1 de 3 bloques, unos/); assert.match(html, /Pendiente: 2 bloques/);
  assert.match(html, /Cuadro «Guion»: 0 caracteres/); assert.doesNotMatch(html, /no es el episodio terminado/);
  const none = renderToStaticMarkup(<LongScriptStatus status={longScriptStatus(45, "", null)} />);
  assert.match(none, /objetivo 45 min\. La conversación se escribe con IA en 5 bloques/); assert.match(none, /Pendiente: la escaleta y 5 bloques/);
  assert.match(renderToStaticMarkup(<LongScriptStatus status={longScriptStatus(60, "", null)} />), /en 6 bloques/);
});

test("modo corto (≤ 12 min): no hay panel de episodio largo", () => {
  for (const m of [2, 5, 12]) { assert.equal(longScriptStatus(m, SCRIPT_5028, null), null); assert.equal(renderToStaticMarkup(<LongScriptStatus status={null} />), ""); }
});

test("el asistente condiciona el botón a la duración, muestra el estado largo y conserva el texto previo al terminar", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /!busy && d\.topic\.trim\(\)\.length >= 3 && briefTemplateAllowed\(d\.minutes\) && <button[^>]*data-testid="usar-plantilla"/);
  assert.match(wiz, /<LongScriptStatus status=\{longScriptStatus\(d\.minutes, d\.script, staleJob\(d\.scriptJob, scriptAsk\(\)\) \? null : d\.scriptJob\)\} \/>/);
  assert.match(wiz, /if \(prev && prev !== r\.script\.trim\(\)\) \{ try \{ if \(parkDraft\(localStorage, ownedRaw\(\{ \.\.\.d, scriptJob: null \}\)\)\) setRecoverable\(true\)/);
});

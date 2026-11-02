/** Incidente «Base Dulce» (2026-11-02): con bloques ya guardados, la pantalla mostraba «0 caracteres» y nada más. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedProgressPanel, savedProgress } from "./PodcastWizard";

const names = { A: "Valeria", B: "Hans" };
const line = (n: number) => `Turno número ${n} con contenido suficiente para contar como texto real del bloque.`;
const job = { plan: { segments: [1, 2, 3, 4, 5] }, segments: [[{ speaker: "A", text: line(1) }, { speaker: "B", text: line(2) }], [{ speaker: "A", text: line(3) }]] };

test("savedProgress cuenta los bloques guardados y arma el texto con los nombres", () => {
  const s = savedProgress(job, names)!;
  assert.equal(s.blocks, 2);
  assert.equal(s.total, 5);
  assert.equal(s.text.split("\n").length, 3);
  assert.match(s.text, /^Valeria: Turno número 1/);
  assert.match(s.text, /\nHans: Turno número 2/);
  assert.equal(s.chars, [1, 2, 3].reduce((n, i) => n + line(i).length, 0));
  assert.ok(s.minutes > 0);
});

test("sin bloques (o sin trabajo) no hay panel", () => {
  assert.equal(savedProgress(null, names), null);
  assert.equal(savedProgress({ plan: { segments: [1, 2] }, segments: [] }, names), null);
  assert.equal(savedProgress({ segments: [[{ speaker: "X", text: "?" }]] }, names), null);
  assert.equal(renderToStaticMarkup(<SavedProgressPanel saved={null} />), "");
});

test("el panel muestra «X de N bloques», los caracteres y lo escrito, sin prometer tiempos", () => {
  const html = renderToStaticMarkup(<SavedProgressPanel saved={savedProgress(job, names)} />);
  assert.match(html, /data-testid="progreso-guardado"/);
  assert.match(html, /Guardado en este navegador: 2 de 5 bloques/);
  assert.match(html, /lo guardado no se vuelve a pagar/);
  assert.match(html, /data-testid="progreso-guardado-texto">Valeria: Turno número 1/);
  assert.doesNotMatch(html, /unos minutos/);
});

test("el asistente muestra el panel en modo diálogo con el trabajo del borrador", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /d\.mode === "dialogo" && <SavedProgressPanel saved=\{savedProgress\(d\.scriptJob,/);
});

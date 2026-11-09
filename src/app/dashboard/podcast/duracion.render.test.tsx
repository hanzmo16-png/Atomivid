/** Incidente 8f05fc37: la interfaz no promete una duración que el guion no alcanza y muestra la duración entregada. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DurationAcceptance } from "./PodcastWizard";

test("Producir: la aceptación dice la duración real y la pedida", () => {
  const html = renderToStaticMarkup(<DurationAcceptance message="Tu guion da para unos 5,5 min y elegiste 27 min." minutes={5.5} target={27} checked={false} onChange={() => {}} />);
  assert.match(html, /data-testid="duracion-aceptar"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /elegiste 27 min/);
  assert.match(html, /Acepto que el episodio dure unos 5,5 min \(no 27 min\)/);
  assert.doesNotMatch(html, /checked=""/);
});

test("Generar queda bloqueado sin aceptar y la creación envía la aceptación; la tarjeta muestra la duración entregada", () => {
  const wiz = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /disabled=\{!d\.authorized \|\| \(estimate\?\.totalUsd \?\? 0\) > d\.budgetUsd \|\| \(mustAcceptDuration && !acceptDuration\) \|\| providerBlocked\(estimate\)\}/);
  assert.match(wiz, /if \(mustAcceptDuration && !acceptDuration\) \{ setError/);
  assert.match(wiz, /\.\.\.\(mustAcceptDuration \? \{ acceptDuration: true \} : \{\}\)/);
  const card = readFileSync(path.join(__dirname, "StudioEpisodeList.tsx"), "utf8");
  assert.match(card, /media\?\.durationNote && <p[^>]*data-testid=\{`studio-duracion-\$\{episode\.id\}`\}/);
});

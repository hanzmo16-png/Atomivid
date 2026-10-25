import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Onboarding } from "./Onboarding";

/**
 * Regresión M3-1 (QA móvil, PR #216): en el teléfono el botón de ayuda flotante
 * (fixed bottom-5 right-5) tapaba el borde derecho de «Generar video final» (revisión del Reel) y de «Siguiente»
 * (asistente de Podcast), las barras de acción fijas inferiores. Por debajo de `sm` la ayuda va al final de la página,
 * en el flujo; desde `sm` sigue flotando. La prueba de interfaz real es scripts/harness/e2e/qa-aceptacion/m3-help-overlap.cjs.
 */
test("la ayuda solo flota desde sm: en el teléfono no se superpone a las barras de acción fijas", () => {
  const html = renderToStaticMarkup(<Onboarding />);
  const cls = html.match(/<button[^>]*aria-label="Ver cómo funciona Atomicvid"[^>]*>/)?.[0].match(/class="([^"]*)"/)?.[1];
  assert.ok(cls, "el botón de ayuda se renderiza");
  const tokens = cls.split(/\s+/);
  assert.ok(!tokens.includes("fixed"), `sin «fixed» en móvil: ${cls}`);
  assert.ok(tokens.includes("sm:fixed"), `flota desde sm: ${cls}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Onboarding } from "./Onboarding";

/**
 * Regresión M3-1 (QA móvil, PR #216): en el teléfono el botón de ayuda flotante
 * (fixed bottom-5 right-5) tapaba el borde derecho de «Generar video final» (revisión del Reel) y de «Siguiente»
 * (asistente de Podcast), las barras de acción fijas inferiores, también a 640–765 px. Por debajo de `md` la ayuda va
 * al final de la página, en el flujo; desde `md` sigue flotando. La prueba de interfaz real es scripts/harness/e2e/qa-aceptacion/m3-help-overlap.cjs.
 */
test("la ayuda solo flota desde md: en el teléfono no se superpone a las barras de acción fijas", () => {
  const html = renderToStaticMarkup(<Onboarding />);
  const cls = html.match(/<button[^>]*aria-label="Ver cómo funciona Atomicvid"[^>]*>/)?.[0].match(/class="([^"]*)"/)?.[1];
  assert.ok(cls, "el botón de ayuda se renderiza");
  const tokens = cls.split(/\s+/);
  assert.ok(!tokens.includes("fixed"), `sin «fixed» en móvil: ${cls}`);
  assert.ok(tokens.includes("md:fixed") && !tokens.includes("sm:fixed"), `flota desde md, no desde sm: ${cls}`);
});

/**
 * Regresión Mystery Shopper 26-nov-2026 (cuenta-navegacion, 412 px, producción): el recorrido de bienvenida era un
 * modal con fondo a pantalla completa (fixed inset-0) que tapaba la cabecera, «Salir» y el dock hasta pulsar «Omitir».
 * Ahora es un aviso no modal: sin fondo que cubra la página, el contenedor no captura toques y solo la tarjeta los recibe.
 */
test("el recorrido de bienvenida no bloquea la página: sin fondo a pantalla completa, solo la tarjeta recibe toques", async () => {
  const { OnboardingTour } = await import("./Onboarding");
  const noop = () => {};
  const html = renderToStaticMarkup(<OnboardingTour step={0} onSkip={noop} onBack={noop} onNext={noop} />);
  const root = html.match(/<div data-testid="onboarding-tour" class="([^"]*)"/)?.[1] ?? "";
  const rootTokens = root.split(/\s+/);
  assert.ok(rootTokens.includes("pointer-events-none"), `el contenedor deja pasar los toques: ${root}`);
  assert.ok(!rootTokens.includes("inset-0") && !/bg-black/.test(root), `sin fondo que cubra la pantalla: ${root}`);
  assert.ok(rootTokens.includes("bottom-28") && rootTokens.includes("sm:bottom-6"), `por encima del dock móvil: ${root}`);
  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0] ?? "";
  assert.match(dialog, /aria-modal="false"/);
  assert.match(dialog, /pointer-events-auto/);
  for (const name of ["Omitir", "Siguiente"]) {
    const btn = html.match(new RegExp(`<button[^>]*>${name}</button>`))?.[0] ?? "";
    assert.match(btn, /min-h-11/, `«${name}» mide al menos 44 px: ${btn}`);
  }
  assert.match(html, /Paso 1 de \d+/);
  const last = renderToStaticMarkup(<OnboardingTour step={99} onSkip={noop} onBack={noop} onNext={noop} />);
  assert.match(last, />Empezar</, "un paso fuera de rango se acota al último en vez de romper la página");
});

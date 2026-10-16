import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentTypeStep } from "./ContentTypeStep";
import { NewVideoForm } from "./NewVideoForm";

test("formulario Avatar muestra el límite real de 45s y solo ofrece el objetivo de 30s", () => {
  const html = renderToStaticMarkup(<NewVideoForm action={() => {}} avatarModeEnabled existingAvatars={[]} initialMode="avatar" maxAvatarDurationSeconds={45} />);
  assert.match(html, /Límite de Avatar: 45 segundos/);
  assert.match(html, />30s<\/button>/);
  assert.doesNotMatch(html, />(60|90)s<\/button>/);
  const reel = renderToStaticMarkup(<NewVideoForm action={() => {}} avatarModeEnabled existingAvatars={[]} initialMode="visual" maxAvatarDurationSeconds={45} />);
  for (const seconds of [30, 60, 90]) assert.ok(reel.includes(`>${seconds}s</button>`));
});

/**
 * Regresión del QA blocker real (2026-09-25): "Video con avatar" desapareció
 * del selector "¿Qué quieres crear?" en Production para la cuenta beta
 * porque `avatarAccess` (page.tsx) quedó atado al flag global
 * AVATAR_MODE_ENABLED (apagado en producción) además del acceso privado.
 * Esta prueba renderiza el componente REAL (no un string-match de la
 * fuente) con las props que page.tsx produce hoy para una cuenta beta
 * autorizada (avatarAccess=true, longFormAccess=true) y verifica que el
 * selector muestra exactamente las tres opciones esperadas — ninguna, y
 * nunca un enlace a la ruta legacy D-ID.
 */

test('cuenta beta autorizada: el selector contiene exactamente "Reel / Short", "Video con avatar" y "YouTube / Documental"', () => {
  const html = renderToStaticMarkup(
    <ContentTypeStep
      createVideoRequestAction={() => {}}
      avatarModeEnabled
      existingAvatars={[]}
      avatarAccess
      longFormAccess
    />,
  );

  assert.match(html, /¿Qué quieres crear\?/, "debe mostrar el selector, no saltar directo al formulario de Reel");
  assert.match(html, /Reel \/ Short/);
  assert.match(html, /Video con avatar/);
  assert.match(html, /YouTube \/ Documental/);

  // Nunca un enlace real hacia la prueba privada D-ID legacy.
  assert.ok(!html.includes('href="/dashboard/avatar/prepare"'));

  // La tarjeta de Avatar es un <button> (revela NewVideoForm en el mismo
  // componente) — no un <a href> como Documental, que sí navega a otra ruta.
  const avatarCardIsButton = /<button[^>]*>[\s\S]*?Video con avatar/.test(html);
  assert.ok(avatarCardIsButton, 'la tarjeta "Video con avatar" debe ser un botón que revela el flujo nuevo, no un enlace de navegación');
});

test("cuenta sin acceso a Avatar ni Long Form: no se muestra selector, se va directo al formulario de Reel", () => {
  const html = renderToStaticMarkup(
    <ContentTypeStep
      createVideoRequestAction={() => {}}
      avatarModeEnabled={false}
      existingAvatars={[]}
      avatarAccess={false}
      longFormAccess={false}
    />,
  );

  assert.ok(!html.includes("¿Qué quieres crear?"), "sin acceso a ninguna beta, no debe haber selector que elegir");
  assert.ok(!html.includes("Video con avatar"));
});

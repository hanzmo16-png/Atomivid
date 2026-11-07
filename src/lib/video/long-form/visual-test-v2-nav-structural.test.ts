import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Prueba estructural (lectura de código fuente, sin DOM) del acceso
 * directo "Dry Run Long Form" en el nav del dashboard — mismo principio
 * que render-route-cas.test.ts y visual-test-v2-ui-structural.test.ts:
 * confirma en el código fuente que las invariantes de seguridad/UX
 * siguen ahí, para que no se pierdan sin que un test falle.
 *
 * T-20261107-1517 (CORRECCIÓN-1): también cubre la franja móvil sm:hidden
 * (flex-wrap, sin overflow-x-auto) para que el último ítem sea alcanzable
 * sin scroll horizontal; corre en la suite CI test:unit sin tocar package.json.
 */
const LAYOUT_SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "app", "dashboard", "layout.tsx"),
  "utf8",
);

test("layout.tsx muestra Dry Run Long Form solo a owner/admin (isCommandCenterAdmin), no a la allowlist de Long Form", () => {
  assert.ok(LAYOUT_SOURCE.includes("showLongFormDryRun = isCommandCenterAdmin(user)"));
  assert.equal(LAYOUT_SOURCE.includes("isLongFormAllowlisted"), false);
  assert.equal(LAYOUT_SOURCE.includes("isLongFormEnabled"), false);
});

test("layout.tsx contiene el texto exacto del botón/enlace \"Dry Run Long Form\"", () => {
  assert.ok(LAYOUT_SOURCE.includes("Dry Run Long Form"));
});

test("el enlace apunta exclusivamente a /dashboard/long-form/visual-test-v2 (solo navegación, sin ningún fetch/POST asociado)", () => {
  assert.ok(LAYOUT_SOURCE.includes('href="/dashboard/long-form/visual-test-v2"'));
  assert.equal(LAYOUT_SOURCE.includes("/api/long-form/visual-test-v2"), false);
  assert.equal(/fetch\s*\(/.test(LAYOUT_SOURCE), false);
});

test("en el nav de escritorio el enlace no entra en el corte sm (640 px): ahí partía la cabecera y el clic de la ayuda no abría el diálogo", () => {
  const start = LAYOUT_SOURCE.indexOf("showLongFormDryRun && (");
  const desktop = LAYOUT_SOURCE.slice(start, LAYOUT_SOURCE.indexOf("showPodcast &&", start));
  assert.ok(start !== -1 && desktop.length > 0);
  assert.match(desktop, /whitespace-nowrap/);
  assert.match(desktop, /xl:inline-block/);
  assert.equal(desktop.includes("sm:inline-block"), false);
});

test("el enlace aparece una sola vez, condicionado por showLongFormDryRun, y nunca en la franja móvil (sm:hidden)", () => {
  const occurrences = (LAYOUT_SOURCE.match(/showLongFormDryRun && \(/g) ?? []).length;
  assert.equal(occurrences, 1);
  const mobileStart = LAYOUT_SOURCE.indexOf('sm:hidden">');
  const mobile = LAYOUT_SOURCE.slice(mobileStart, LAYOUT_SOURCE.indexOf("</header>", mobileStart));
  assert.ok(mobileStart !== -1 && mobile.length > 0);
  assert.equal(mobile.includes("visual-test-v2"), false);
  assert.equal(mobile.includes("Dry Run Long Form"), false);
});

test("layout.tsx no importa ni referencia ningún proveedor real de imagen/voz/footage ni process.env directamente", () => {
  assert.equal(/openaiImageProvider|images\.generate|api\.openai\.com|elevenlabs|pexels/i.test(LAYOUT_SOURCE), false);
  assert.equal(LAYOUT_SOURCE.includes("process.env"), false);
});

function mobileStrip(): string {
  const mobileStart = LAYOUT_SOURCE.indexOf('sm:hidden">');
  assert.ok(mobileStart !== -1, "debe existir la franja sm:hidden");
  const mobile = LAYOUT_SOURCE.slice(
    mobileStart,
    LAYOUT_SOURCE.indexOf("</header>", mobileStart),
  );
  assert.ok(mobile.length > 0);
  return mobile;
}

test("T-1517: la franja móvil usa flex-wrap y ya no overflow-x-auto/whitespace-nowrap (último ítem alcanzable sin scroll horizontal de franja)", () => {
  const mobile = mobileStrip();
  assert.match(mobile, /className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium"/);
  // Solo clases del contenedor de la franja (ignora el comentario que menciona el defecto anterior).
  const classAttrs = [...mobile.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(classAttrs.some((c) => c.includes("flex-wrap")));
  assert.equal(
    classAttrs.some((c) => c.includes("overflow-x-auto")),
    false,
    "ninguna className de la franja móvil usa overflow-x-auto",
  );
  assert.equal(
    classAttrs.some((c) => c.includes("whitespace-nowrap")),
    false,
    "ninguna className de la franja móvil usa whitespace-nowrap",
  );
});

test("T-1517: Command Center y Podcast siguen gated en la franja móvil; Nuevo video y Salir quedan fuera de esa franja", () => {
  const mobile = mobileStrip();
  assert.match(
    mobile,
    /showCommandCenter && <NavLink href="\/dashboard\/command-center">Command Center<\/NavLink>/,
  );
  assert.match(
    mobile,
    /showPodcast && <NavLink href="\/dashboard\/podcast">Podcast<\/NavLink>/,
  );
  assert.ok(LAYOUT_SOURCE.includes("showCommandCenter = isCommandCenterAdmin(user)"));
  assert.ok(
    LAYOUT_SOURCE.includes(
      "showPodcast = canAccessLongFormBeta(user) && studioFlagFor(user).enabled",
    ),
  );
  assert.equal(mobile.includes("Nuevo video"), false);
  assert.equal(mobile.includes("Salir"), false);
  assert.ok(LAYOUT_SOURCE.includes('href="/dashboard/new"'));
  assert.ok(LAYOUT_SOURCE.includes("Nuevo video"));
  assert.ok(LAYOUT_SOURCE.includes('aria-label="Cerrar sesión"'));
  assert.ok(LAYOUT_SOURCE.includes("Salir"));
});

test("T-1517: escritorio conserva NavLinks sm:inline-block; la franja móvil sigue oculta desde sm", () => {
  assert.match(
    LAYOUT_SOURCE,
    /className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"/,
  );
  assert.match(LAYOUT_SOURCE, /border-t border-border px-4 py-2 sm:hidden/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * T-20261107-1517 — franja móvil del dashboard: el último ítem habilitado debe
 * quedar completamente visible sin depender de un scroll horizontal poco evidente.
 * Solo lectura de layout.tsx (misma familia que visual-test-v2-nav-structural).
 * No reabre gates de Command Center / Podcast (T-20261030-1514).
 */
const LAYOUT = readFileSync(join(__dirname, "layout.tsx"), "utf8");

function mobileStrip(): string {
  const start = LAYOUT.indexOf('sm:hidden">');
  assert.ok(start !== -1, "debe existir la franja sm:hidden");
  const end = LAYOUT.indexOf("</header>", start);
  assert.ok(end !== -1);
  return LAYOUT.slice(start, end);
}

test("la franja móvil usa flex-wrap y ya no overflow-x-auto/whitespace-nowrap (último ítem alcanzable sin scroll horizontal de franja)", () => {
  const mobile = mobileStrip();
  assert.match(mobile, /className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium"/);
  // Solo clases del contenedor de la franja (ignora el comentario que menciona el defecto anterior).
  const classAttrs = [...mobile.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(classAttrs.some((c) => c.includes("flex-wrap")));
  assert.equal(classAttrs.some((c) => c.includes("overflow-x-auto")), false, "ninguna className de la franja móvil usa overflow-x-auto");
  assert.equal(classAttrs.some((c) => c.includes("whitespace-nowrap")), false, "ninguna className de la franja móvil usa whitespace-nowrap");
});

test("Command Center y Podcast siguen gated en la franja móvil (isCommandCenterAdmin / showPodcast); Dry Run no aparece en móvil", () => {
  const mobile = mobileStrip();
  assert.match(mobile, /showCommandCenter && <NavLink href="\/dashboard\/command-center">Command Center<\/NavLink>/);
  assert.match(mobile, /showPodcast && <NavLink href="\/dashboard\/podcast">Podcast<\/NavLink>/);
  assert.equal(mobile.includes("visual-test-v2"), false);
  assert.equal(mobile.includes("Dry Run Long Form"), false);
  assert.ok(LAYOUT.includes("showCommandCenter = isCommandCenterAdmin(user)"));
  assert.ok(LAYOUT.includes("showPodcast = canAccessLongFormBeta(user) && studioFlagFor(user).enabled"));
});

test("Nuevo video y Salir permanecen fuera de la franja móvil (cabecera superior) y el layout no toca process.env ni proveedores de pago", () => {
  assert.ok(LAYOUT.includes('href="/dashboard/new"'));
  assert.ok(LAYOUT.includes("Nuevo video"));
  assert.ok(LAYOUT.includes('aria-label="Cerrar sesión"'));
  assert.ok(LAYOUT.includes("Salir"));
  const mobile = mobileStrip();
  assert.equal(mobile.includes("Nuevo video"), false);
  assert.equal(mobile.includes("Salir"), false);
  assert.equal(LAYOUT.includes("process.env"), false);
  assert.equal(/openai|elevenlabs|pexels|stripe/i.test(LAYOUT), false);
});

test("escritorio conserva NavLinks sm:inline-block; la franja móvil sigue oculta desde sm", () => {
  assert.match(LAYOUT, /className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"/);
  assert.match(LAYOUT, /border-t border-border px-4 py-2 sm:hidden/);
});

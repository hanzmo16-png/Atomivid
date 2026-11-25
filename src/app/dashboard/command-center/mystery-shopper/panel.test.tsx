import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultCatalog } from "@/lib/mystery-shopper/catalog";
import { MysteryShopperPanel } from "./MysteryShopperPanel";

test("el panel es simple: un botón principal, cinco datos a la vista y lo avanzado plegado", () => {
  const html = renderToStaticMarkup(<MysteryShopperPanel catalog={defaultCatalog()} sha="abc1234" environment="test" />);
  for (const text of ["Cliente misterioso", "PROBAR MI PLATAFORMA", "Producto", "Misión", "Modo", "Presupuesto autorizado", "USD 0", "Estado", "Cambiar producto, misión o perfil", "Historial"]) assert.ok(html.includes(text), text);
  assert.match(html, /<details/);
  assert.match(html, /min-h-14/);
  assert.match(html, /aria-live="polite"/);
  // Ni fixtures ni notas inventadas en la portada del panel.
  assert.doesNotMatch(html, /91[.,]5|FIXTURE|fixture/);
  assert.doesNotMatch(html, /sk-|service_role|MYSTERY_SHOPPER_HANS_AUTH=/);
  assert.ok(html.includes('id="mystery-shopper"'));
  assert.match(html, /Aún sin evaluación real/);
});

test("la página del Command Center sigue cerrada a quien no es dueño", async () => {
  const page = await readFile("src/app/dashboard/command-center/page.tsx", "utf8");
  assert.match(page, /isCommandCenterAdmin/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /force-dynamic/);
  assert.match(page, /MysteryShopperPanel/);
});

test("3.0: el panel muestra la matriz de certificación y, sin evaluaciones reales, nada sale como GO", async () => {
  const { CertificationMatrix } = await import("./CertificationMatrix");
  const html = renderToStaticMarkup(<CertificationMatrix jobs={[]} />);
  assert.match(html, /data-testid="ms-certificacion"/);
  assert.equal((html.match(/data-cert="BLOCKED"/g) ?? []).length, 7);
  assert.doesNotMatch(html, /data-cert="GO_/);
  assert.match(html, /USD 0\.00/);
});

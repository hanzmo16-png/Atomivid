import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultCatalog } from "@/lib/mystery-shopper/catalog";
import { MysteryShopperPanel } from "./MysteryShopperPanel";

test("el panel se entiende sin recorrer el producto y cabe en el celular", () => {
  const html = renderToStaticMarkup(<MysteryShopperPanel catalog={defaultCatalog()} sha="abc1234" environment="test" />);
  for (const text of ["Mystery Shopper AI", "Iniciar evaluación", "NO INICIADA", "Producto", "Perfil", "Misión", "Instrucciones", "Presupuesto máximo", "A · Gratuito", "B · Real"]) assert.ok(html.includes(text), text);
  assert.match(html, /min-h-11/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /sk-|service_role|MYSTERY_SHOPPER_HANS_AUTH=/);
  assert.ok(html.includes('id="mystery-shopper"'));
});

test("la página del Command Center sigue cerrada a quien no es dueño", async () => {
  const page = await readFile("src/app/dashboard/command-center/page.tsx", "utf8");
  assert.match(page, /isCommandCenterAdmin/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /force-dynamic/);
  assert.match(page, /MysteryShopperPanel/);
});

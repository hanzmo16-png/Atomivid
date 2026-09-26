import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalThumbnailPath, defaultPackaging, isOwnChannelAccount, suggestTitle, toCoverSpec, validatePackagingInput } from "./packaging";
import { COVER_CANVAS } from "../../../../remotion/cover-rules";

const env = { AVATAR_PREPARATION_OWNER_EMAIL: "hans@example.com", LONG_FORM_OWN_CHANNEL_EMAILS: "canal2@example.com, Canal3@Example.com" };

test("canales propios: la cuenta dueña y la lista explícita; cualquier otra cuenta no", () => {
  assert.equal(isOwnChannelAccount({ email: "Hans@Example.com" }, env), true);
  assert.equal(isOwnChannelAccount({ email: "canal3@example.com" }, env), true);
  assert.equal(isOwnChannelAccount({ email: "cliente@otro.com" }, env), false);
  assert.equal(isOwnChannelAccount(null, env), false);
  assert.equal(isOwnChannelAccount({ email: "hans@example.com" }, {}), false, "sin configuración nadie es canal propio");
});

test("por defecto: ambas activadas en canales propios, ambas desactivadas para otros clientes", () => {
  const own = defaultPackaging({ topic: "Cómo se construyó el Canal de Panamá", ownChannel: true });
  assert.equal(own.cover.enabled && own.thumbnail.enabled, true);
  const other = defaultPackaging({ topic: "Cómo se construyó el Canal de Panamá", ownChannel: false });
  assert.equal(other.cover.enabled || other.thumbnail.enabled, false);
  assert.ok(own.cover.title.length <= COVER_CANVAS.video.maxTitleChars);
  assert.ok(own.thumbnail.title.length <= COVER_CANVAS.thumbnail.maxTitleChars);
  assert.equal(own.cover.title, "Canal de Panamá");
  assert.equal(own.thumbnail.title, "Canal de Panamá", "no se corta el nombre del tema");
  assert.equal(validatePackagingInput(own).ok, true);
});

test("título sugerido: antes de «:» y recortado en límite de palabra", () => {
  assert.equal(suggestTitle("Göbekli Tepe: el misterio de 11,000 años", 40), "Göbekli Tepe");
  const cut = suggestTitle("Una historia muy larga sobre la construcción del canal", 32);
  assert.ok(cut.length <= 32 && !cut.endsWith(" "));
  assert.ok("Una historia muy larga sobre la construcción del canal".startsWith(cut));
});

test("validación de lo que envía el navegador: una, ambas o ninguna; nunca estilos inventados ni textos ilegibles", () => {
  const opt = (enabled: boolean, extra: Record<string, unknown> = {}) => ({ enabled, style: "sobrio", title: "Cavar una montaña", ...extra });
  assert.deepEqual(validatePackagingInput(undefined), { ok: true, packaging: undefined });
  const none = validatePackagingInput({ cover: opt(false), thumbnail: opt(false) });
  assert.ok(none.ok && none.packaging === undefined);
  const one = validatePackagingInput({ cover: opt(false), thumbnail: opt(true) });
  assert.ok(one.ok && one.packaging?.thumbnail.enabled);
  assert.equal(validatePackagingInput({ cover: opt(true, { style: "neón" }), thumbnail: opt(false) }).ok, false);
  assert.equal(validatePackagingInput({ cover: opt(true, { title: "x" }), thumbnail: opt(false) }).ok, false);
  assert.equal(validatePackagingInput({ cover: opt(false), thumbnail: opt(true, { title: "Un título demasiado largo para miniatura" }) }).ok, false);
  assert.equal(validatePackagingInput("portada").ok, false);
  // Desactivada: no se valida el texto (el cliente puede dejarlo a medias).
  assert.ok(validatePackagingInput({ cover: opt(false, { title: "" }), thumbnail: opt(false) }).ok);
});

test("especificación de render: arriba a la derecha y antetítulo vacío omitido", () => {
  assert.deepEqual(toCoverSpec({ enabled: true, style: "alerta", title: "T", kicker: "  " }), { style: "alerta", title: "T", kicker: undefined, placement: "top-right" });
  assert.equal(canonicalThumbnailPath("req-1"), "req-1/output/thumbnail.jpg");
});

test("interfaz: la configuración ofrece Portada de apertura y Miniatura como opciones independientes con vista previa", () => {
  const ui = readFileSync("src/app/dashboard/long-form/configure/[id]/PackagingOptions.tsx", "utf8");
  assert.match(ui, /Portada de apertura/);
  assert.match(ui, /Miniatura de YouTube/);
  assert.match(ui, /name=\{`\$\{kind\}_enabled`\}/, "cada opción tiene su propio interruptor");
  assert.match(ui, /CoverPreview/);
  const page = readFileSync("src/app/dashboard/long-form/configure/[id]/page.tsx", "utf8");
  assert.match(page, /isOwnChannelAccount\(user\)/);
  const configure = readFileSync("src/app/dashboard/long-form/configure/[id]/ConfigureProduction.tsx", "utf8");
  assert.match(configure, /disabled=\{!packagingValid\}/, "no se confirma con una opción ilegible");
});

test("Shorts y Avatar no cambian: la composición vertical y su pipeline no conocen la portada", () => {
  for (const f of ["remotion/VerticalReel.tsx", "src/lib/video/generate-video.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /cover-rules|OpeningTitle|packaging/, f);
  }
});

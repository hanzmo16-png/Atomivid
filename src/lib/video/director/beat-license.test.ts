/**
 * T36 C1 — licence of Director material, fail-closed, from the provider to the render (no network, synthetic data).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as footage from "@/lib/providers/footage";
import { realFootageProvider } from "@/lib/providers/footage/real";
import { fixtureFootageProvider } from "@/lib/providers/footage/fixture";
import { footageProviderLicense, footageResultLicense, GENERATED_IMAGE_LICENSE, licenseBlockAfterVoiceMessage, REVIEWED_FOOTAGE_LICENSES, strictestLicense } from "./beat-license";
import type { ResolvedBeat } from "./reel-render";

const src = (p: string) => readFileSync(p, "utf8");

test("solo los adaptadores revisados quedan CLEARED; cualquier otro o ausente ⇒ NEEDS_REVIEW", () => {
  assert.equal(footageProviderLicense(realFootageProvider), "CLEARED", "Pexels: adaptador conocido");
  assert.equal(footageProviderLicense(fixtureFootageProvider), "CLEARED", "fixture: contrato explícito");
  assert.equal(GENERATED_IMAGE_LICENSE, "CLEARED", "imagen generada: contrato explícito");
  for (const name of ["unsplash", "nuevo-stock", "", "constructor", "__proto__", "toString"]) assert.equal(footageProviderLicense({ name }), "NEEDS_REVIEW", name);
  assert.equal(footageProviderLicense(null), "NEEDS_REVIEW");
  assert.equal(footageProviderLicense(undefined), "NEEDS_REVIEW");
});

test("una declaración solo puede endurecer el veredicto, nunca liberarlo", () => {
  assert.equal(footageProviderLicense({ name: "nuevo-stock", license: "CLEARED" }), "NEEDS_REVIEW", "un proveedor desconocido no se autoriza a sí mismo");
  assert.equal(footageResultLicense(realFootageProvider, { license: "NEEDS_REVIEW" }), "NEEDS_REVIEW");
  assert.equal(footageResultLicense(realFootageProvider, { license: "NOT_CLEARED" }), "NOT_CLEARED");
  assert.equal(footageResultLicense({ name: "pexels-video-first", license: "NEEDS_REVIEW" }, { license: "CLEARED" }), "NEEDS_REVIEW");
  assert.equal(footageResultLicense(realFootageProvider, {}), "CLEARED");
  assert.equal(strictestLicense("CLEARED", "cleared"), "NEEDS_REVIEW", "un valor desconocido cuenta como pendiente");
  assert.equal(strictestLicense("NEEDS_REVIEW", "NOT_CLEARED", "CLEARED"), "NOT_CLEARED");
});

test("contrato: cada proveedor que getFootageProvider puede devolver tiene una decisión de licencia revisada explícita", () => {
  const index = src("src/lib/providers/footage/index.ts");
  const returned = [...new Set([...index.matchAll(/return[^;]*?\b(\w+FootageProvider)\b/g)].flatMap((m) => [...m[0].matchAll(/\b(\w+FootageProvider)\b/g)].map((x) => x[1])))];
  assert.ok(returned.length >= 2, `proveedores encontrados: ${returned.join(", ")}`);
  const mods = { realFootageProvider, fixtureFootageProvider } as Record<string, { name: string }>;
  for (const id of returned) {
    assert.ok(mods[id], `${id}: un proveedor nuevo en getFootageProvider necesita revisión de licencia (añádelo a este test y a REVIEWED_FOOTAGE_LICENSES)`);
    assert.ok(Object.hasOwn(REVIEWED_FOOTAGE_LICENSES, mods[id].name), `${mods[id].name} sin decisión de licencia`);
  }
  assert.equal(typeof footage.getFootageProvider, "function");
});

test("contrato de tipo: un beat sin licencia no compila (el campo es obligatorio)", () => {
  // @ts-expect-error — T36 C1: whoever resolves a beat must state its licence; omitting it is a type error.
  const noLicense: ResolvedBeat = { url: "https://fixture.local/x", mediaType: "image", source: "stock", start: 0, end: 1 };
  assert.equal(noLicense.license, undefined);
});

test("fixture local: FIXTURE_FOOTAGE_LICENSE solo puede declarar una licencia más estricta", () => {
  const before = process.env.FIXTURE_FOOTAGE_LICENSE;
  try {
    process.env.FIXTURE_FOOTAGE_LICENSE = "NEEDS_REVIEW";
    assert.equal(footageProviderLicense(fixtureFootageProvider), "NEEDS_REVIEW");
    process.env.FIXTURE_FOOTAGE_LICENSE = "NOT_CLEARED";
    assert.equal(footageProviderLicense(fixtureFootageProvider), "NOT_CLEARED");
    process.env.FIXTURE_FOOTAGE_LICENSE = "CLEARED";
    assert.equal(fixtureFootageProvider.license, undefined, "no hay forma de 'liberar' desde el entorno");
  } finally {
    if (before === undefined) delete process.env.FIXTURE_FOOTAGE_LICENSE; else process.env.FIXTURE_FOOTAGE_LICENSE = before;
  }
});

test("cableado: reel-render ya no fija CLEARED; generate-video propaga y corta; run-job comprueba antes de reservar", () => {
  const reel = src("src/lib/video/director/reel-render.ts");
  assert.doesNotMatch(reel, /license: "CLEARED"/, "sin licencia incondicional en directReel");
  assert.match(reel, /license: b\.license/);
  const gen = src("src/lib/video/generate-video.ts");
  assert.match(gen, /source: "generated", license: GENERATED_IMAGE_LICENSE/);
  assert.match(gen, /const license = footageResultLicense\(footageProvider, outcome\.result\);/);
  const cut = gen.indexOf('if (directorRender && license !== "CLEARED" && cinematicDirectorRenderEnabled()) {'), download = gen.indexOf("await footageProvider.downloadFootage(outcome.result.url)");
  assert.ok(cut > 0 && cut < download, "el corte por licencia ocurre antes de descargar/subir el material");
  const runJob = src("src/lib/video/run-job.ts");
  const decide = runJob.indexOf("const directorRender = mode === \"visual\" && await decideDirectorRender(row");
  const pre = runJob.indexOf('footageProviderLicense(getFootageProvider()) !== "CLEARED"');
  const reserve = runJob.indexOf("await reserveJobSupply(");
  assert.ok(decide > 0 && decide < pre && pre < reserve, "orden: decisión del Director → licencia del proveedor → reserva");
});

// ── T36 CORRECCIÓN-2 ────────────────────────────────────────────────────────────────────────────────────────────────
test("C2: ningún valor explícito fuera del trío da CLEARED sobre un proveedor revisado (incluidos nombres heredados)", () => {
  const hostile: unknown[] = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf",
    "arbitrary", "cleared", "CLEARED ", "CLEAR\u0415D" /* E cirílica */, "", null, {}, [], BigInt(1), Number.NaN, 0, true, Symbol("CLEARED")];
  for (const provider of [realFootageProvider, fixtureFootageProvider]) {
    for (const v of hostile) {
      assert.equal(footageResultLicense(provider, { license: v as never }), "NEEDS_REVIEW", `${provider.name}: ${String(v)}`);
      assert.equal(strictestLicense("CLEARED", v), "NEEDS_REVIEW", String(v));
    }
    assert.equal(footageResultLicense(provider, { license: "NOT_CLEARED" }), "NOT_CLEARED");
    assert.equal(footageResultLicense(provider, { license: "NEEDS_REVIEW" }), "NEEDS_REVIEW");
    assert.equal(footageResultLicense(provider, {}), "CLEARED", "ausencia = hereda el veredicto del proveedor (contrato)");
    assert.equal(footageResultLicense(provider, { license: undefined }), "CLEARED");
  }
  assert.equal(footageProviderLicense({ name: "pexels-video-first", license: "toString" as never }), "NEEDS_REVIEW", "también la declaración del proveedor");
});

test("C2 mutación: el control de pertenencia debe ser estricto (una versión con `in` reproduce el bypass)", () => {
  const RANK = { CLEARED: 0, NEEDS_REVIEW: 1, NOT_CLEARED: 2 };
  const mutant = (x: unknown) => typeof x === "string" && x in RANK; // el código de C1
  assert.equal(mutant("toString"), true, "el mutante acepta nombres heredados: por eso C1 daba CLEARED");
  const src = readFileSync("src/lib/video/director/beat-license.ts", "utf8");
  assert.doesNotMatch(src, /\bin RANK\b/, "beat-license.ts ya no usa `in RANK`");
  assert.match(src, /x === "CLEARED" \|\| x === "NEEDS_REVIEW" \|\| x === "NOT_CLEARED"/);
});

test("C2: el mensaje de bloqueo por resultado dice la verdad sobre la voz ya generada; nunca «no se cobró nada»", () => {
  const paid = licenseBlockAfterVoiceMessage(2, "NEEDS_REVIEW", { calls: 1, costUsd: 0.0291 });
  assert.match(paid, /escena 2/);
  assert.match(paid, /La narración de este intento ya se había generado antes de detectarlo/);
  assert.match(paid, /USD 0\.03/);
  assert.match(paid, /no se reembolsa automáticamente/);
  assert.match(paid, /pendiente de conciliación con soporte/);
  assert.match(paid, /licencia pendiente de revisión/);
  assert.doesNotMatch(paid, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, "sin códigos en mayúsculas: el sanitizador los cambia por «[configuración interna]»");
  const free = licenseBlockAfterVoiceMessage(2, "NOT_CLEARED", { calls: 1, costUsd: 0 });
  assert.match(free, /sin costo en este intento/);
  assert.doesNotMatch(free, /conciliación/);
  assert.match(free, /licencia no autorizada/);
  for (const m of [paid, free]) {
    assert.doesNotMatch(m, /no se (reservó|cobró)/i, "no promete gasto cero");
    assert.match(m, /ni con Director ni con montaje clásico/);
  }
});

test("C2 cableado: la voz se contabiliza y el bloqueo por resultado congela evidencia del intento antes de lanzar", () => {
  const gen = readFileSync("src/lib/video/generate-video.ts", "utf8");
  assert.equal(gen.match(/await synthesizeGated\(/g)?.length, 1, "todas las síntesis pasan por el contador");
  const cut = gen.indexOf('if (directorRender && license !== "CLEARED" && cinematicDirectorRenderEnabled()) {');
  const block = gen.indexOf("license-block.json", cut), thrown = gen.indexOf("throw new Error(licenseBlockAfterVoiceMessage(", cut);
  assert.ok(cut > 0 && block > cut && thrown > block, "evidencia antes del throw");
  assert.ok(gen.indexOf("await synthesizeCounted(fullText)") < cut, "la voz es anterior al corte (por eso el mensaje lo declara)");
});

test("C2 fixture local: FIXTURE_FOOTAGE_RESULT_LICENSE solo marca la búsqueda n-ésima", async () => {
  const before = process.env.FIXTURE_FOOTAGE_RESULT_LICENSE;
  try {
    process.env.FIXTURE_FOOTAGE_RESULT_LICENSE = "NEEDS_REVIEW@2";
    const a = await fixtureFootageProvider.searchImageCandidates!("uno");
    const b = await fixtureFootageProvider.searchImageCandidates!("dos");
    const c = await fixtureFootageProvider.searchImageCandidates!("tres");
    assert.ok(a.every((x) => x.license === undefined) && c.every((x) => x.license === undefined));
    assert.ok(b.every((x) => x.license === "NEEDS_REVIEW"));
    assert.equal(footageProviderLicense(fixtureFootageProvider), "CLEARED", "el proveedor sigue revisado: el corte es por resultado");
  } finally {
    if (before === undefined) delete process.env.FIXTURE_FOOTAGE_RESULT_LICENSE; else process.env.FIXTURE_FOOTAGE_RESULT_LICENSE = before;
  }
});

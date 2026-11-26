/**
 * T-21 (WCAG 1.4.3): en Audio Studio el texto secundario usa text-ink-muted (#a3a3b0: 7,48:1 sobre #121218 y 6,93:1
 * sobre #1a1a22), nunca text-ink-faint (#6b6b78: 3,55:1). El token global no se toca: la corrección es local al estudio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioLibrary } from "./AudioLibrary";
import { AudioEditor } from "./AudioEditor";
import { applyInput, newProject } from "@/lib/audio-studio/model";
import { view } from "@/lib/audio-studio/service";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-18T04:00:00.000Z";
const p1 = view(applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1", ownerId: A, now: NOW, title: "Contraste" }), {}, NOW), {});
const p2 = view(applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c2", ownerId: A, now: NOW, title: "Dos voces", voiceCount: 2, language: "en" }), { voiceCount: 2, language: "en" }, NOW), {});

test("Audio Studio no usa text-ink-faint (contraste < 4.5:1) en editor ni biblioteca, en ningún estado de síntesis", () => {
  const html = [
    renderToStaticMarkup(<AudioLibrary projects={[p1, p2]} archived={false} now={0} />),
    ...[null, "inactiva", "local", "real", "demo"].flatMap((s) => [p1, p2].map((p) => renderToStaticMarkup(<AudioEditor initial={p} synthesis={s as never} />))),
  ].join("\n");
  // Solo la clase de texto directa: «placeholder:text-ink-faint» (Field) y «bg-ink-faint» (punto del Badge) son
  // componentes globales fuera del alcance y axe no los marca (no son texto visible del estudio).
  assert.doesNotMatch(html, /(^|[\s"])text-ink-faint\b/);
  assert.match(html, /text-ink-muted/);
});

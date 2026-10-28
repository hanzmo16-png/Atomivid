import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AtomProgress } from "./AtomProgress";
import { HostPicker } from "./HostPicker";
import { StudioPreview } from "./StudioPreview";
import { progressView } from "@/lib/podcast/v3/progress";

test("indicador del átomo: porcentaje grande, etapa real, mensaje discreto; espera ≠ procesando; 100 % solo listo", () => {
  const now = Date.parse("2026-10-28T15:00:00Z");
  const running = renderToStaticMarkup(<AtomProgress view={progressView({ status: "generating", progress: { stage: "voces", pct: 12, done: 4, total: 26, updatedAt: "2026-10-28T14:59:30Z" } }, now)} />);
  assert.match(running, /data-state="procesando"/); assert.match(running, />12%</); assert.match(running, /Etapa: Voces · 4 de 26/);
  assert.match(running, /Estamos dando voz a tu episodio/); assert.match(running, /animate-atom-spin/); assert.match(running, /estimado por etapas/);
  assert.doesNotMatch(running, /En cola/);
  const waiting = renderToStaticMarkup(<AtomProgress view={progressView({ status: "authorized" }, now)} />);
  assert.match(waiting, /data-state="espera"/); assert.match(waiting, />0%</);
  const stale = renderToStaticMarkup(<AtomProgress view={progressView({ status: "generating", progress: { stage: "avatares", pct: 50, updatedAt: "2026-10-28T14:20:00Z" } }, now)} />);
  assert.match(stale, /data-state="sin_informacion"/); assert.doesNotMatch(stale, /animate-atom-spin/);
  const done = renderToStaticMarkup(<AtomProgress view={progressView({ status: "ready" }, now)} />);
  assert.match(done, />100%</); assert.match(done, /guardado y disponible/);
  const err = renderToStaticMarkup(<AtomProgress view={progressView({ status: "failed", progress: { stage: "montaje", pct: 81 } }, now)} />);
  assert.match(err, /data-state="error"/); assert.doesNotMatch(err, />100%</);
});

test("selector de anfitriones: foto, nombre, descripción y muestra de voz; uno ya elegido por el otro participante no se repite", () => {
  const hosts = [{ id: "valeria", name: "Valeria Montclair", role: "Anfitriona", description: "Cercana y curiosa.", voiceName: "Callie", photoUrl: "https://x/v.jpg", sampleUrl: "https://x/v.mp3" },
    { id: "victor", name: "Víctor Albarrán", role: "Divulgador científico (personaje virtual)", description: "Explica con ejemplos.", voiceName: "Víctor", photoUrl: "https://x/w.jpg", sampleUrl: null }];
  const html = renderToStaticMarkup(<HostPicker label="Participante A" hosts={hosts} selected="valeria" disabledIds={["victor"]} onSelect={() => {}} onCustom={() => {}} />);
  assert.match(html, /Valeria Montclair/); assert.match(html, /voz Callie/); assert.match(html, /Muestra de voz de Valeria Montclair/);
  assert.match(html, /aria-checked="true"[^>]*>[\s\S]*Valeria/);
  assert.match(html, /opacity-50" data-testid="anfitrion-victor"/);
  assert.match(html, /Personalizado/);
});

test("vista previa del estudio: fondo con el cuadro de neón, anfitriones en sus asientos y la mesa delante", () => {
  const html = renderToStaticMarkup(<StudioPreview studio="calido" a={{ url: "https://x/a.png", w: 1636, h: 1568, face: [605, 238, 510, 510] }} b={null} />);
  const order = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["/podcast/estudios/calido.jpg", "https://x/a.png", "/podcast/estudios/calido-frente.png"], "fondo → persona → mesa");
  assert.match(html, /left:\s*1\d(\.\d+)?%/, "A queda en el lado izquierdo");
});

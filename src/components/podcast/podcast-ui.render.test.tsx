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
  assert.match(html, /Otro \/ personalizado/);
});

test("vista previa del estudio: fondo con el cuadro de neón, anfitriones en sus asientos y la mesa delante", () => {
  const html = renderToStaticMarkup(<StudioPreview studio="calido" a={{ url: "https://x/a.png", w: 1636, h: 1568, face: [605, 238, 510, 510] }} b={null} />);
  const order = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["/podcast/estudios/calido.jpg", "https://x/a.png", "/podcast/estudios/calido-frente.png"], "fondo → persona → mesa");
  assert.match(html, /left:\s*1\d(\.\d+)?%/, "A queda en el lado izquierdo");
});

test("indicador del átomo con el libro real (ec30c594): etapa, cuentas por etapa, última actividad; diseño de móvil sin desbordes", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { ledgerActivity } = await import("@/lib/podcast/v3/progress");
  const ledger = ledgerActivity(JSON.parse(readFileSync(path.join(__dirname, "../../lib/podcast/v3/__fixtures__/ec30c594-ledger-1824.json"), "utf8")));
  const now = Date.parse("2026-10-29T18:24:39Z");
  const html = renderToStaticMarkup(<AtomProgress now={now} view={progressView({ status: "generating", progress: null, updated_at: "2026-10-29T14:34:45Z" }, now, ledger)} />);
  assert.match(html, /data-state="procesando"/); assert.doesNotMatch(html, />0%</); assert.match(html, />30%</);
  assert.match(html, /Etapa: Avatares · 7 listas/);
  assert.match(html, /Última actividad hace menos de 1 min: Generando clip de avatar 8/);
  assert.match(html, /data-stage="voces" data-state="hecha"[^>]*>✓ Voces 43</); assert.match(html, /data-stage="imagenes" data-state="hecha"[^>]*>✓ Imágenes 21</);
  assert.match(html, /data-stage="avatares" data-state="activa"/); assert.match(html, /Actividad reciente/);
  // Móvil: etapas en dos columnas que se recortan (truncate/min-w-0) en lugar de desbordar.
  assert.match(html, /grid min-w-0 grid-cols-2/); assert.match(html, /min-w-0 truncate/);
  const compact = renderToStaticMarkup(<AtomProgress compact now={now} view={progressView({ status: "generating", progress: null }, now, ledger)} />);
  assert.match(compact, /Última actividad/); assert.doesNotMatch(compact, /atom-progress-stages/);
  const stale = renderToStaticMarkup(<AtomProgress now={now + 11 * 60_000} view={progressView({ status: "generating", progress: null }, now + 11 * 60_000, ledger)} />);
  assert.match(stale, /El procesador no responde/); assert.match(stale, /no envía señales \(hace 11 min\)/); assert.match(stale, />30%</);
});

// Defecto real (2026-10-28, PR #246): el dueño no encontraba su avatar; solo aparecía tras pulsar «Personalizado».
test("avatares guardados: visibles con nombre y foto firmada; el que usa el otro participante no se repite", async () => {
  const { SavedAvatarPicker } = await import("./SavedAvatarPicker");
  const avatars = [{ id: "h", name: "Hans — Estudio podcast", photoUrl: "https://x/firmada-h.jpg" }, { id: "v", name: "Valeria Montclair", photoUrl: null }];
  const html = renderToStaticMarkup(<SavedAvatarPicker label="O usa un avatar guardado" who="B" avatars={avatars} selected="v" disabledIds={["h"]} onSelect={() => {}} />);
  assert.match(html, /Hans — Estudio podcast/); assert.match(html, /Valeria Montclair/);
  assert.match(html, /src="https:\/\/x\/firmada-h.jpg"/);
  assert.match(html, /aria-checked="true"[^>]*data-testid="avatar-guardado-B-v"/);
  assert.match(html, /disabled=""[^>]*data-testid="avatar-guardado-B-h"/);
  assert.match(html, /Ya lo usa el otro participante/);
  const none = renderToStaticMarkup(<SavedAvatarPicker label="x" who="A" avatars={[]} selected={null} onSelect={() => {}} />);
  assert.match(none, /Aún no tienes avatares guardados listos/);
});

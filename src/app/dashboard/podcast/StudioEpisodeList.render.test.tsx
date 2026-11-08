import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { StudioEpisodeList, StudioEpisodePlayback } from "./StudioEpisodeList";

test("la lista de la cuenta muestra reproductor y descarga cuando el episodio está listo", () => {
  const html = renderToStaticMarkup(
    <StudioEpisodePlayback
      title="Señal Wow"
      statusLabel="Listo"
      detail="narración · USD 1.20"
      videoUrl="https://example.test/ep.mp4"
      audioUrl="https://example.test/ep.mp3"
      error={null}
      canRedispatch={false}
    />,
  );
  assert.match(html, /Señal Wow/);
  assert.match(html, /data-testid="studio-player"/);
  assert.match(html, /data-testid="studio-audio-player"/);
  // La biblioteca no descarga ningún medio hasta pulsar reproducir: sin saltos de diseño ni datos móviles con 150 tarjetas.
  assert.equal((html.match(/preload="none"/g) ?? []).length, 2);
  assert.match(html, /data-testid="studio-download-mp4"/);
  assert.match(html, /data-testid="studio-download-audio"/);
  assert.doesNotMatch(html, /Reintentar inicio/);
});

test("un episodio solo audio no ofrece MP4 y uno autorizado ofrece reintentar el inicio", () => {
  const audio = renderToStaticMarkup(
    <StudioEpisodePlayback title="Solo voz" statusLabel="Listo" detail="narración" videoUrl={null} audioUrl="https://example.test/a.mp3" error={null} canRedispatch={false} />,
  );
  assert.match(audio, /data-testid="studio-download-audio"/);
  assert.doesNotMatch(audio, /studio-player|studio-download-mp4/);
  const queued = renderToStaticMarkup(
    <StudioEpisodePlayback title="En cola" statusLabel="Autorizado" detail="avatar" videoUrl={null} audioUrl={null} error={null} canRedispatch onRedispatch={() => {}} />,
  );
  assert.match(queued, /Volver a pedir el inicio \(no se cobra otra vez\)/);
  assert.doesNotMatch(queued, /studio-download/);
});

test("sin episodios de estudio la lista no ocupa la página", () => {
  assert.equal(renderToStaticMarkup(<StudioEpisodeList episodes={[]} />), "");
});

// ── Biblioteca limpia (T-20261107-2012): archivados y agrupados cerrados por defecto; en curso, sin control de archivo ──
const ID = "44444444-4444-4444-8444-444444444444";
const base = { id: ID, title: "Mi episodio", mode: "narracion", cost_usd: 1.2 };
// El botón de archivar usa useRouter: en el render de servidor necesita el contexto del App Router (como ResultView.*.test).
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as React.ContextType<typeof AppRouterContext>;
const render = (ui: React.ReactElement) => renderToStaticMarkup(<AppRouterContext.Provider value={router}>{ui}</AppRouterContext.Provider>);
const archiveControl = /biblioteca-(archivar|restaurar)-|>Archivar<|>Restaurar</;
/** El render inicial no debe pedir enlaces firmados ni estado: cualquier fetch durante el render se cuenta como fallo. */
function renderCounting(ui: React.ReactElement) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("fetch durante el render inicial"); }) as typeof fetch;
  try { return { html: render(ui), calls }; } finally { globalThis.fetch = original; }
}

test("archivado a mano: título, estado y «Ver episodio»; sin reproductor, descarga ni peticiones en el render inicial", () => {
  const { html, calls } = renderCounting(<StudioEpisodeList canArchive episodes={[{ ...base, status: "ready", archived: true }]} />);
  assert.match(html, /Mi episodio/);
  assert.match(html, /Listo · estudio: narración · USD 1\.20/);
  assert.match(html, new RegExp(`data-testid="studio-abrir-${ID}"[^>]*>Ver episodio<`));
  assert.doesNotMatch(html, /studio-player|studio-audio-player|studio-download/);
  assert.doesNotMatch(html, new RegExp(`studio-abierto-${ID}`));
  assert.equal(calls, 0);
  // Un archivado a mano sí ofrece restaurar (el dueño lo archivó; no está agrupado solo).
  assert.match(html, new RegExp(`biblioteca-restaurar-${ID}`));
});

test("agrupado solo (fallido, de prueba o borrador viejo): explica el motivo y «Ver episodio», sin archivar ni restaurar a mano", () => {
  const cases: [string, string][] = [
    ["failed", "Con error: se agrupa aquí automáticamente. Ábrelo para ver el motivo o reintentar."],
    ["ready", "Episodio de prueba: se agrupa aquí automáticamente."],
    ["draft", "Sin terminar desde hace más de 7 días."],
  ];
  for (const [status, autoNote] of cases) {
    for (const archived of [false, true]) {
      const { html, calls } = renderCounting(<StudioEpisodeList canArchive episodes={[{ ...base, status, autoNote, archived }]} />);
      assert.ok(html.includes(autoNote), `${status}: explica el motivo`);
      assert.match(html, />Ver episodio</, `${status}: ofrece abrirlo`);
      assert.doesNotMatch(html, archiveControl, `${status}: sin control manual`);
      assert.doesNotMatch(html, /studio-player|studio-audio-player|studio-download/);
      assert.equal(calls, 0, `${status}: sin peticiones al renderizar`);
    }
  }
});

test("autorizado y generando: se muestran activos y nunca ofrecen archivar, aunque canArchive sea true", () => {
  for (const [status, label] of [["authorized", "Autorizado"], ["generating", "Generando"]] as const) {
    const html = render(<StudioEpisodeList canArchive episodes={[{ ...base, status }]} />);
    assert.match(html, new RegExp(`${label} · estudio`));
    assert.doesNotMatch(html, archiveControl, `${status}: sin control de archivo`);
    assert.doesNotMatch(html, />Ver episodio</, `${status}: no está cerrado por defecto`);
  }
});

test("listo sin archivar: sigue a la vista con su control de archivar cuando canArchive es true, y sin él cuando es false", () => {
  const html = render(<StudioEpisodeList canArchive episodes={[{ ...base, status: "ready" }]} />);
  assert.match(html, /Listo · estudio/);
  assert.match(html, new RegExp(`biblioteca-archivar-${ID}`));
  assert.doesNotMatch(html, />Ver episodio</);
  const readOnly = render(<StudioEpisodeList episodes={[{ ...base, status: "ready" }]} />);
  assert.doesNotMatch(readOnly, archiveControl);
});

test("T-20261107-2314: archivado que seguirá agrupado — avisa antes y ofrece «Quitar archivo manual», no «Restaurar»; un listo archivado sigue con «Restaurar»", () => {
  const note = "Quitar el archivo manual no lo devuelve a «Mis episodios»: seguirá en «Archivados» porque tiene un error. Puedes abrirlo cuando quieras; no se borra nada.";
  const grouped = render(<StudioEpisodeList canArchive episodes={[{ ...base, status: "failed", archived: true, restoreNote: note }]} />);
  assert.ok(grouped.includes(note));
  assert.match(grouped, new RegExp(`biblioteca-quitar-archivo-${ID}`));
  assert.match(grouped, />Quitar archivo manual</);
  assert.doesNotMatch(grouped, />Restaurar</);
  assert.match(grouped, />Ver episodio</, "se puede abrir como siempre");
  const ready = render(<StudioEpisodeList canArchive episodes={[{ ...base, status: "ready", archived: true, restoreNote: null }]} />);
  assert.match(ready, />Restaurar</);
  assert.doesNotMatch(ready, /Quitar archivo manual|seguirá en «Archivados»/);
});

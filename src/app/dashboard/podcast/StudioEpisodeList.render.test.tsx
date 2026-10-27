import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
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

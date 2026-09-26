/**
 * Carga de la fuente de portada dentro de Remotion: se retiene el render
 * (delayRender) hasta que la fuente está lista, y SOLO cuando hay portada
 * o miniatura — sin portada, ninguna composición cambia su comportamiento.
 */
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import { COVER_FONT_FILE } from "./cover-rules";

let loading: Promise<void> | null = null;

function loadCoverFont(): Promise<void> {
  if (!loading) {
    const face = new FontFace("AtomividDisplay", `url(${staticFile(COVER_FONT_FILE)})`);
    loading = face.load().then((loaded) => {
      document.fonts.add(loaded);
    });
  }
  return loading;
}

export function useCoverFont(enabled: boolean): void {
  const [handle] = useState(() => (enabled ? delayRender("Cargando la fuente de portada") : null));
  useEffect(() => {
    if (handle === null) return;
    loadCoverFont()
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(err));
  }, [handle]);
}

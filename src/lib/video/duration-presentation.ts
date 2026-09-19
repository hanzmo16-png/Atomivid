export function durationPresentation(requested: number, measured: number | null, mode?: string) {
  const final = measured !== null && Number.isFinite(measured) && measured > 0 ? measured : null;
  const different = final !== null && Math.round(final * 1000) !== Math.round(requested * 1000);
  return {
    requested: `${requested.toLocaleString("es-MX", { maximumFractionDigits: 3 })} s`,
    delivered: final === null ? "Por verificar al cargar el archivo" : `${final.toLocaleString("es-MX", { maximumFractionDigits: 3 })} s`,
    reason: !different ? null : mode === "avatar"
      ? "La duración solicitada es un objetivo. El avatar se ajusta al audio y al archivo que entrega el proveedor; la duración mostrada se midió en el video final."
      : "La duración solicitada es un objetivo. El montaje se ajusta a la narración y al cierre para no cortar la voz; la duración mostrada se midió en el video final.",
  };
}

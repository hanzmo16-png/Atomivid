"use client";

import { STUDIO_H, STUDIO_W, cameraFor, placeInSeat, seatOf, studioDef, type StudioId } from "@/lib/podcast/v3/studios";

export type PreviewHost = { url: string; w: number; h: number; face: [number, number, number, number] } | null;

/**
 * Vista previa del estudio con la MISMA geometría que el render (studios.ts): fondo con el cuadro de neón, cada
 * anfitrión recortado sentado en su lado y la mesa delante. Sin anfitrión elegido, su lugar queda vacío.
 */
export function StudioPreview({ studio, a, b, swap = false, className = "" }: { studio: StudioId; a: PreviewHost; b: PreviewHost; swap?: boolean; className?: string }) {
  const st = studioDef(studio);
  const fr = { w: STUDIO_W, h: STUDIO_H };
  const people = ([["A", a], ["B", b]] as const).flatMap(([who, h]) => {
    if (!h) return [];
    const seat = seatOf(st, who, swap);
    const L = placeInSeat({ w: h.w, h: h.h, face: h.face }, seat, cameraFor("general", seat, "izquierda", fr));
    return [{ who, url: h.url, style: { left: `${(L.x / STUDIO_W) * 100}%`, top: `${(L.y / STUDIO_H) * 100}%`, width: `${(L.w / STUDIO_W) * 100}%` } }];
  });
  return (
    <div className={`relative w-full overflow-hidden rounded-lg bg-surface ${className}`} style={{ aspectRatio: "16 / 9" }} data-testid={`studio-preview-${studio}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/podcast/estudios/${st.id}.jpg`} alt={`Estudio ${st.label}`} className="absolute inset-0 h-full w-full object-cover" />
      {people.map((p) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={p.who} src={p.url} alt="" className="absolute max-w-none" style={p.style} />
      ))}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/podcast/estudios/${st.id}-frente.png`} alt="" className="absolute inset-0 h-full w-full object-cover" />
    </div>
  );
}

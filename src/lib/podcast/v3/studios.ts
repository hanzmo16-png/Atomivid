/**
 * Podcast — estudios compartidos (Moderno, Cálido, Minimalista). Los dos participantes se SIENTAN en el mismo estudio,
 * uno a cada lado de la mesa: se recorta a cada persona de su fondo original (matte.py) y se coloca por su CARA en su
 * asiento, con la mesa y los micrófonos delante (capa de primer término). Un único espacio virtual de 1920×1080 por
 * estudio y una «cámara» que lo encuadra:
 *  - plano general: el estudio completo, los dos en sus asientos;
 *  - primer plano: acercamiento al asiento de quien habla (misma posición: A a la izquierda, B a la derecha), con el
 *    fondo desenfocado como una cámara real y la persona a su resolución propia (no se amplía el plano general).
 * Recursos fijos (sin coste por episodio): public/podcast/estudios/<id>.jpg (fondo con el cuadro de neón ATOMICVID) y
 * <id>-frente.png (primer término con alfa), construidos con scripts/podcast-3-0/build-studios.py desde studios.json.
 */
import data from "./studios.json";

export const STUDIO_IDS = ["moderno", "calido", "minimalista"] as const;
export type StudioId = (typeof STUDIO_IDS)[number];
export type Seat = { x: number; face: number; faceH: number };
export type StudioDef = { id: StudioId; label: string; description: string; seats: { A: Seat; B: Seat }; grade: { warm: number; brightness: number; saturation: number } };
/** Espacio virtual de cada estudio (el fondo y el primer término tienen exactamente este tamaño). */
export const STUDIO_W = 1920, STUDIO_H = 1080;

export const STUDIOS: StudioDef[] = (data.studios as unknown as StudioDef[]).filter((s) => (STUDIO_IDS as readonly string[]).includes(s.id));
export function studioDef(id: string): StudioDef {
  const s = STUDIOS.find((x) => x.id === legacyStudio(id));
  if (!s) throw new Error(`Estudio desconocido: ${id}`);
  return s;
}
/** Escenarios anteriores (degradados de color) → estudio compartido equivalente: los episodios guardados siguen siendo válidos. */
export function legacyStudio(id: string): StudioId {
  if ((STUDIO_IDS as readonly string[]).includes(id)) return id as StudioId;
  return id === "estudio_calido" || id === "biblioteca" ? "calido" : id === "minimalista" ? "minimalista" : "moderno";
}
export const studioPlatePath = (id: StudioId) => `public/podcast/estudios/${id}.jpg`;
export const studioFrontPath = (id: StudioId) => `public/podcast/estudios/${id}-frente.png`;
export const studioThumbUrl = (id: StudioId) => `/podcast/estudios/${id}-mini.jpg`;

/** Cara detectada en un recorte: [x, y, ancho, alto] en píxeles del recorte. */
export type Face = [number, number, number, number];
export type Matte = { fg: string; alpha: string | null; w: number; h: number; face: Face | null; still: boolean };
export type Camera = { zoom: number; ox: number; oy: number; blur: number; frontBlur: number };
export type Layer = { x: number; y: number; w: number; h: number };
export type Frame = { w: number; h: number };

/** Cara de respaldo si el detector no encuentra ninguna: tercio superior centrado de un retrato. */
export function faceOf(m: Pick<Matte, "w" | "h" | "face">): Face {
  if (m.face && m.face[2] > 8) return m.face;
  const s = Math.round(Math.min(m.w, m.h) * 0.36);
  return [Math.round((m.w - s) / 2), Math.round(m.h * 0.16), s, s];
}

/** Asiento de cada participante (con «invertir posiciones», A pasa a la derecha). */
export function seatOf(st: StudioDef, who: "A" | "B", swap: boolean): Seat {
  return st.seats[(who === "A") !== swap ? "A" : "B"];
}

/**
 * Cámara del plano: zoom y desplazamiento del espacio virtual al cuadro de salida.
 *  - general 16:9: el estudio entero; 9:16: una franja centrada que abarca los dos asientos — el relleno lo pone la
 *    composición;
 *  - primer plano: la cara del asiento queda en (0,40·w | 0,60·w, 0,38·h) con la altura de cara pedida; el fondo se
 *    desenfoca en proporción al acercamiento (profundidad de campo) y el primer término todavía más (está más cerca).
 */
export function cameraFor(kind: "general" | "primer", seat: Seat, side: "izquierda" | "derecha", fr: Frame, span?: [number, number]): Camera {
  if (kind === "general") {
    // 9:16 con los dos asientos (span): la franja recorta los lados del estudio y abarca solo a los dos con margen de
    // hombros; las personas salen ~1,4× más grandes que con el estudio entero (prueba real 2026-10-28: se veían diminutas).
    const fit = fr.h > fr.w && span ? fr.w / Math.min(STUDIO_W, span[1] - span[0] + 2 * 2.4 * seat.faceH) : fr.w / STUDIO_W;
    const zoom = Math.max(fr.w / STUDIO_W, fit);
    const ox = span ? Math.round(Math.min(Math.max(((span[0] + span[1]) / 2) * zoom - fr.w / 2, 0), STUDIO_W * zoom - fr.w)) : 0;
    return { zoom, ox, oy: -Math.round((fr.h - STUDIO_H * zoom) / 2), blur: 0, frontBlur: 0 };
  }
  const vertical = fr.h > fr.w;
  // 9:16: cara algo mayor para que los hombros de un retrato cerrado salgan por los bordes (no se ve dónde termina).
  const faceH = fr.h * (vertical ? 0.18 : 0.26);
  const zoom = faceH / seat.faceH;
  const cx = fr.w * (vertical ? 0.5 : side === "izquierda" ? 0.4 : 0.6), cy = fr.h * (vertical ? 0.34 : 0.38);
  // Sin salirse del fondo: el desplazamiento se limita al estudio ampliado (la persona se coloca con la MISMA cámara).
  const ox = Math.round(Math.min(Math.max(seat.x * zoom - cx, 0), STUDIO_W * zoom - fr.w));
  const oy = Math.round(Math.min(Math.max(seat.face * zoom - cy, 0), STUDIO_H * zoom - fr.h));
  // Desenfoque relativo al plano general del MISMO cuadro (en cuadros pequeños de prueba el zoom puede ser < 1).
  // El radio se escala con el tamaño del cuadro para que el desenfoque se vea igual en cualquier resolución.
  const rel = zoom / (fr.w / STUDIO_W), px = Math.min(fr.w, fr.h) / STUDIO_H;
  return { zoom, ox, oy, blur: Math.max(0, Math.min(14, (rel - 1) * 3.2)) * px, frontBlur: Math.max(0, Math.min(22, (rel - 1) * 6)) * px };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** Posición y tamaño del recorte de un participante en el cuadro: su cara mide seat.faceH (× zoom) y queda en el asiento. */
export function placeInSeat(m: Pick<Matte, "w" | "h" | "face">, seat: Seat, cam: Camera): Layer {
  const [fx, fy, fw, fh] = faceOf(m);
  const s = (seat.faceH / fh) * cam.zoom;
  const w = even(m.w * s), h = even(m.h * s);
  const x = Math.round(seat.x * cam.zoom - cam.ox - (fx + fw / 2) * s);
  const y = Math.round(seat.face * cam.zoom - cam.oy - (fy + fh / 2) * s);
  return { x, y, w, h };
}

/** Corrección de color por estudio (ffmpeg): integra a las personas en la luz del estudio. */
export function gradeFilter(st: StudioDef): string {
  const g = st.grade, w = g.warm.toFixed(3);
  return `colorbalance=rm=${w}:bm=-${w}:rh=${(g.warm / 2).toFixed(3)}:bh=-${(g.warm / 2).toFixed(3)},eq=brightness=${g.brightness.toFixed(3)}:saturation=${g.saturation.toFixed(3)}`;
}

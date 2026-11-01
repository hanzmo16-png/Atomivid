/**
 * Clasificación del encuadre de una foto de avatar (T-20261101-0219) a partir de MÉTRICAS ya calculadas por otro
 * componente (por ejemplo, recorte de la persona + caja de la cara). Esta función NO detecta caras ni hombros: solo
 * clasifica los números que recibe. Es pura: sin red, disco, entorno ni reloj; sin texto de interfaz ni datos personales.
 *
 * Origen: incidente 8f05fc37 (hombros de un avatar cortados por el borde de la foto original). Umbrales calibrados en la
 * auditoría T-20261101-0111 (margen en anchos de cara desde el centro de la cara hasta cada borde lateral; unos hombros
 * reales miden ~2,6–3,0 caras de ancho). Caso real medido: 0,97 caras → hombros cortados; 1,42 → corte leve.
 *
 * Precedencia (de mayor a menor): BLOCK > STRONG_WARNING > WARNING > VALID. Se devuelven TODAS las razones detectadas,
 * en orden estable, y el nivel de la más grave.
 */

export type FramingLevel = "BLOCK" | "STRONG_WARNING" | "WARNING" | "VALID";

/** Razones estables (claves, no textos): la interfaz decide cómo explicarlas. */
export type FramingReason =
  /** La caja de la cara toca un borde de la imagen. */
  | "FACE_CUT"
  /** Métricas ausentes, no finitas, negativas o fuera de rango: no se puede afirmar nada del encuadre. */
  | "INVALID_METRICS"
  /** No se detectó cara (el detector puede fallar con perfiles o gafas): la colocación sería una suposición. */
  | "NO_FACE"
  /** Margen lateral mínimo < 1,2 caras: el corte cae en mitad del hombro. */
  | "TIGHT_MARGIN"
  /** La cara ocupa más de la mitad del alto: no caben hombros en un plano 16:9 sin ampliar en exceso. */
  | "FACE_TOO_LARGE"
  /** 1,2 ≤ margen < 1,5 y el cuerpo toca el borde a la altura de los hombros: corte leve. */
  | "NARROW_MARGIN_AT_SHOULDER";

export type FramingMetrics = {
  /** Se detectó una cara. */
  faceDetected: boolean;
  /** La caja de la cara toca algún borde de la imagen. */
  faceCut: boolean;
  /** Distancia del centro de la cara al borde izquierdo / derecho, en anchos de cara (null si no hay cara). */
  marginLeftFaces: number | null;
  marginRightFaces: number | null;
  /** Alto de la cara ÷ alto de la imagen, en (0, 1] (null si no hay cara). */
  faceHeightRatio: number | null;
  /** El cuerpo llega al borde lateral en la fila de los hombros. */
  shoulderTouchesEdge: boolean;
};

export type FramingResult = { level: FramingLevel; reasons: FramingReason[]; minMarginFaces: number | null };

export const FRAMING_THRESHOLDS = Object.freeze({ strongMarginFaces: 1.2, warnMarginFaces: 1.5, maxFaceHeightRatio: 0.5 });

const LEVEL_OF: Record<FramingReason, FramingLevel> = {
  FACE_CUT: "BLOCK",
  INVALID_METRICS: "STRONG_WARNING",
  NO_FACE: "STRONG_WARNING",
  TIGHT_MARGIN: "STRONG_WARNING",
  FACE_TOO_LARGE: "STRONG_WARNING",
  NARROW_MARGIN_AT_SHOULDER: "WARNING",
};
/** Orden estable de las razones en el resultado. */
const REASON_ORDER: readonly FramingReason[] = ["FACE_CUT", "INVALID_METRICS", "NO_FACE", "TIGHT_MARGIN", "FACE_TOO_LARGE", "NARROW_MARGIN_AT_SHOULDER"];
const RANK: Record<FramingLevel, number> = { VALID: 0, WARNING: 1, STRONG_WARNING: 2, BLOCK: 3 };

const isMargin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isRatio = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 1;

export function classifyPhotoFraming(m: FramingMetrics): FramingResult {
  const found = new Set<FramingReason>();
  const input = (m ?? {}) as Partial<FramingMetrics>;
  const booleansOk = typeof input.faceDetected === "boolean" && typeof input.faceCut === "boolean" && typeof input.shoulderTouchesEdge === "boolean";
  if (!booleansOk) found.add("INVALID_METRICS");
  // Una cara cortada bloquea aunque el resto falte: es la única regla de bloqueo.
  if (input.faceCut === true) found.add("FACE_CUT");
  let minMarginFaces: number | null = null;
  if (input.faceDetected === false) {
    found.add("NO_FACE");
  } else if (input.faceDetected === true) {
    const { marginLeftFaces: l, marginRightFaces: r, faceHeightRatio: q } = input;
    if (!isMargin(l) || !isMargin(r) || !isRatio(q)) {
      found.add("INVALID_METRICS");
    } else {
      minMarginFaces = Math.min(l, r);
      if (minMarginFaces < FRAMING_THRESHOLDS.strongMarginFaces) found.add("TIGHT_MARGIN");
      else if (minMarginFaces < FRAMING_THRESHOLDS.warnMarginFaces && input.shoulderTouchesEdge === true) found.add("NARROW_MARGIN_AT_SHOULDER");
      if (q > FRAMING_THRESHOLDS.maxFaceHeightRatio) found.add("FACE_TOO_LARGE");
    }
  }
  const reasons = REASON_ORDER.filter((x) => found.has(x));
  const level = reasons.reduce<FramingLevel>((lv, x) => (RANK[LEVEL_OF[x]] > RANK[lv] ? LEVEL_OF[x] : lv), "VALID");
  return { level, reasons, minMarginFaces };
}

/**
 * Portada de apertura y miniatura de YouTube (Long Form): reglas PURAS de
 * maquetación compartidas por la composición de Remotion, la miniatura y
 * la vista previa del flujo web. Sin dependencias de Remotion ni del DOM.
 *
 * - Tipografía: Anton (SIL Open Font License, public/fonts/). Los anchos
 *   por carácter son los avances reales de la fuente (hmtx / unitsPerEm),
 *   así el ajuste de líneas coincide con lo que se dibuja.
 * - El título se escribe en mayúsculas; `*palabras*` marca el énfasis
 *   (color o placa del estilo). Nada se encoge por debajo del mínimo
 *   legible: si no cabe, es un error de validación, no un texto diminuto.
 * - Convivencia: la portada nunca invade la franja de subtítulos ni la
 *   esquina de rótulos de procedencia («Recreación IA», créditos), y
 *   respeta los márgenes seguros del lienzo.
 */

export type CoverStyleId = "impacto" | "alerta" | "sobrio";
export type CoverPlacement = "top-right" | "top-left";
export type CoverCanvasId = "video" | "thumbnail";

export type CoverSpec = {
  style: CoverStyleId;
  /** Título (se muestra en mayúsculas). `*así*` marca las palabras de énfasis. */
  title: string;
  /** Antetítulo breve opcional (p. ej. el tema o las fechas). */
  kicker?: string;
  placement?: CoverPlacement;
};

export type CoverStyle = {
  id: CoverStyleId;
  label: string;
  description: string;
  titleColor: string;
  /** "text": las palabras de énfasis cambian de color; "plate": van sobre una placa de color. */
  highlightMode: "text" | "plate";
  highlightColor: string;
  highlightTextColor: string;
  kickerBg: string;
  kickerFg: string;
  outlineColor: string;
  /** Opacidad del degradado oscuro detrás del título (legibilidad sobre cualquier imagen). */
  scrimOpacity: number;
};

export const COVER_STYLES: Record<CoverStyleId, CoverStyle> = {
  impacto: {
    id: "impacto",
    label: "Impacto (amarillo)",
    description: "Título blanco muy grueso, palabra clave en amarillo y antetítulo sobre franja amarilla.",
    titleColor: "#FFFFFF",
    highlightMode: "text",
    highlightColor: "#FFD60A",
    highlightTextColor: "#FFD60A",
    kickerBg: "#FFD60A",
    kickerFg: "#0B0B0B",
    outlineColor: "#000000",
    scrimOpacity: 0.62,
  },
  alerta: {
    id: "alerta",
    label: "Alerta (rojo)",
    description: "Título blanco con la palabra clave sobre una placa roja y antetítulo en rojo.",
    titleColor: "#FFFFFF",
    highlightMode: "plate",
    highlightColor: "#D7140E",
    highlightTextColor: "#FFFFFF",
    kickerBg: "#D7140E",
    kickerFg: "#FFFFFF",
    outlineColor: "#000000",
    scrimOpacity: 0.62,
  },
  sobrio: {
    id: "sobrio",
    label: "Sobrio",
    description: "Título blanco sin color de acento, antetítulo sobre franja blanca. Para temas delicados.",
    titleColor: "#FFFFFF",
    highlightMode: "text",
    highlightColor: "#FFFFFF",
    highlightTextColor: "#FFFFFF",
    kickerBg: "#F2F2F2",
    kickerFg: "#0B0B0B",
    outlineColor: "#000000",
    scrimOpacity: 0.55,
  },
};

export const COVER_STYLE_IDS = Object.keys(COVER_STYLES) as CoverStyleId[];

export type Rect = { x: number; y: number; w: number; h: number };

type CanvasRules = {
  width: number;
  height: number;
  margin: { x: number; y: number };
  maxTitlePx: number;
  /** Mínimo legible (en celular, 1080p → ~360 px de ancho: 84 px ≈ 16 px en pantalla). */
  minTitlePx: number;
  kickerPx: number;
  maxLines: number;
  maxTitleWidthFrac: number;
  maxTitleChars: number;
  maxKickerChars: number;
};

export const COVER_CANVAS: Record<CoverCanvasId, CanvasRules> = {
  video: { width: 1920, height: 1080, margin: { x: 96, y: 64 }, maxTitlePx: 150, minTitlePx: 84, kickerPx: 44, maxLines: 3, maxTitleWidthFrac: 0.5, maxTitleChars: 40, maxKickerChars: 32 },
  thumbnail: { width: 1280, height: 720, margin: { x: 48, y: 40 }, maxTitlePx: 176, minTitlePx: 96, kickerPx: 40, maxLines: 3, maxTitleWidthFrac: 0.62, maxTitleChars: 32, maxKickerChars: 28 },
};

/**
 * Zonas reservadas del video 1920×1080 (ver LongFormDoc.tsx): subtítulos
 * abajo (SAFE_BOTTOM_PADDING 120 + hasta 2 líneas de 46 px con su placa) y
 * rótulos de procedencia arriba a la izquierda (píldora + crédito + marca
 * de pendiente, padding 44/56).
 */
export const VIDEO_CAPTION_ZONE_TOP = 780;
export const VIDEO_LABEL_ZONE: Rect = { x: 0, y: 0, w: 780, h: 200 };
/** Miniatura: YouTube superpone la duración abajo a la derecha. */
export const THUMBNAIL_DURATION_ZONE: Rect = { x: 1280 - 200, y: 720 - 90, w: 200, h: 90 };

/** Avance real de Anton por carácter (em). Desconocidos: 0.56 em, conservador. */
const ANTON_ADVANCE: Record<string, number> = {
  A: 0.485, B: 0.479, C: 0.474, D: 0.493, E: 0.412, F: 0.399, G: 0.485, H: 0.499, I: 0.227, J: 0.466, K: 0.472, L: 0.397, M: 0.746,
  N: 0.498, O: 0.486, P: 0.472, Q: 0.494, R: 0.477, S: 0.461, T: 0.396, U: 0.474, V: 0.469, W: 0.712, X: 0.484, Y: 0.446, Z: 0.41,
  Á: 0.485, É: 0.412, Í: 0.227, Ó: 0.486, Ú: 0.474, Ñ: 0.498, Ü: 0.474,
  "0": 0.494, "1": 0.331, "2": 0.494, "3": 0.494, "4": 0.494, "5": 0.494, "6": 0.494, "7": 0.494, "8": 0.494, "9": 0.494,
  " ": 0.234, ".": 0.229, ",": 0.236, ":": 0.242, ";": 0.245, "!": 0.229, "?": 0.492, "¿": 0.493, "¡": 0.227, "-": 0.311, "–": 0.311,
  "—": 0.563, "'": 0.214, '"': 0.429, "(": 0.291, ")": 0.291, "·": 0.234, "/": 0.405, "&": 0.52, "%": 1.057,
};
/** Espaciado de letra aplicado al dibujar (em). */
export const COVER_LETTER_SPACING_EM = 0.01;
/** Interlineado compacto; las líneas con tildes/virgulillas en mayúscula reciben espacio extra arriba (ver lineExtraTopEm). */
export const COVER_LINE_HEIGHT = 1.04;
/** Anton dibuja acentos y virgulillas de mayúscula muy altos (ascendente 1.18 em): sin este espacio chocan con la línea anterior. */
export const TALL_DIACRITIC = /[ÁÉÍÓÚÑÜ]/;
export const TALL_DIACRITIC_EXTRA_EM = 0.2;
export function lineExtraTopEm(line: { text: string }[]): number {
  return line.some((w) => TALL_DIACRITIC.test(w.text)) ? TALL_DIACRITIC_EXTRA_EM : 0;
}

export function textWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) w += (ANTON_ADVANCE[ch] ?? 0.56) + COVER_LETTER_SPACING_EM;
  return w;
}

export type CoverWord = { text: string; highlight: boolean };

/** Mayúsculas y énfasis (`*...*`, puede abarcar varias palabras). */
export function parseCoverTitle(title: string): CoverWord[] {
  const words: CoverWord[] = [];
  let inHighlight = false;
  for (const raw of title.trim().split(/\s+/).filter(Boolean)) {
    let token = raw;
    let starts = false;
    let ends = false;
    if (token.startsWith("*")) {
      starts = true;
      token = token.slice(1);
    }
    if (token.endsWith("*")) {
      ends = true;
      token = token.slice(0, -1);
    }
    const highlight = inHighlight || starts;
    if (starts && !ends) inHighlight = true;
    if (ends) inHighlight = false;
    const text = token.replace(/\*/g, "").toLocaleUpperCase("es");
    if (text) words.push({ text, highlight });
  }
  return words;
}

export function plainCoverTitle(title: string): string {
  return parseCoverTitle(title).map((w) => w.text).join(" ");
}

export type CoverLayout = {
  canvas: CoverCanvasId;
  fits: boolean;
  titlePx: number;
  kickerPx: number;
  lines: CoverWord[][];
  kicker?: string;
  /** Caja que ocupa todo el bloque (antetítulo + título), en px del lienzo. */
  box: Rect;
  align: "left" | "right";
};

/** Ancho de una línea en em, incluido el relleno de las placas de énfasis (estilo "plate"). */
export function lineWidthEm(words: CoverWord[], plate: boolean): number {
  return textWidthEm(words.map((w) => w.text).join(" ")) + (plate ? words.filter((w) => w.highlight).length * 0.16 : 0);
}

function wrap(words: CoverWord[], maxWidthPx: number, px: number, plate = false): CoverWord[][] | null {
  const lines: CoverWord[][] = [];
  let current: CoverWord[] = [];
  const lineWidth = (ws: CoverWord[]) => lineWidthEm(ws, plate) * px;
  for (const word of words) {
    if (lineWidth([word]) > maxWidthPx) return null; // una palabra más ancha que la caja nunca cabe
    const candidate = [...current, word];
    if (current.length && lineWidth(candidate) > maxWidthPx) {
      lines.push(current);
      current = [word];
    } else current = candidate;
  }
  if (current.length) lines.push(current);
  return lines;
}

export function fitCover(spec: CoverSpec, canvas: CoverCanvasId, options: { labelsTopLeft?: boolean } = {}): CoverLayout {
  const rules = COVER_CANVAS[canvas];
  const words = parseCoverTitle(spec.title);
  const kicker = spec.kicker?.trim() ? spec.kicker.trim().toLocaleUpperCase("es") : undefined;
  const maxWidth = rules.width * rules.maxTitleWidthFrac;
  const plate = COVER_STYLES[spec.style]?.highlightMode === "plate";
  const placement = spec.placement ?? "top-right";
  const top = placement === "top-left" && canvas === "video" && options.labelsTopLeft ? VIDEO_LABEL_ZONE.y + VIDEO_LABEL_ZONE.h + 16 : rules.margin.y;
  // Límite inferior: la franja de subtítulos en el video; el margen seguro en la miniatura.
  const maxBottom = canvas === "video" ? VIDEO_CAPTION_ZONE_TOP : rules.height - rules.margin.y;
  const kickerPad = Math.round(rules.kickerPx * 0.35);
  const kickerWidth = kicker ? textWidthEm(kicker) * rules.kickerPx + kickerPad * 2 : 0;
  const kickerHeight = kicker ? Math.round(rules.kickerPx * COVER_LINE_HEIGHT + kickerPad * 1.2) + Math.round(rules.kickerPx * 0.4) : 0;
  const heightFor = (px: number, lines: CoverWord[][]) =>
    Math.ceil(kickerHeight + lines.reduce((h, line) => h + px * (COVER_LINE_HEIGHT + lineExtraTopEm(line)), 0));
  let chosen: { px: number; lines: CoverWord[][] } | null = null;
  for (let px = rules.maxTitlePx; px >= rules.minTitlePx; px -= 2) {
    const lines = wrap(words, maxWidth, px, plate);
    if (lines && lines.length <= rules.maxLines && top + heightFor(px, lines) <= maxBottom) {
      chosen = { px, lines };
      break;
    }
  }
  const px = chosen?.px ?? rules.minTitlePx;
  const lines = chosen?.lines ?? wrap(words, Number.POSITIVE_INFINITY, px, plate) ?? [];
  const titleWidth = Math.max(0, ...lines.map((l) => lineWidthEm(l, plate) * px));
  const w = Math.ceil(Math.max(titleWidth, kickerWidth));
  const h = heightFor(px, lines);
  const box: Rect = placement === "top-right" ? { x: rules.width - rules.margin.x - w, y: top, w, h } : { x: rules.margin.x, y: top, w, h };
  return { canvas, fits: chosen !== null, titlePx: px, kickerPx: rules.kickerPx, lines, kicker, box, align: placement === "top-right" ? "right" : "left" };
}

// --- Contraste (WCAG 2.x) ---

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

export type CoverIssue = { code: string; severity: "error" | "warning"; message: string };

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Validación de la portada: legibilidad (tamaño mínimo, líneas, contraste
 * del estilo), longitud del texto, márgenes seguros y convivencia con
 * subtítulos y rótulos. `subject` (opcional): zona del sujeto principal
 * que no debe taparse (aviso).
 */
export function validateCover(
  spec: CoverSpec,
  canvas: CoverCanvasId,
  context: { labelsTopLeft?: boolean; subject?: Rect } = {},
): { layout: CoverLayout; issues: CoverIssue[] } {
  const rules = COVER_CANVAS[canvas];
  const issues: CoverIssue[] = [];
  const style = COVER_STYLES[spec.style];
  if (!style) {
    issues.push({ code: "style", severity: "error", message: "Estilo de portada desconocido." });
  }
  const plain = plainCoverTitle(spec.title ?? "");
  if (plain.length < 3) issues.push({ code: "title_empty", severity: "error", message: "Escribe un título de al menos 3 caracteres." });
  if (plain.length > rules.maxTitleChars) {
    issues.push({ code: "title_too_long", severity: "error", message: `El título tiene ${plain.length} caracteres; el máximo legible aquí es ${rules.maxTitleChars}.` });
  }
  if ((spec.kicker?.trim().length ?? 0) > rules.maxKickerChars) {
    issues.push({ code: "kicker_too_long", severity: "error", message: `El antetítulo supera ${rules.maxKickerChars} caracteres.` });
  }
  if ((spec.title.match(/\*/g)?.length ?? 0) % 2 !== 0) {
    issues.push({ code: "highlight_unclosed", severity: "error", message: "Un énfasis con * no está cerrado." });
  }
  const layout = fitCover(spec, canvas, { labelsTopLeft: context.labelsTopLeft });
  if (plain.length >= 3 && !layout.fits) {
    issues.push({ code: "does_not_fit", severity: "error", message: `El título no cabe en ${rules.maxLines} líneas con letra legible (mínimo ${rules.minTitlePx} px). Acórtalo.` });
  }
  const { box } = layout;
  if (box.x < rules.margin.x - 0.5 || box.y < rules.margin.y - 0.5 || box.x + box.w > rules.width - rules.margin.x + 0.5 || box.y + box.h > rules.height - rules.margin.y + 0.5) {
    issues.push({ code: "outside_safe_area", severity: "error", message: "La portada sale de los márgenes seguros." });
  }
  if (canvas === "video" && box.y + box.h > VIDEO_CAPTION_ZONE_TOP) {
    issues.push({ code: "overlaps_captions", severity: "error", message: "La portada invade la franja de subtítulos." });
  }
  if (canvas === "video" && context.labelsTopLeft && intersects(box, VIDEO_LABEL_ZONE)) {
    issues.push({ code: "overlaps_labels", severity: "error", message: "La portada tapa los rótulos de procedencia." });
  }
  if (canvas === "thumbnail" && intersects(box, THUMBNAIL_DURATION_ZONE)) {
    issues.push({ code: "overlaps_duration", severity: "error", message: "El título quedaría bajo la duración que YouTube superpone." });
  }
  if (context.subject && intersects(box, context.subject)) {
    issues.push({ code: "covers_subject", severity: "warning", message: "La portada tapa parte del sujeto principal: prueba la otra posición." });
  }
  if (style) {
    const checks: [string, string, string][] = [
      ["antetítulo", style.kickerFg, style.kickerBg],
      ["título", style.titleColor, style.outlineColor],
      ["énfasis", style.highlightTextColor, style.highlightMode === "plate" ? style.highlightColor : style.outlineColor],
    ];
    for (const [what, fg, bg] of checks) {
      if (contrastRatio(fg, bg) < 4.5) issues.push({ code: "low_contrast", severity: "error", message: `Contraste insuficiente en el ${what} (${contrastRatio(fg, bg)}:1).` });
    }
  }
  return { layout, issues };
}

export function coverErrors(result: { issues: CoverIssue[] }): CoverIssue[] {
  return result.issues.filter((i) => i.severity === "error");
}

/** Tiempo en pantalla de la portada: dentro de la primera escena, legible (≥ 1.5 s) y breve (≤ 3.2 s). */
export function coverWindowSeconds(firstSceneEndSeconds: number): { untilSeconds: number; fadeOutSeconds: number } {
  const untilSeconds = Math.min(3.2, Math.max(1.5, firstSceneEndSeconds));
  return { untilSeconds, fadeOutSeconds: 0.35 };
}

/** Pila tipográfica: la fuente se carga explícitamente (Remotion: staticFile; web: /fonts). */
export const COVER_FONT_FAMILY = "'AtomividDisplay', 'Anton', Impact, 'DejaVu Sans Condensed', sans-serif";
export const COVER_FONT_FILE = "fonts/Anton-Regular.ttf";

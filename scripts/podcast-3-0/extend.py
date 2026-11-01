"""Continuación del cuerpo cuando el retrato del proveedor viene cortado por el encuadre (incidente 8f05fc37).

El clip de HeyGen de una foto cerrada llega con los hombros tocando los bordes. Al sentar a la persona en el estudio,
ese borde se veía como una línea vertical. La versión anterior reflejaba la imagen hacia fuera con un alfa que se
desvanecía: dejaba una costura recta, «alas» rectangulares y reflejos de solapas y manos (incluso manos bajo el cuerpo).

Aquí la persona continúa de forma natural, solo por los lados que de verdad toca:
  - silueta: el hombro baja y se redondea hacia fuera (pendiente medida en el borde, nunca menor que la de un hombro);
  - textura: el tono de la ropa de cada altura (media de la franja interior, suavizada en vertical), sin copiar
    detalles: ni solapas, ni manos, ni rayas horizontales;
  - profundidad: se oscurece un poco y se suaviza al alejarse, y el alfa cae con una curva suave;
  - costura: las últimas columnas/filas del recorte (donde el modelo pierde opacidad junto al borde) toman el alfa de la
    franja interior, así no queda una línea entre lo original y lo prolongado.
Un lado que no toca el borde no se prolonga (alfa 0). Solo numpy y OpenCV: se prueba sin el modelo.
"""
import numpy as np
import cv2

BAND = 14      # franja interior (px) de la que se toman alfa y color
SEAM = 4       # columnas/filas del borde que heredan el alfa de la franja (el modelo las deja más transparentes)
TOUCH = 0.5    # alfa mínimo (0..1) en el borde para considerar que la persona toca ese lado
MIN_ROWS = 0.06  # fracción mínima del alto que debe tocar el borde para prolongar (evita prolongar un pelo suelto)


def _smoother(n):
    """Rampa 1 → 0 con derivada nula en los extremos (smootherstep)."""
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    return 1.0 - t * t * t * (t * (6 * t - 15) + 10)


def touches(a, side):
    """¿La persona toca ese borde del cuadro? Devuelve el perfil de alfa del borde (0..1 por fila) o None."""
    a = a.astype(np.float32) / 255.0
    band = a[:, :BAND] if side == "left" else a[:, -BAND:]
    prof = np.median(band, axis=1)
    return prof if (prof > TOUCH).mean() >= MIN_ROWS else None


def _side(fg, a, ex, side):
    h = a.shape[0]
    af = a.astype(np.float32) / 255.0
    prof = touches(a, side)
    if prof is None or ex <= 0:
        return np.zeros((h, ex, 3), np.uint8), np.zeros((h, ex), np.float32), af
    band = slice(0, BAND) if side == "left" else slice(a.shape[1] - BAND, a.shape[1])
    # Costura: el borde hereda el alfa de la franja interior.
    seam = slice(0, SEAM) if side == "left" else slice(a.shape[1] - SEAM, a.shape[1])
    af[:, seam] = np.maximum(af[:, seam], prof[:, None])
    # Color por fila: media ponderada por alfa de la franja, suavizada en vertical (sin rayas horizontales).
    w = af[:, band][..., None]
    col = (fg[:, band].astype(np.float32) * w).sum(1) / np.maximum(w.sum(1), 1e-3)
    col = cv2.GaussianBlur(col[:, None, :], (0, 0), sigmaX=0.1, sigmaY=max(3.0, h / 90))[:, 0, :]
    # Silueta: altura donde empieza el cuerpo en el borde y su pendiente (columnas cercanas al borde).
    rows = np.where(prof > TOUCH)[0]
    y0 = int(rows[0])
    near = range(0, min(60, a.shape[1] // 4))
    tops = []
    for k in near:
        c = af[:, k] if side == "left" else af[:, a.shape[1] - 1 - k]
        r = np.where(c > TOUCH)[0]
        if len(r): tops.append((k, r[0]))
    slope = 0.0
    if len(tops) >= 8:
        ks, ys = np.array(tops, dtype=np.float32).T
        slope = float(np.polyfit(ks, ys, 1)[0]) * -1.0  # hacia fuera: positivo = baja
    slope = min(max(slope, 0.45), 1.1)  # un hombro cae hacia fuera (~24°–48°): ni plano ni un brazo vertical
    d = np.arange(1, ex + 1, dtype=np.float32)
    top = y0 + slope * d * (1.0 + 1.2 * d / ex)          # baja y se curva: hombro redondeado
    yy = np.arange(h, dtype=np.float32)[:, None]
    soft = max(2.0, h / 300)
    shape = np.clip((yy - top[None, :]) / soft + 0.5, 0.0, 1.0)  # borde superior suave
    alpha = shape * prof[:, None] * _smoother(ex)[None, :]
    dark = 1.0 - 0.28 * (d / ex)                              # el hombro gira y recibe menos luz
    ext = (col[:, None, :] * dark[None, :, None]).clip(0, 255)
    ext = cv2.GaussianBlur(ext.astype(np.float32), (0, 0), sigmaX=max(1.5, ex / 60))
    if side == "left":
        ext, alpha = ext[:, ::-1], alpha[:, ::-1]
    return ext.astype(np.uint8), alpha, af


def extend(fg, a, ex, ey):
    """Prolonga primer plano y alfa por los lados (ex px) y por abajo (ey px), solo donde la persona toca el borde."""
    if ex <= 0 and ey <= 0:
        return fg, a
    el, al, af = _side(fg, a, ex, "left")
    er, ar, af2 = _side(fg, a, ex, "right")
    af = np.maximum(af, af2)  # costuras de ambos lados
    fg2 = np.concatenate([el, fg, er], axis=1)
    a2 = np.concatenate([al, af, ar], axis=1)
    if ey > 0:
        last = a2[-BAND:].astype(np.float32)
        prof = np.median(last, axis=0)
        a2[-SEAM:] = np.maximum(a2[-SEAM:], prof[None, :])
        wgt = last[..., None]
        col = (fg2[-BAND:].astype(np.float32) * wgt).sum(0) / np.maximum(wgt.sum(0), 1e-3)
        # Muy suavizado en horizontal: sin barras verticales de manos o solapas (bajo la mesa no hay detalle).
        col = cv2.GaussianBlur(col[None, :, :], (0, 0), sigmaX=max(12.0, fg2.shape[1] / 12), sigmaY=0.1)[0]
        ramp = _smoother(ey)
        fade = 1.0 - 0.35 * np.linspace(0, 1, ey, dtype=np.float32)
        below = (col[None, :, :] * fade[:, None, None]).clip(0, 255).astype(np.uint8)
        fg2 = np.concatenate([fg2, below], axis=0)
        a2 = np.concatenate([a2, prof[None, :] * ramp[:, None]], axis=0)
    return fg2, (a2 * 255.0).clip(0, 255).astype(np.uint8)

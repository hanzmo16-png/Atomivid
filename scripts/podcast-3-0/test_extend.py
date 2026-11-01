"""Pruebas de extend.py (sin modelo, USD 0): python3 scripts/podcast-3-0/test_extend.py

Incidente 8f05fc37: el retrato de Hans (clip 720×1280 de HeyGen desde una foto cerrada) toca los dos bordes; la
prolongación anterior (reflejo) dejaba una costura vertical, «alas» rectangulares y reflejos de manos y solapas.
"""
import sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extend import extend, touches

H, W, EX, EY = 400, 240, 72, 120


def portrait(touch_left=True, touch_right=True):
    """Busto sintético: cabeza arriba, torso que toca los bordes indicados, «manos» claras abajo junto al borde."""
    fg = np.full((H, W, 3), (40, 60, 90), np.uint8)       # chaqueta azul oscuro
    a = np.zeros((H, W), np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    a[((xx - W / 2) ** 2 / 40 ** 2 + (yy - 80) ** 2 / 55 ** 2) <= 1] = 255   # cabeza
    left = 0 if touch_left else 30
    right = W if touch_right else W - 30
    for y in range(150, H):                                 # hombros que bajan hacia los lados
        a[y, left:right] = 255
    fg[330:380, 10:60] = (200, 170, 150)                    # «mano» cerca del borde izquierdo
    fg[330:380, W - 60:W - 10] = (200, 170, 150)            # y del derecho
    fg[150:330, ::12] = (90, 110, 150)                      # rayas verticales (solapa/tejido)
    return fg, a


def check(cond, msg):
    if not cond:
        print("FAIL", msg); sys.exit(1)
    print("PASS", msg)


fg, a = portrait()
fg2, a2 = extend(fg, a, EX, EY)
check(fg2.shape[:2] == (H + EY, W + 2 * EX) and a2.shape == (H + EY, W + 2 * EX), "tamaño: +EX por lado y +EY abajo (la cara se desplaza EX, como antes)")
af = a2.astype(np.float32) / 255.0
right = af[:H, EX + W:]
left = af[:H, :EX]
# Continuidad: sin costura entre la última columna original y la primera prolongada (antes, salto visible).
seam_r = np.abs(af[200:330, EX + W - 1] - af[200:330, EX + W]).max()
seam_l = np.abs(af[200:330, EX] - af[200:330, EX - 1]).max()
check(seam_r < 0.12 and seam_l < 0.12, f"sin costura en el borde (salto máx. der {seam_r:.2f}, izq {seam_l:.2f})")
# Desvanecimiento: el alfa baja hacia fuera y llega a ~0 en el extremo.
check(right[250, 0] > 0.8 and right[250, -1] < 0.05 and np.all(np.diff(right[250]) <= 1e-6), "el hombro derecho se desvanece hacia fuera de forma monótona")
check(left[250, -1] > 0.8 and left[250, 0] < 0.05, "el hombro izquierdo también")
# Silueta: el hombro BAJA hacia fuera (no un rectángulo de borde superior plano).
top = lambda col: int(np.argmax(col > 0.3)) if (col > 0.3).any() else H
t_near, t_far = top(right[:, 4]), top(right[:, EX // 2])
check(t_far > t_near + 8, f"el borde superior del hombro cae hacia fuera ({t_near} → {t_far} px)")
# Sin reflejos: ni manos ni rayas copiadas en la prolongación (textura suave, sin detalle).
ext_rgb = fg2[150:H, EX + W + 4:, :].astype(np.float32)
mask = right[150:H, 4:] > 0.2
check(mask.any() and ext_rgb[mask].std(axis=0).max() < 18, f"textura sin detalle copiado (desv. {ext_rgb[mask].std(axis=0).max():.1f})")
skin = (np.abs(ext_rgb - np.array([200, 170, 150])).sum(axis=2) < 40) & mask
check(not skin.any(), "ninguna «mano» reflejada en la prolongación lateral")
below = fg2[H + 4:, EX:EX + W, :].astype(np.float32)
bars = np.abs(np.diff(below.mean(axis=0), axis=0)).max()
check(bars < 6, f"debajo, sin barras verticales ni manos reflejadas (salto máx. entre columnas {bars:.1f})")
# Solo donde toca: un lado sin contacto no se prolonga.
fg3, a3 = extend(*portrait(touch_left=False, touch_right=True), EX, EY)
check(a3[:H, :EX].max() == 0 and a3[:H, EX + W:].max() > 0, "un lado que no toca el borde no se prolonga")
check(touches(portrait(touch_left=False)[1], "left") is None and touches(a, "right") is not None, "detección de contacto con el borde")
# Sin prolongación pedida: entrada intacta.
fg4, a4 = extend(fg, a, 0, 0)
check(fg4 is fg and a4 is a, "--extend 0: sin cambios")
print("EXTEND_OK")

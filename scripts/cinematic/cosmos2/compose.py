#!/usr/bin/env python3
"""COSMOS 2 (USD 0). Entradas fuera del árbol (clips maestros e imágenes generadas, ver docs/cinematic-ui/README.md);
las rutas absolutas de abajo son las de la máquina donde se montó.
COSMOS 2 v2 (USD 0): nave nueva (vertical), visiones extra con color, final con salto a la luz + estallido dorado
que se resuelve en estrellas y vuelve al inicio del bucle.
Uso: compose_v2.py <portrait|landscape> <out_lossless.mp4>"""
import sys, math, subprocess
import numpy as np, cv2
from scipy.ndimage import gaussian_filter1d

orient, out = sys.argv[1], sys.argv[2]
P = orient == "portrait"
SRC = "/workspace/atomivid-video-bg/masters-grok/loop-9x16.mp4" if P else "/workspace/atomivid-video-bg/masters-grok/loop-16x9.mp4"
A = "/workspace/atomivid-video-bg/v2/assets/"
W, H = (720, 1280) if P else (1280, 720)
FPS = 24
CUT = 264            # 11,0 s: antes del encogimiento artificial
HEAD = 20            # 0,83 s de inicio que se funden al final
WARP_SRC = range(264, 332, 2)  # 34 fotogramas: la nave se aleja (acelerada ×2) durante el salto
N_BURST, N_RES = 17, HEAD
VP = (0.50 * W, 0.24 * H) if P else (0.64 * W, 0.34 * H)  # punto de fuga: el planeta
rng = np.random.default_rng(7)

cap = cv2.VideoCapture(SRC); src = []
while True:
    ok, f = cap.read()
    if not ok: break
    src.append(f)
print("frames", len(src))

def f32(x): return x.astype(np.float32) / 255

# ---------- Seguimiento de los motores (vertical) ----------
track = None
if P:
    L, R = [], []
    for f in src:
        x = f32(f); b, r = x[..., 0], x[..., 2]
        m = ((b > 0.85) & (b - r > 0.15)).astype(np.uint8); m[:400] = 0
        n, lab, st, cen = cv2.connectedComponentsWithStats(m)
        comps = sorted([k for k in range(1, n) if st[k, 4] > 30], key=lambda k: -st[k, 4])[:4]
        pts = sorted([(cen[k][0], cen[k][1]) for k in comps])
        if len(pts) >= 4:
            # las toberas interiores quedan más abajo: se alinea la fila de toberas del modelo con ellas
            dy = (pts[1][1] + pts[2][1]) / 2 - (pts[0][1] + pts[-1][1]) / 2
            L.append((pts[0][0], pts[0][1] + dy)); R.append((pts[-1][0], pts[-1][1] + dy))
        elif len(pts) >= 2: L.append(pts[0]); R.append(pts[-1])
        else: L.append(L[-1]); R.append(R[-1])
    L = gaussian_filter1d(np.array(L, float), 2.0, axis=0); R = gaussian_filter1d(np.array(R, float), 2.0, axis=0)
    track = (L, R)
    ship = cv2.imread(A + "ship-rgba.png", cv2.IMREAD_UNCHANGED).astype(np.float32) / 255
    SN = np.float32([[339, 811], [679, 812], [512, 126]])
    SNOZ = [(339, 811), (428, 822), (590, 822), (679, 812)]

def ship_affine(i, extra_scale=1.0, lift=0.0):
    L, R = track
    l, r = L[i], R[i]
    t = i / FPS
    # leve balanceo para que se sienta en vuelo
    bob = 1.5 * math.sin(t * 2.1); roll = math.radians(0.6 * math.sin(t * 1.3))
    u = r - l; s = np.linalg.norm(u); uh = u / s
    c, sn = math.cos(roll), math.sin(roll)
    uh = np.array([uh[0] * c - uh[1] * sn, uh[0] * sn + uh[1] * c])
    up = np.array([uh[1], -uh[0]])
    mid = (l + r) / 2 + np.array([0, bob]) + up * lift
    s *= extra_scale
    Lp = mid - uh * s / 2; Rp = mid + uh * s / 2; Np = mid + up * 1.44 * s + uh * 0.05 * s  # punta inclinada como la torre original (tapa la franja)
    return cv2.getAffineTransform(SN, np.float32([Lp, Rp, Np])), s

def overlay_ship(img, i, extra_scale=1.0, lift=0.0, alpha_mul=1.0, flick=1.0):
    M, s = ship_affine(i, extra_scale, lift)
    w = cv2.warpAffine(ship, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0))
    a = (w[..., 3:4] * alpha_mul)
    img = img * (1 - a) + w[..., :3] * 0.92 * a
    # resplandor de los motores con parpadeo
    glow = np.zeros((H, W), np.float32)
    for k, (x, y) in enumerate(SNOZ):
        p = M @ np.array([x, y, 1.0])
        fl = 0.75 + 0.25 * math.sin(i * 1.7 + k * 2.1) * math.sin(i * 0.63 + k)
        cv2.circle(glow, (int(p[0]), int(p[1])), max(2, int(0.035 * s)), float(fl * flick), -1, cv2.LINE_AA)
    glow = cv2.GaussianBlur(glow, (0, 0), max(2.0, 0.05 * s))[..., None]
    img = img + glow * np.array([1.0, 0.75, 0.45], np.float32) * 0.9 * alpha_mul
    return img, a[..., 0]

# ---------- Visiones nuevas ----------
def load_vision(name, target_w):
    im = f32(cv2.imread(A + name)); h, w = im.shape[:2]
    sc = target_w / w; im = cv2.resize(im, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
    im = np.clip((im - 0.04) / 0.96, 0, 1)  # negro puro
    noise = cv2.GaussianBlur(rng.random(im.shape[:2]).astype(np.float32), (0, 0), 1.6)
    noise = (noise - noise.min()) / (noise.max() - noise.min())
    return im, noise

if P:
    VIS = [  # (imagen, ancho, t0, t1, centro inicial, centro final, opacidad)
        ("vision-whale.jpg", 0.95 * W, 0.9, 3.0, (0.55, 0.13), (0.45, 0.11), 0.95),
        ("vision-astronaut.jpg", 0.42 * W, 6.5, 8.4, (0.20, 0.40), (0.22, 0.38), 0.95),
        ("vision-phoenix.jpg", 0.70 * W, 9.9, 12.0, (0.50, 0.42), (VP[0] / W, VP[1] / H), 1.0),
    ]
else:
    VIS = [
        ("vision-whale.jpg", 0.34 * W, 0.9, 3.0, (0.52, 0.13), (0.44, 0.12), 0.95),
        ("vision-astronaut.jpg", 0.30 * W, 5.0, 7.0, (0.86, 0.45), (0.84, 0.43), 0.95),
        ("vision-phoenix.jpg", 0.36 * W, 9.9, 12.0, (0.66, 0.50), (VP[0] / W, VP[1] / H), 1.0),
    ]
VIS = [(load_vision(n, wd), t0, t1, c0, c1, op) for n, wd, t0, t1, c0, c1, op in VIS]

def smooth(x): x = min(max(x, 0.0), 1.0); return x * x * (3 - 2 * x)

def add_visions(img, tt, behind=None):
    for (im, noise), t0, t1, c0, c1, op in VIS:
        if not (t0 <= tt <= t1): continue
        p = (tt - t0) / (t1 - t0)
        fin, fout = 0.45 / (t1 - t0), 0.55 / (t1 - t0)
        reveal = smooth(p / fin) if p < fin else (1 - smooth((p - (1 - fout)) / fout) if p > 1 - fout else 1.0)
        scale = 0.94 + 0.10 * p
        if c1 == (VP[0] / W, VP[1] / H):  # fénix: vuela hacia el punto de fuga y se encoge al final
            scale = 1.0 - 0.75 * smooth((p - 0.5) / 0.5)
        cx = (c0[0] + (c1[0] - c0[0]) * smooth(p)) * W; cy = (c0[1] + (c1[1] - c0[1]) * smooth(p)) * H
        h0, w0 = im.shape[:2]; sw, sh = max(2, int(w0 * scale)), max(2, int(h0 * scale))
        v = cv2.resize(im, (sw, sh)); nz = cv2.resize(noise, (sw, sh))
        # disolución en partículas: el umbral sube y baja con `reveal`
        mask = np.clip((reveal * 1.25 - nz) / 0.12, 0, 1)
        shimmer = 0.9 + 0.1 * math.sin(tt * 9.0)
        layer = v * mask[..., None] * op * shimmer
        x0, y0 = int(cx - sw / 2), int(cy - sh / 2)
        xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + sw), min(H, y0 + sh)
        if xa >= xb or ya >= yb: continue
        lay = layer[ya - y0:yb - y0, xa - x0:xb - x0]
        if behind is not None: lay = lay * (1 - behind[ya:yb, xa:xb, None])
        reg = img[ya:yb, xa:xb]
        img[ya:yb, xa:xb] = 1 - (1 - reg) * (1 - np.clip(lay, 0, 1))
    return img

# ---------- Acentos de color en las visiones existentes ----------
TINTS = ([(2.3, 4.7, (0.45, 0.80, 1.00)), (5.9, 8.7, (1.00, 0.80, 0.35)), (8.6, 11.0, (0.40, 0.72, 1.00))] if P else
         [(2.8, 5.6, (0.45, 0.80, 1.00)), (5.6, 7.4, (1.00, 0.80, 0.35)), (9.6, 11.0, (0.40, 0.72, 1.00))])  # BGR: dorado, azul, dorado
def tint(img, tt, ship_a=None):
    k = 0.0; col = None
    for t0, t1, c in TINTS:
        if t0 <= tt <= t1:
            k = min(smooth((tt - t0) / 0.5), smooth((t1 - tt) / 0.5)); col = np.array(c, np.float32)
    if k <= 0: return img
    lum = img.mean(axis=2); sat = img.max(axis=2) - img.min(axis=2)
    m = np.clip((lum - 0.45) / 0.25, 0, 1) * np.clip((0.35 - sat) / 0.2, 0, 1)
    m[int(0.72 * H):] = 0
    b, r = img[..., 0], img[..., 2]
    m *= 1 - np.clip((b - r - 0.1) / 0.1, 0, 1)  # no tocar los motores azules
    if ship_a is not None: m *= 1 - ship_a
    m = cv2.GaussianBlur(m, (0, 0), 1.5)[..., None] * 0.6 * k
    return img * (1 - m) + (lum[..., None] * col * 1.15) * m

def engines_flicker_land(img, i):
    b, g, r = img[..., 0], img[..., 1], img[..., 2]
    eng = np.clip((b - np.maximum(r, g) - 0.12) * 5, 0, 1) * np.clip((b - 0.6) * 4, 0, 1)
    fl = 0.55 + 0.45 * abs(math.sin(i * 0.9) * math.sin(i * 0.37 + 1))
    bloom = cv2.GaussianBlur(eng, (0, 0), 10)[..., None]
    return img + bloom * np.array([1.0, 0.7, 0.4], np.float32) * 0.6 * fl

def process_clip_frame(i, tt):
    img = f32(src[i]); sa = None
    if P:
        img = tint(img, tt)
        img, sa = overlay_ship(img, i)
    else:
        img = tint(img, tt); img = engines_flicker_land(img, i)
    img = add_visions(img, tt, sa)
    return img, sa

# ---------- Final: salto a la luz, estallido, estrellas ----------
NS = 520
ang = rng.uniform(0, 2 * math.pi, NS); rad0 = rng.uniform(0.15, 1.3, NS) * math.hypot(W, H) * 0.6
bri = rng.uniform(0.4, 1.0, NS); warm = rng.random(NS) < 0.35
def streaks(t01):
    acc = np.zeros((H, W, 3), np.float32)
    sp = t01 ** 2.2
    for a, r0, b_, wm in zip(ang, rad0, bri, warm):
        r1 = r0 * (1 - 0.85 * sp); ln = 4 + 260 * sp * (r0 / 600)
        ca, sa_ = math.cos(a), math.sin(a)
        x1, y1 = VP[0] + ca * r1, VP[1] + sa_ * r1; x2, y2 = VP[0] + ca * (r1 + ln), VP[1] + sa_ * (r1 + ln)
        col = (0.55 * b_, 0.85 * b_, 1.0 * b_) if wm else (1.0 * b_, 0.95 * b_, 0.9 * b_)
        cv2.line(acc, (int(x2 * 4), int(y2 * 4)), (int(x1 * 4), int(y1 * 4)), col, 1 if sp < 0.4 else 2, cv2.LINE_AA, shift=2)
    return cv2.GaussianBlur(acc, (0, 0), 0.8) * (0.25 + 0.75 * t01) * lowfade

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
dist = np.hypot(xx - VP[0], yy - VP[1]) / math.hypot(W, H)
lowfade = 1 - 0.7 * np.clip((yy / H - 0.45) / 0.35, 0, 1) if P else 1 - 0.55 * np.clip((0.42 - xx / W) / 0.42, 0, 1)
lowfade = lowfade[..., None]
GOLD = np.array([0.42, 0.78, 1.0], np.float32)  # BGR dorado cálido

def radial_zoom(img, z):
    M = np.float32([[z, 0, VP[0] * (1 - z)], [0, z, VP[1] * (1 - z)]])
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

NSF = 1400
fa = rng.uniform(0, 2 * math.pi, NSF); fr = rng.uniform(0.0, 1.0, NSF) ** 0.7; fb = rng.uniform(0.25, 1.0, NSF); fsz = rng.uniform(0.6, 1.6, NSF)
def starfield(t01):
    acc = np.zeros((H, W, 3), np.float32)
    e = 1 - (1 - t01) ** 3
    R = math.hypot(W, H) * 0.75
    for a, r, b_, s in zip(fa, fr, fb, fsz):
        rr = r * R * (0.25 + 0.75 * e)
        x, y = VP[0] + math.cos(a) * rr, VP[1] + math.sin(a) * rr
        if 0 <= x < W and 0 <= y < H:
            cv2.circle(acc, (int(x * 4), int(y * 4)), int(s * 4), (0.85 * b_, 0.92 * b_, 1.0 * b_), -1, cv2.LINE_AA, shift=2)
    return (acc * 1.2 + cv2.GaussianBlur(acc, (0, 0), 1.5)) * lowfade

enc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                        "-an", "-c:v", "libx264", "-crf", "6", "-preset", "fast", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
def emit(img): enc.stdin.write((np.clip(img, 0, 1) * 255).astype(np.uint8).tobytes())

head = []
for i in range(CUT):
    img, _ = process_clip_frame(i, i / FPS)
    if i < HEAD: head.append(img)
    else: emit(img)
    if i % 48 == 0: print(orient, "clip", i, flush=True)

# Salto: la nave se aleja, las estrellas se estiran hacia el planeta, todo se acelera.
nW = len(WARP_SRC)
for k, i in enumerate(WARP_SRC):
    t01 = k / (nW - 1); tt = 11.0 + k / FPS
    img = f32(src[i]); sa = None
    if P:
        img = tint(img, tt)
        img, sa = overlay_ship(img, i, extra_scale=1.0 - 0.55 * t01 ** 2, lift=-0.0, flick=1.0 + 1.5 * t01)
    else:
        img = engines_flicker_land(img, i) if t01 < 0.5 else img + 0
    img = add_visions(img, tt, sa)
    z = 1 + 0.25 * t01 ** 2
    zb = sum(radial_zoom(img, z * (1 + 0.012 * j * t01)) for j in range(4)) / 4  # desenfoque radial
    zb = zb * (1 - 0.35 * t01)
    st = streaks(t01)
    core = np.exp(-(dist / (0.02 + 0.05 * t01)) ** 2)[..., None] * GOLD * 0.9 * t01 ** 3
    emit(1 - (1 - zb) * (1 - np.clip(st + core, 0, 1)))
last = zb
# Estallido dorado (< 1 s), cálido y no cegador; deja oscura la zona baja.
for k in range(N_BURST):
    t01 = k / (N_BURST - 1)
    inten = smooth(t01 / 0.25) if t01 < 0.25 else 1 - smooth((t01 - 0.25) / 0.75)
    radius = 0.04 + 0.30 * smooth(t01)
    glow = np.exp(-(dist / radius) ** 2)[..., None]
    ring = np.exp(-((dist - radius * 1.3) / 0.012) ** 2)[..., None] * (1 - t01) * 0.8
    base = last * max(0.0, 1 - 2.5 * t01)
    light = (glow * 0.78 * inten + ring * 0.45) * GOLD * lowfade
    born = starfield(0.3 * t01) * smooth((t01 - 0.3) / 0.5)  # las estrellas nacen del estallido
    emit(1 - (1 - base) * (1 - np.clip(light + born, 0, 0.9)))
# Logo real de Atomicvid (src/components/ui/Logo.tsx + «Atomicvid» en Geist 600): sale del estallido en dorado, pasa al morado
# de la marca (#7c6aef) y se desvanece en las estrellas. Zona alta/central, lejos del titular.
N_LOGO = 44
lm = cv2.imread(A + "logo-lockup-mask.png", 0).astype(np.float32) / 255
LW = int((0.66 if P else 0.34) * W); LH = int(lm.shape[0] * LW / lm.shape[1])
LOGO_GOLD = np.array([0.48, 0.78, 0.95], np.float32)
LOGO_PURPLE = np.array([245, 127, 143], np.float32) / 255  # #8f7ff5 (accent-hover) en BGR
LC = (VP[0], VP[1] if P else VP[1])
for k in range(N_LOGO):
    t01 = k / (N_LOGO - 1); tt = k / FPS
    bg = np.clip(starfield(0.3 + 0.4 * t01) + np.exp(-(dist / 0.45) ** 2)[..., None] * GOLD * 0.18 * (1 - 0.6 * t01) * lowfade, 0, 1)
    appear = smooth(k / 9); fade = 1 - smooth((k - (N_LOGO - 11)) / 10)
    op = appear * fade
    shift = smooth((k - 18) / 12)  # dorado → morado
    col = LOGO_GOLD * (1 - shift) + LOGO_PURPLE * shift
    sc = 0.86 + 0.14 * (1 - (1 - min(1.0, k / 12)) ** 3) + 0.02 * t01
    w, h = max(2, int(LW * sc)), max(2, int(LH * sc))
    m = cv2.resize(lm, (w, h), interpolation=cv2.INTER_AREA)
    layer = np.zeros((H, W), np.float32)
    x0, y0 = int(LC[0] - w / 2), int(LC[1] - h / 2)
    layer[max(0, y0):y0 + h, max(0, x0):x0 + w] = m[max(0, -y0):, max(0, -x0):][:H - max(0, y0), :W - max(0, x0)]
    # destello que recorre las letras mientras es dorado
    sweep = np.exp(-(((xx - (x0 + (k / 18) * w * 1.3 - 0.15 * w)) / (0.06 * w)) ** 2))[..., None] * (1 - shift) * (k < 20)
    glow = cv2.GaussianBlur(layer, (0, 0), 6 + 6 * (1 - appear))[..., None]
    a = layer[..., None] * op
    img = bg * (1 - a) + (col * (0.92 + 0.5 * sweep)) * a
    img = 1 - (1 - img) * (1 - np.clip(glow * col * (0.55 + 0.35 * shift) * op, 0, 1))
    halo = cv2.GaussianBlur(layer, (0, 0), 22)[..., None]
    img = 1 - (1 - img) * (1 - np.clip(halo * col * 0.35 * shift * op, 0, 1))
    emit(img)
    if k == 14: cv2.imwrite(f"/workspace/atomivid-video-bg/final-v4/logo-dorado-{orient}.jpg", (np.clip(img, 0, 1) * 255).astype(np.uint8))
    if k == 34: cv2.imwrite(f"/workspace/atomivid-video-bg/final-v4/logo-morado-{orient}.jpg", (np.clip(img, 0, 1) * 255).astype(np.uint8))
# Se resuelve en un campo de estrellas que se funde con el inicio del bucle.
for k in range(N_RES):
    t01 = k / (N_RES - 1)
    residual = np.exp(-(dist / 0.5) ** 2)[..., None] * GOLD * 0.18 * (1 - t01) * lowfade
    sf = np.clip(starfield(0.7 + 0.3 * t01) + residual * 0.4, 0, 1)
    w = smooth(t01)
    emit(sf * (1 - w) + head[k] * w)
enc.stdin.close(); enc.wait()
print("ok", out, CUT - HEAD + nW + N_BURST + N_LOGO + N_RES, "frames")

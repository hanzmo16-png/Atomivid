"""Construye los estudios compartidos del podcast (recursos fijos, sin coste por episodio).

Uso: python3 build-studios.py CONFIG.json DIR_FUENTES DIR_SALIDA [--fuente FUENTE.ttf]
Por cada estudio de CONFIG (src/lib/podcast/v3/studios.json):
  - fondo 1920x1080 desde la imagen generada (Recraft) con el CUADRO DE NEÓN de la marca integrado en la pared: el símbolo
    oficial (LogoMark de src/components/ui/Logo.tsx: núcleo + tres órbitas elípticas a 0°, 60° y 120°) y debajo
    «ATOMICVID», dibujados con geometría controlada (letras exactas) y llevados a la perspectiva de la pared con una
    homografía; el resplandor ilumina un poco la pared alrededor;
  - capa de PRIMER TÉRMINO (PNG con alfa): mesa, micrófonos y objetos que quedan DELANTE de los participantes;
  - una miniatura para el selector.
Las coordenadas (asientos, polígonos, cartel) se fijaron a mano mirando cada imagen; ver studios.json.
"""
import json, math, sys, os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def neon_sign(width, color, font_path, frame=True):
    """Cuadro de pared (RGBA, vista frontal) con el símbolo y el nombre en tubos de neón."""
    S = 4  # supermuestreo
    w = width * S
    h = int(w * 1.05)
    core = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(core)
    # Símbolo oficial: viewBox 24x24, elipses rx=10 ry=4.1 rotadas 0/60/120, núcleo r=2.6, trazo 1.3.
    cx, cy, unit = w / 2, h * 0.36, w * 0.024
    stroke = max(2, int(1.25 * unit))
    for rot in (0, 60, 120):
        pts = []
        for k in range(361):
            t = math.radians(k)
            x, y = 10 * math.cos(t), 4.1 * math.sin(t)
            r = math.radians(rot)
            pts.append((cx + unit * (x * math.cos(r) - y * math.sin(r)), cy + unit * (x * math.sin(r) + y * math.cos(r))))
        d.line(pts, fill=255, width=stroke, joint="curve")
    d.ellipse([cx - 2.6 * unit, cy - 2.6 * unit, cx + 2.6 * unit, cy + 2.6 * unit], fill=255)
    # Nombre: un solo trazo de contorno (tubo), letras de la fuente; tamaño ajustado al ancho del cuadro.
    text = "ATOMICVID"
    size = int(w * 0.15)
    font = ImageFont.truetype(font_path, size)
    while d.textlength(text, font=font) > w * 0.84:
        size -= 2
        font = ImageFont.truetype(font_path, size)
    tw = d.textlength(text, font=font)
    ty = h * 0.70
    d.text(((w - tw) / 2, ty), text, font=font, fill=0, stroke_width=max(2, int(size * 0.045)), stroke_fill=255)
    core = core.resize((width, int(h / S)), Image.LANCZOS)
    hh = core.size[1]
    c = np.array(core).astype(np.float32) / 255
    col = np.array(color, dtype=np.float32) / 255
    # Neón: núcleo casi blanco + halo del color de marca en dos radios.
    glow1 = np.array(core.filter(ImageFilter.GaussianBlur(width * 0.012))).astype(np.float32) / 255
    glow2 = np.array(core.filter(ImageFilter.GaussianBlur(width * 0.045))).astype(np.float32) / 255
    light = np.clip(c[..., None] * (0.55 + 0.45 * col) + glow1[..., None] * col * 1.6 + glow2[..., None] * col * 1.2, 0, 1)
    alpha = np.clip(c * 1.0 + glow1 * 1.3 + glow2 * 0.9, 0, 1)
    rgba = np.dstack([light, alpha])
    if frame:
        # Cuadro de vidrio ahumado con marco de bronce (degradado vertical suave): el neón va montado en un cuadro de
        # pared, no flotando ni como un rectángulo negro pegado.
        panel = np.zeros((hh, width, 4), np.float32)
        g = np.linspace(0, 1, hh)[:, None]
        panel[..., 0] = 0.05 + 0.03 * g; panel[..., 1] = 0.045 + 0.025 * g; panel[..., 2] = 0.06 + 0.02 * g
        panel[..., 3] = 0.82
        b = max(4, width // 45)
        bronze = np.array([0.42, 0.31, 0.18], np.float32)
        for sl in (np.s_[:b, :], np.s_[-b:, :], np.s_[:, :b], np.s_[:, -b:]):
            panel[sl + (slice(0, 3),)] = bronze
            panel[sl + (3,)] = 1.0
        hi = max(1, b // 3)  # filo iluminado del marco
        panel[b:b + hi, b:-b, :3] = bronze * 0.55
        out = panel.copy()
        a = rgba[..., 3:4]
        out[..., :3] = rgba[..., :3] + out[..., :3] * (1 - a)
        out[..., 3] = 1 - (1 - panel[..., 3]) * (1 - rgba[..., 3])
        rgba = out
    return (rgba * 255).astype(np.uint8)


def warp_into(dst, sign, quad, spill_color, spill):
    """Lleva el cuadro a la pared (homografía) y añade el reflejo de la luz en la pared alrededor."""
    h, w = sign.shape[:2]
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), np.float32(quad))
    warped = cv2.warpPerspective(sign, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0)).astype(np.float32) / 255
    a = warped[..., 3:4]
    out = dst.astype(np.float32) / 255
    sh = cv2.GaussianBlur(np.roll(np.roll(a[..., 0], 6, 0), 4, 1), (0, 0), 6)
    out = out * (1 - 0.45 * sh[..., None])  # sombra suave del cuadro sobre la pared
    mask = cv2.GaussianBlur(a[..., 0], (0, 0), max(4, (quad[1][0] - quad[0][0]) * 0.18))
    out = 1 - (1 - out) * (1 - mask[..., None] * spill * np.array(spill_color, np.float32) / 255)  # resplandor (screen)
    out = warped[..., :3] * a + out * (1 - a)
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


def build_desk(plate, d):
    """Mesa de podcast frontal construida sobre la imagen (BGR): cubierta en ligera perspectiva + frente hasta el borde
    inferior, con la textura de madera de la propia imagen (zona d["texture"]), brillo en el canto y, opcionalmente, una
    franja de luz LED. Devuelve la imagen y la máscara de la mesa (primer término)."""
    x0, x1, top, depth = d["x0"], d["x1"], d["top"], d["depth"]
    inset = d.get("inset", 40)
    tx = d["texture"]
    tex = plate[tx[1]:tx[3], tx[0]:tx[2]].copy()
    tex = cv2.resize(tex, (x1 - x0, H - top), interpolation=cv2.INTER_CUBIC)
    tex = cv2.GaussianBlur(tex, (0, 0), 1.2)
    out = plate.copy()
    mask = np.zeros((H, W), np.uint8)
    # Cubierta: trapecio (más estrecho al fondo).
    top_poly = np.int32([[x0 + inset, top], [x1 - inset, top], [x1, top + depth], [x0, top + depth]])
    cv2.fillPoly(mask, [top_poly], 255)
    # Frente: rectángulo hasta abajo.
    cv2.rectangle(mask, (x0, top + depth), (x1, H), 255, -1)
    region = np.zeros_like(out)
    region[top:H, x0:x1] = tex
    shade = np.ones((H, W), np.float32)
    g = np.linspace(0, 1, H - top - depth)
    shade[top + depth:H, :] = (d.get("front", 0.62) - 0.22 * g)[:, None]  # frente más oscuro hacia abajo
    shade[top:top + depth, :] = d.get("surface", 1.05)
    lit = np.clip(region.astype(np.float32) * shade[..., None] * np.array(d.get("tint", [1, 1, 1]), np.float32), 0, 255)
    edge = top + depth
    lit[edge - 2:edge + 3, x0:x1] = np.clip(lit[edge - 2:edge + 3, x0:x1] * 1.45 + 18, 0, 255)  # canto iluminado
    if d.get("led"):
        y = edge + int((H - edge) * 0.42)
        c = np.array(d["led"], np.float32)
        lit[y:y + 4, x0 + 6:x1 - 6] = c
        glow = np.zeros((H, W), np.float32); glow[y:y + 4, x0 + 6:x1 - 6] = 1
        glow = cv2.GaussianBlur(glow, (0, 0), 9)
        lit = np.clip(lit + glow[..., None] * c * 0.9, 0, 255)
    m = cv2.GaussianBlur(mask, (0, 0), 1.0).astype(np.float32)[..., None] / 255
    out = (lit * m + out.astype(np.float32) * (1 - m)).astype(np.uint8)
    # Sombra suave de la mesa sobre lo que queda detrás (la mesa está más cerca de la luz principal).
    sh = np.zeros((H, W), np.float32); sh[max(0, top - 30):top, x0 + inset:x1 - inset] = 1
    sh = cv2.GaussianBlur(sh, (0, 0), 14)
    out = (out.astype(np.float32) * (1 - 0.25 * sh[..., None])).astype(np.uint8)
    return out, mask


def paste_props(dst, src_plate, props):
    """Objetos recortados de otra imagen de estudio (p. ej. micrófonos de mesa) colocados en la mesa nueva."""
    mask_all = np.zeros((H, W), np.uint8)
    for p in props:
        src = cv2.resize(cv2.imread(p["from"], cv2.IMREAD_COLOR), (W, H), interpolation=cv2.INTER_LANCZOS4)
        pm = np.zeros((H, W), np.uint8)
        cv2.fillPoly(pm, [np.int32(p["poly"])], 255)
        x, y, w, h = cv2.boundingRect(np.int32(p["poly"]))
        crop, cm = src[y:y + h, x:x + w], pm[y:y + h, x:x + w]
        s = p.get("scale", 1.0)
        if p.get("flip"): crop, cm = cv2.flip(crop, 1), cv2.flip(cm, 1)
        crop = cv2.resize(crop, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        cm = cv2.resize(cm, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        cm = cv2.GaussianBlur(cm, (0, 0), 0.8)
        X, Y = p["at"]
        hh, ww = cm.shape
        a = cm.astype(np.float32)[..., None] / 255
        roi = dst[Y:Y + hh, X:X + ww]
        dst[Y:Y + hh, X:X + ww] = (crop * a + roi * (1 - a)).astype(np.uint8)
        mask_all[Y:Y + hh, X:X + ww] = np.maximum(mask_all[Y:Y + hh, X:X + ww], cm)
    return dst, mask_all


def clean_plate(plate, ops):
    """Quita del fondo los micrófonos y brazos que traía la imagen generada (quedaban DETRÁS de las personas y, en los
    primeros planos, parecían salirles de la cabeza; prueba real 51883d1c). Cada operación delimita una caja; la máscara
    son los píxeles oscuros de la caja (o un polígono) y se rellena según la pared:
      - dx/dy: copia desplazada un número entero de paneles (paredes con módulos repetidos);
      - vfill: interpolación vertical por columna con el grano de la pared (pilares, tela lisa);
      - inpaint: para elementos finos sobre superficies lisas.
    Con «poly» la máscara es el polígono entero (no solo lo oscuro).
    Las operaciones se aplican en orden sobre la imagen ya limpiada (una copia puede tomar de una zona limpiada antes)."""
    for c in ops:
        x0, y0, x1, y1 = c["box"]
        gray = cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY)
        roi = gray[y0:y1, x0:x1]
        sel = roi < c.get("dark", 40)
        if c.get("keepgreen"):  # las plantas no son micrófonos
            hsv = cv2.cvtColor(plate, cv2.COLOR_BGR2HSV)[y0:y1, x0:x1]
            sel &= ~((hsv[..., 0] > 28) & (hsv[..., 0] < 90) & (hsv[..., 1] > 50) & (roi > 35))
        m = np.zeros((H, W), np.uint8)
        if c.get("poly"):  # objeto con contorno conocido (base de un micrófono sobre la mesa): todo el polígono
            cv2.fillPoly(m, [np.int32(c["poly"])], 255)
        else:
            m[y0:y1, x0:x1] = sel.astype(np.uint8) * 255
        m = cv2.dilate(m, np.ones((7, 7), np.uint8), iterations=c.get("grow", 2))
        m[:y0] = 0; m[y1:] = 0; m[:, :x0] = 0; m[:, x1:] = 0
        if c.get("inpaint"):
            plate = cv2.inpaint(plate, m, 7, cv2.INPAINT_TELEA)
            continue
        if c.get("vfill"):
            f = plate.astype(np.float32)
            b0, b1 = c["vfill"]
            band = f[b0:b1, x0:x1]
            grain = band - cv2.blur(band, (9, 9))
            for x in range(x0, x1):
                ys = np.where(m[:, x] > 0)[0]
                if not len(ys): continue
                for r in np.split(ys, np.where(np.diff(ys) > 1)[0] + 1):
                    a, b = r[0] - 1, min(r[-1] + 1, H - 1)
                    t = ((r - a) / max(1, b - a))[:, None]
                    f[r, x] = f[a, x] * (1 - t) + f[b, x] * t + grain[(r - a) % len(grain), x - x0]
            plate = np.clip(f, 0, 255).astype(np.uint8)
            continue
        src = np.roll(plate, (-c.get("dy", 0), -c["dx"]), axis=(0, 1))
        a = cv2.GaussianBlur(m, (0, 0), 2).astype(np.float32)[..., None] / 255
        plate = (src * a + plate * (1 - a)).astype(np.uint8)
    return plate


def seat_mics(st):
    """Un micrófono por asiento (sustituye a los dos micrófonos «props» del centro de la mesa, que apuntaban hacia fuera
    y en los primeros planos quedaban lejos de la boca). El recorte del micrófono apunta arriba a la derecha: el de B se
    usa tal cual, a su lado interior; el de A, reflejado. La cabeza queda hacia el lado interior (offset × alto de cara) y
    la base apoyada en la mesa (base_y), así que el micrófono nunca flota ni se hunde aunque cambie el asiento."""
    m = st["mics"]
    hx = m["head"][0]
    x, y, w, h = cv2.boundingRect(np.int32(m["poly"]))
    s = m["scale"]
    out = []
    for key, flip in (("A", True), ("B", False)):
        seat = st["seats"][key]
        tx = seat["x"] + (m["offset"] if flip else -m["offset"]) * seat["faceH"]
        lx = (x + w - hx) if flip else (hx - x)
        out.append({"from": m["from"], "poly": m["poly"], "scale": s, "flip": flip,
                    "at": [int(round(tx - lx * s)), int(round(m["base_y"] - h * s))]})
    return out


def poly_mask(polys, feather=1.2):
    m = np.zeros((H, W), np.uint8)
    for p in polys:
        cv2.fillPoly(m, [np.int32(p)], 255)
    return cv2.GaussianBlur(m, (0, 0), feather) if feather else m


def main():
    cfg_path, src_dir, out_dir = sys.argv[1:4]
    font = sys.argv[sys.argv.index("--fuente") + 1] if "--fuente" in sys.argv else "/usr/share/fonts/opentype/inter/Inter-Medium.otf"
    cfg = json.load(open(cfg_path))
    os.makedirs(out_dir, exist_ok=True)
    for st in cfg["studios"]:
        src = cv2.imread(os.path.join(src_dir, st["source"]), cv2.IMREAD_COLOR)
        plate = cv2.resize(src, (W, H), interpolation=cv2.INTER_LANCZOS4)
        for r in st.get("inpaint", []):  # objetos que sobran en la imagen generada (p. ej. un letrero con texto inventado)
            m = poly_mask([r], 0)
            plate = cv2.inpaint(plate, m, 9, cv2.INPAINT_TELEA)
        if st.get("clean"):
            plate = clean_plate(plate, st["clean"])
        extra_fg = np.zeros((H, W), np.uint8)
        if st.get("desk"):
            plate, dm = build_desk(plate, st["desk"])
            extra_fg = np.maximum(extra_fg, dm)
        props = st.get("props", []) + (seat_mics(st) if st.get("mics") else [])
        if props:
            props = [{**p, "from": os.path.join(src_dir, p["from"])} for p in props]
            plate, pm = paste_props(plate, None, props)
            extra_fg = np.maximum(extra_fg, pm)
        sg = st["sign"]
        sign = neon_sign(int(sg["quad"][1][0] - sg["quad"][0][0]) * 2, hex_rgb(cfg["brandColor"]), font)
        rgb = cv2.cvtColor(plate, cv2.COLOR_BGR2RGB)
        sign_rgba = np.dstack([sign[..., :3], sign[..., 3]])
        rgb = warp_into(rgb, sign_rgba, sg["quad"], hex_rgb(cfg["brandColor"]), sg.get("spill", 0.35))
        Image.fromarray(rgb).save(os.path.join(out_dir, f"{st['id']}.jpg"), quality=92)
        fg = np.maximum(poly_mask(st.get("foreground", [])), extra_fg)
        front = rgb.copy(); front[fg == 0] = 0  # fuera de la mesa no hace falta color (PNG mucho más ligero)
        Image.fromarray(np.dstack([front, fg])).save(os.path.join(out_dir, f"{st['id']}-frente.png"), optimize=True)
        Image.fromarray(rgb).resize((480, 270), Image.LANCZOS).save(os.path.join(out_dir, f"{st['id']}-mini.jpg"), quality=88)
        print(json.dumps({"studio": st["id"], "ok": True}))


if __name__ == "__main__":
    main()

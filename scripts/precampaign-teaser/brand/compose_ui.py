"""Composes the ATOMIVID interface segments of the teaser from REAL interface captures (local, USD 0).

Inputs (from ui_capture.mjs / brand_render.mjs / the public production site):
  uicap/   element screenshots of the deployed code's own components (3x), meta.json
  brand/   end-card frames, header lockup, "Hecho con Atomivid" badge (real Logo.tsx SVG, globals.css tokens, Geist)
  landing  full-page screenshot of the PRODUCTION landing (https://atomivid.vercel.app, mobile 390x844 @3x)
Outputs (1080x1920, 30 fps, silent, H.264) + JSON timing:
  ui-idea.mp4    "Tú le das una idea… y empieza la producción": selector → YouTube/Documental → title typed → Confirmar
  ui-demo.mp4    "Guion. Voz. Imágenes. Movimiento. Música. Subtítulos. Todo…": real progress cards on the words,
                 then the dedicated 16:9 result whose player rect (ui-demo.json) the master fills with real DULCE footage
  ui-reveal.mp4  "…el video que estás viendo también fue creado con ATOMIVID": the production landing in a phone
  end-card.mp4   official close: logo mark + Atomivid + "Tu idea. Tu video." + "Próximamente."
usage: compose_ui.py <uicap> <brand> <landing.png> <outdir> <timing.json>
timing.json (seconds, relative to each section; from the persisted TTS word timings):
  {"idea": {"start": 1.12, "press": 1.74, "duration": 2.72}, "demo": {"voz":0.51,"imagenes":0.92,"musica":2.32,"todo":3.74,"duration":5.97},
   "reveal": {"creado": 3.36, "duration": 5.10}}
"""
import json, os, subprocess, sys
import numpy as np
import cv2

W, H, FPS = 1080, 1920, 30
CANVAS = np.array([12, 8, 8], np.float32) / 255          # #08080c (BGR)
ACCENT = np.array([239, 106, 124], np.float32) / 255     # #7c6aef (BGR)


def ease(x):
    x = float(np.clip(x, 0, 1))
    return x * x * (3 - 2 * x)


def background():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    bg = np.ones((H, W, 3), np.float32) * CANVAS
    g1 = np.exp(-(((xx - 540) / 620) ** 2 + ((yy - 380) / 520) ** 2))[..., None] * ACCENT * 0.26
    g2 = np.exp(-(((xx - 930) / 520) ** 2 + ((yy - 1780) / 420) ** 2))[..., None] * np.array([160, 70, 40], np.float32) / 255 * 0.22
    return np.clip(bg + g1 + g2, 0, 1)


def load(path, alpha=False):
    im = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit(f"missing {path}")
    if im.shape[2] == 3:
        im = np.dstack([im, np.full(im.shape[:2], 255, np.uint8)])
    return im.astype(np.float32) / 255


def rounded_mask(h, w, r):
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (r, 0), (w - r, h), 255, -1)
    cv2.rectangle(m, (0, r), (w, h - r), 255, -1)
    for cx, cy in ((r, r), (w - r, r), (r, h - r), (w - r, h - r)):
        cv2.circle(m, (cx, cy), r, 255, -1, cv2.LINE_AA)
    return m.astype(np.float32) / 255


def place(frame, rgba, x, y, scale=1.0, alpha=1.0, shadow=True):
    """Alpha-composite rgba (float 0..1) at (x, y) top-left after scaling; soft shadow under cards."""
    if scale != 1.0:
        rgba = cv2.resize(rgba, (max(1, int(rgba.shape[1] * scale)), max(1, int(rgba.shape[0] * scale))), interpolation=cv2.INTER_AREA)
    h, w = rgba.shape[:2]
    x, y = int(round(x)), int(round(y))
    if shadow:
        sh = np.zeros((H, W), np.float32)
        y0, y1, x0, x1 = max(0, y + 24), min(H, y + 24 + h), max(0, x), min(W, x + w)
        if y1 > y0 and x1 > x0:
            sh[y0:y1, x0:x1] = 0.55 * alpha
            sh = cv2.GaussianBlur(sh, (0, 0), 28)
            frame *= (1 - sh[..., None])
    fy0, fy1, fx0, fx1 = max(0, y), min(H, y + h), max(0, x), min(W, x + w)
    if fy1 <= fy0 or fx1 <= fx0:
        return frame
    src = rgba[fy0 - y: fy1 - y, fx0 - x: fx1 - x]
    a = src[..., 3:] * alpha
    frame[fy0:fy1, fx0:fx1] = src[..., :3] * a + frame[fy0:fy1, fx0:fx1] * (1 - a)
    return frame


def card(path, crop=None):
    im = load(path)
    if crop:
        im = im[crop[0]:crop[1]]
    m = rounded_mask(im.shape[0], im.shape[1], 54)
    im[..., 3] *= m
    return im


def ripple(frame, cx, cy, t):
    """Tap feedback: accent ring expanding + fading (t in 0..1)."""
    if not 0 <= t <= 1:
        return frame
    r = 30 + 120 * ease(t)
    a = (1 - t) * 0.75
    ov = frame.copy()
    cv2.circle(ov, (int(cx), int(cy)), int(r), (1.0, 1.0, 1.0), -1, cv2.LINE_AA)
    frame = frame * (1 - 0.18 * a) + ov * 0.18 * a
    cv2.circle(frame, (int(cx), int(cy)), int(r), tuple(float(c) for c in ACCENT), 6, cv2.LINE_AA)
    return frame


class Writer:
    def __init__(self, path):
        self.p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                   "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path], stdin=subprocess.PIPE)

    def put(self, f):
        self.p.stdin.write((np.clip(f, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def main():
    uicap, brand, landing, out, timing_path = sys.argv[1:6]
    os.makedirs(out, exist_ok=True)
    T = json.load(open(timing_path))
    meta = json.load(open(os.path.join(uicap, "meta.json")))
    BG = background()
    lock = load(os.path.join(brand, "lockup.png"))
    CW = 960
    S = CW / 1074  # card scale for 1074-wide captures
    X0 = (W - CW) / 2

    def base(alpha=1.0):
        f = BG.copy()
        return place(f, lock, (W - lock.shape[1] * 0.62) / 2, 150, 0.62, alpha, shadow=False)

    # ---------------- ui-idea ----------------
    sel, sel_h = card(os.path.join(uicap, "selector.png")), card(os.path.join(uicap, "selector-hover.png"))
    titles = [card(os.path.join(uicap, f"title-{i:03d}.png"), (300, 1180)) for i in range(meta["titleFrames"])]
    conf, conf_h = card(os.path.join(uicap, "confirm.png")), card(os.path.join(uicap, "confirm-hover.png"))
    queued = card(os.path.join(uicap, "stage-queued.png"))
    st = meta["selectorTarget"]
    sS = 700 / sel.shape[1]  # selector card kept above the caption band (y >= 1270)
    SX = (W - 700) / 2
    I = T["idea"]
    d_idea = I["duration"]
    t_tap, t_title, t_type0, t_type1 = 0.42, 0.72, 0.86, I["press"] - 0.22
    t_press, t_out = I["press"], I["press"] + 0.32
    w = Writer(os.path.join(out, "ui-idea.mp4"))
    for i in range(int(round(d_idea * FPS))):
        t = i / FPS
        f = base(ease(t / 0.2))
        ty = 300
        if t < t_title + 0.12:
            k = ease(t / 0.22)
            a_sel = 1 - ease((t - t_title) / 0.12)
            img = sel_h if t >= t_tap else sel
            f = place(f, img, SX, 270 + 40 * (1 - k), sS, k * a_sel)
            f = ripple(f, SX + (st["x"] + st["w"] / 2) * sS, 270 + (st["y"] + st["h"] / 2) * sS, (t - t_tap) / 0.35)
        if t >= t_title:
            k = ease((t - t_title) / 0.16)
            n = int(np.clip((t - t_type0) / (t_type1 - t_type0), 0, 1) * (len(titles) - 1)) if t >= t_type0 else 0
            a_t = 1 - ease((t - t_out) / 0.18) if t >= t_out else 1
            f = place(f, titles[n], X0, ty + 30 * (1 - k), S, k * a_t)
            cy = ty + titles[0].shape[0] * S + 36
            img = conf_h if t >= t_press - 0.12 else conf
            f = place(f, img, X0, cy + 30 * (1 - k), S, k * a_t)
            f = ripple(f, W / 2, cy + conf.shape[0] * S / 2, (t - t_press) / 0.35)
        if t >= t_out:
            k = ease((t - t_out) / 0.2)
            f = place(f, queued, X0, ty + 30 * (1 - k), S, k)
        w.put(f)
    w.close()

    # ---------------- ui-demo ----------------
    D = T["demo"]
    cards = [(0.0, card(os.path.join(uicap, "stage-queued.png"))),
             (D["voz"], card(os.path.join(uicap, "stage-narrating.png"))),
             (D["imagenes"], card(os.path.join(uicap, "stage-scenes.png"))),
             (D["musica"], card(os.path.join(uicap, "stage-render.png")))]
    res = card(os.path.join(uicap, "result.png"), (0, 1040))
    rS = CW / res.shape[1]
    rp = meta["resultPlayer"]
    res_y = 250
    player = {"x": int(round(X0 + rp["x"] * rS)), "y": int(round(res_y + rp["y"] * rS)), "w": int(round(rp["w"] * rS)), "h": int(round(rp["h"] * rS))}
    w = Writer(os.path.join(out, "ui-demo.mp4"))
    for i in range(int(round(D["duration"] * FPS))):
        t = i / FPS
        f = base()
        if t < D["todo"] + 0.14:
            cur = [c for c in cards if c[0] <= t][-1]
            prev = [c for c in cards if c[0] < cur[0]]
            k = ease((t - cur[0]) / 0.14) if cur[0] > 0 else 1.0
            a_all = 1 - ease((t - D["todo"]) / 0.14) if t >= D["todo"] else 1
            if prev and k < 1:
                f = place(f, prev[-1][1], X0, 300, S, (1 - k) * a_all)
            f = place(f, cur[1], X0, 300 + 26 * (1 - k), S, k * a_all)
        if t >= D["todo"]:
            k = ease((t - D["todo"]) / 0.16)
            f = place(f, res, X0, res_y + 30 * (1 - k), rS, k)
        w.put(f)
    w.close()
    json.dump({"player": player, "playerFrom": D["todo"] + 0.16, "duration": D["duration"]}, open(os.path.join(out, "ui-demo.json"), "w"), indent=2)

    # ---------------- ui-reveal ----------------
    R = T["reveal"]
    land = cv2.imread(landing).astype(np.float32) / 255
    SW = 700
    ls = SW / land.shape[1]
    land = cv2.resize(land, (SW, int(land.shape[0] * ls)), interpolation=cv2.INTER_AREA)
    SH = int(844 * 3 * ls)
    PX, PY, BZ = (W - SW) // 2, 250, 20
    frame_mask = rounded_mask(SH + 2 * BZ, SW + 2 * BZ, 86)
    screen_mask = rounded_mask(SH, SW, 68)
    badge = load(os.path.join(brand, "badge.png"))
    scroll_to = min(land.shape[0] - SH, int(1000 * 3 * ls))  # ends on "Un proceso, seis pasos automáticos"
    w = Writer(os.path.join(out, "ui-reveal.mp4"))
    for i in range(int(round(R["duration"] * FPS))):
        t = i / FPS
        f = BG.copy()
        k = ease(t / 0.45)
        y = PY + 60 * (1 - k)
        sy = int(scroll_to * ease((t - 0.7) / 2.4))
        scr = land[sy: sy + SH]
        bez = np.zeros((SH + 2 * BZ, SW + 2 * BZ, 4), np.float32)
        bez[..., :3] = np.array([34, 26, 26], np.float32) / 255
        bez[..., 3] = frame_mask
        bez[BZ:BZ + SH, BZ:BZ + SW, :3] = scr * screen_mask[..., None] + bez[BZ:BZ + SH, BZ:BZ + SW, :3] * (1 - screen_mask[..., None])
        glow = np.zeros((H, W), np.float32)
        cv2.rectangle(glow, (PX, int(y)), (PX + SW, int(y) + SH), 1.0, -1)
        glow = cv2.GaussianBlur(glow, (0, 0), 60)[..., None] * ACCENT * 0.35 * k
        f = np.clip(f + glow, 0, 1)
        f = place(f, bez, PX - BZ, y - BZ, 1.0, k)
        if t >= R["creado"] - 0.05:
            kb = ease((t - R["creado"] + 0.05) / 0.25)
            f = place(f, badge, (W - badge.shape[1] * 0.9) / 2, 120 - 20 * (1 - kb), 0.9, kb, shadow=False)
        w.put(f)
    w.close()

    # ---------------- end card ----------------
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(brand, "end", "%03d.png"),
                    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", os.path.join(out, "end-card.mp4")], check=True)
    print(json.dumps({"player": player}))


if __name__ == "__main__":
    main()

"""ATOMIVID VFX-002 — subject-locked compositing (local, USD 0).

HANS ORIGINAL PIXELS + SUBJECT MATTE (RVM) + NYC PLATE + LOCAL COMPOSITE/RELIGHT. No generative pass
touches the subject: every pixel inside the matte is the source pixel through a fixed per-pixel grade.

Inputs : the exact VFX source (1080x1920, 30 fps, already polished) and the Luma VFX-001 output, used
         ONLY as raw material for a background plate: the generated person is matted out, the plate is
         the temporal median of uncovered pixels and the residual hole is inpainted. The generated person
         never reaches the composite (residual hole lies behind the real subject).
usage  : vfx002.py <rvm.onnx> <source.mp4> <luma.mp4> <outdir>
"""
import json, os, subprocess, sys, time, warnings
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from vfx002_matte import run_rvm, matte_stats  # noqa: E402

warnings.filterwarnings("ignore", message="All-NaN slice")

W, H, FPS = 1080, 1920, 30
REVEAL_START, REVEAL_END = 0.40, 1.90   # seconds into the clip (~1.5 s transformation)
ORIGIN = (540.0, 1180.0)                # reveal grows from behind the subject's chest
FG_GRADE_MAX = 1.0


def read_frames(path, size=(W, H)):
    w, h = size
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=lanczos", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


RELIGHT = (1 - 0.16 * smoothstep(520, 1920, np.arange(H, dtype=np.float32)))[:, None, None]  # key falls off down the body


def fg_grade(x, s):
    """Fixed per-pixel grade on the subject (allowed: grade, never regenerate). x: float BGR in [0,1];
    s in [0,1] ramps it in. Night relight: lower exposure, warmer key, a touch more contrast, and a
    vertical key falloff (face keeps its exposure, torso/hands sit lower like a street-lit key)."""
    gain = np.array([0.965, 0.985, 1.02], np.float32)  # BGR: warmer (less blue, more red)
    y = x * (1 - 0.07 * s)
    y = y * (1 + (gain - 1) * s)
    y = 0.46 + (y - 0.46) * (1 + 0.06 * s)
    y = y * (1 + (RELIGHT - 1) * s)
    return np.clip(y, 0, 1)


def build_plate(luma, fake_a):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    valid = np.stack([cv2.dilate((a > 6).astype(np.uint8), k) == 0 for a in fake_a])
    cnt = valid.sum(0)
    stack = luma.astype(np.float32)
    stack[~valid] = np.nan
    with np.errstate(all="ignore"):
        med = np.nanmedian(stack, axis=0)
    med = np.nan_to_num(med).astype(np.uint8)
    hole = ((cnt < 3) * 255).astype(np.uint8)
    fill = cv2.inpaint(med, hole, 7, cv2.INPAINT_TELEA)
    soft = cv2.GaussianBlur(fill, (0, 0), 18)
    hm = cv2.GaussianBlur(hole.astype(np.float32) / 255, (0, 0), 6)[..., None]
    fill = (fill * (1 - hm) + soft * 0.55 * hm).astype(np.uint8)  # hole sits behind the subject: shadowed, structure-free
    up = cv2.resize(fill, (W, H), interpolation=cv2.INTER_LANCZOS4).astype(np.float32) / 255
    hole_up = cv2.resize(hole, (W, H), interpolation=cv2.INTER_NEAREST)
    return up, hole_up


def grade_plate(p):
    """Premium night look: deeper blacks, cool shadows, warm sodium highlights, bloom, lens DOF."""
    lum = p @ np.array([0.114, 0.587, 0.299], np.float32)
    sh = (1 - smoothstep(0.0, 0.45, lum))[..., None]
    p = p + sh * np.array([0.030, 0.010, -0.018], np.float32) * (1 - lum[..., None])  # teal-ish shadows
    p = np.clip((p - 0.02) * 1.06, 0, 1)
    p = cv2.GaussianBlur(p, (0, 0), 3.2)  # depth of field: subject at ~1 m, street at 10 m+
    lum = p @ np.array([0.114, 0.587, 0.299], np.float32)
    hi = np.clip((lum - 0.55) / 0.45, 0, 1)[..., None] * p
    bloom = cv2.GaussianBlur(hi, (0, 0), 28) * 0.9 + cv2.GaussianBlur(hi, (0, 0), 9) * 0.35
    return np.clip(p + bloom, 0, 1)


def fbm(shape, seed, scales=(6, 12, 24), amps=(1, 0.5, 0.25)):
    rng = np.random.default_rng(seed)
    out = np.zeros(shape, np.float32)
    for s, a in zip(scales, amps):
        g = rng.standard_normal((s * shape[0] // shape[1] + 2, s + 2)).astype(np.float32)
        out += a * cv2.resize(g, (shape[1], shape[0]), interpolation=cv2.INTER_CUBIC)
    return out / sum(amps)


def main():
    model, src_path, luma_path, outdir = sys.argv[1:5]
    os.makedirs(outdir, exist_ok=True)
    t0 = time.time()
    S = read_frames(src_path)
    T = len(S)
    cache = os.environ.get("VFX002_MATTE_CACHE")
    if cache and os.path.exists(cache + ".hans.npy"):
        A, fake_a = np.load(cache + ".hans.npy"), np.load(cache + ".fake.npy")
    else:
        A = run_rvm(model, src_path, 0.25, (W, H))
        fake_a = run_rvm(model, luma_path, 0.375, (720, 1280))
        if cache:
            np.save(cache + ".hans.npy", A); np.save(cache + ".fake.npy", fake_a)
    assert len(A) == T, (len(A), T)
    luma = read_frames(luma_path, (720, 1280))
    print("matting done", round(time.time() - t0, 1), "s", flush=True)

    # --- matte refinement: tiny choke + 1px soften, then motion-adaptive temporal smoothing: alpha is
    # averaged with the previous frame ONLY where the source pixels did not move (kills edge shimmer on
    # static hair/shoulders without lagging hands or the walk toward camera)
    Af = np.empty((T, H, W), np.float32)
    for i in range(T):
        a = np.clip((A[i].astype(np.float32) / 255 - 0.03) / 0.94, 0, 1)
        a = cv2.GaussianBlur(a, (0, 0), 0.8)
        if i > 0:
            ds_ = cv2.GaussianBlur(np.abs(S[i].astype(np.int16) - S[i - 1].astype(np.int16)).max(-1).astype(np.float32), (0, 0), 3)
            w = 0.65 * np.exp(-ds_ / 2.0)
            solid = (a >= 0.995) | (a <= 0.005)  # solid interior / clean background stay as matted
            a = np.where(solid, a, w * Af[i - 1] + (1 - w) * a)
        Af[i] = a

    # --- clean apartment plate (fixed camera): median of uncovered pixels -> edge colour decontamination
    sub = slice(0, T, 3)
    st = S[sub].astype(np.float32)
    cov = Af[sub] > 0.01
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    cov = np.stack([cv2.dilate(c.astype(np.uint8), kd) > 0 for c in cov])
    st[cov] = np.nan
    with np.errstate(all="ignore"):
        apt = np.nanmedian(st, axis=0)
    apt_known = ~np.isnan(apt[..., 0])
    apt = np.nan_to_num(apt) / 255
    del st

    plate_raw, plate_hole = build_plate(luma, fake_a)
    plate = grade_plate(plate_raw)
    cv2.imwrite(os.path.join(outdir, "vfx-002-background-plate.png"), (plate * 255 + 0.5).astype(np.uint8))

    # residual plate hole actually seen behind the subject (for QA)
    seen_hole = np.mean([((plate_hole > 0) & (Af[i] < 0.5)).mean() for i in range(T)])

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    dist = np.hypot(xx - ORIGIN[0], (yy - ORIGIN[1]) * 0.85)
    distn = dist / float(dist.max())
    apt_lum = cv2.GaussianBlur((S[0].astype(np.float32) / 255) @ np.array([0.114, 0.587, 0.299], np.float32), (0, 0), 6)
    # reveal order: outward from behind the subject, shadows of the room first, highlights last; fine organic edge
    field = 0.86 * distn + 0.10 * apt_lum + 0.018 * fbm((H, W), 7, (6, 12, 24), (1, 0.5, 0.25))
    bgpix = Af[0] < 0.05
    lo, hi = np.percentile(field[bgpix], [1, 99.5])
    field = np.clip((field - lo) / (hi - lo), 0, 1).astype(np.float32)  # 0..1 over the visible room
    fog_a = fbm((H // 4, W // 4), 11, (3, 6, 12))
    fog_b = fbm((H // 4, W // 4), 12, (3, 6, 12))
    fog_band = smoothstep(0.30, 0.48, yy / H) * (1 - smoothstep(0.55, 0.75, yy / H))
    dispx, dispy = fbm((H, W), 21) * 14, fbm((H, W), 22) * 14
    rng = np.random.default_rng(5)

    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
                            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart",
                            os.path.join(outdir, "vfx-002-composite.mp4")], stdin=subprocess.PIPE)
    mat = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H // 2}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", os.path.join(outdir, "vfx-002-matte-preview.mp4")], stdin=subprocess.PIPE)

    cmp_ = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{3 * W // 2}x{H // 2}", "-r", str(FPS), "-i", "-",
                             "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", os.path.join(outdir, "vfx-002-source-vs-composite.mp4")], stdin=subprocess.PIPE)
    lock = {"maxAbsDiffInteriorVsGradedSource": 0, "interiorPixels": 0, "maxAbsDiffInteriorVsSourceBeforeGrade": 0}
    ke = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    lw_k = 0.30
    ONLY = {int(x) for x in os.environ.get("VFX002_ONLY", "").split(",") if x}
    for i in range(T):
        if ONLY and i not in ONLY:
            continue
        t = i / FPS
        I = S[i].astype(np.float32) / 255
        a = Af[i][..., None]
        lin = float(np.clip((t - REVEAL_START) / (REVEAL_END - REVEAL_START), 0, 1))
        prog = 0.35 * lin + 0.65 * float(smoothstep(0, 1, lin))         # mild ease, front moves the whole window
        g = smoothstep(REVEAL_START + 0.2, REVEAL_END + 0.4, t) * FG_GRADE_MAX
        r = 0.02 + prog * 1.38                                         # reveal front position in field units
        R = (1 - smoothstep(r - 0.36, r, field))[..., None]            # 1 = NYC revealed
        band = (np.exp(-((field - r + 0.10) / 0.08) ** 2) * (0 < prog < 1)).astype(np.float32)[..., None]
        dim = np.maximum(smoothstep(r + 0.45, r, field), 0.0)[..., None] * (prog > 0)  # room lights fall ahead of the front

        # background: apartment (displaced near the front) -> NYC plate with ambient motion
        disp = band[..., 0] * 0.45 * (1 - smoothstep(0.0, 0.2, Af[i]))
        apt_bg = cv2.remap(I, (xx + dispx * disp).astype(np.float32), (yy + dispy * disp).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        ph = t * 0.35
        fog = (fog_a * np.cos(ph) + fog_b * np.sin(ph))
        fog = cv2.resize(np.roll(fog, int(t * 6), axis=1), (W, H), interpolation=cv2.INTER_CUBIC)
        fog = np.clip(fog * 0.5 + 0.35, 0, 1) * fog_band * 0.07
        flick = 1 + 0.012 * np.sin(t * 7.3) + 0.008 * np.sin(t * 13.1)
        nyc = np.clip(plate * flick + fog[..., None] * np.array([0.55, 0.75, 0.95], np.float32), 0, 1)
        # the street is far behind the subject: no drop shadow on it; only the narrow gaps enclosed by the
        # body (between arms and torso) fall into the subject's own shadow
        occ = cv2.GaussianBlur(Af[i], (0, 0), 40)[..., None]
        nyc = nyc * (1 - 0.6 * smoothstep(0.6, 0.95, occ))
        nyc = nyc + rng.normal(0, 0.012, nyc.shape).astype(np.float32) * (1 - a)  # grain match on plate

        apt_bg = apt_bg * (1 - 0.62 * dim) * (1 - 0.35 * prog)
        bg = apt_bg * (1 - R) + nyc * R
        glow = np.clip(band * np.array([0.30, 0.62, 1.0], np.float32) * 0.32, 0, 1)   # narrow warm light sweep (screen)
        glow = cv2.GaussianBlur(glow, (0, 0), 6)
        bg = 1 - (1 - bg) * (1 - glow * (1 - a))

        # foreground: original pixels; edge band colour-decontaminated against the clean apartment plate
        Fg = I.copy()
        edge = ((Af[i] > 0.02) & (Af[i] < 0.98) & apt_known)[..., None]
        dec = np.clip((I - (1 - a) * apt) / np.maximum(a, 0.05), 0, 1)
        Fg = np.where(edge, dec, Fg)
        Fg_g = fg_grade(Fg, g)
        # light wrap: blurred plate bleeding onto the subject's rim, scaled by the reveal
        rim = np.clip(a - cv2.GaussianBlur(Af[i], (0, 0), 6)[..., None], 0, 1) * 2.2
        wrap = cv2.GaussianBlur(nyc, (0, 0), 14) * rim * lw_k * R
        fgc = np.clip(Fg_g + wrap, 0, 1)

        # composite (the room ahead of the front stays the source room, dimming as the city arrives)
        out = fgc * a + bg * (1 - a)
        if lin <= 0:
            out = I  # before the transformation the clip is the untouched source (no cut, no fade in the master)
        o8 = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
        if ONLY:
            if i in ONLY:
                cv2.imwrite(os.path.join(outdir, f"test-{i:03d}.png"), o8)
            continue
        enc.stdin.write(o8.tobytes())

        inner = cv2.erode((A[i] >= 254).astype(np.uint8), ke) > 0
        ref = (fg_grade(S[i].astype(np.float32) / 255, g) * 255 + 0.5).astype(np.uint8)  # independent of the composite path
        if inner.any():
            lock["interiorPixels"] += int(inner.sum())
            d = np.abs(o8[inner].astype(np.int16) - ref[inner].astype(np.int16)).max()
            d0 = np.abs(o8[inner].astype(np.int16) - S[i][inner].astype(np.int16)).max()
            lock["maxAbsDiffInteriorVsGradedSource"] = max(lock["maxAbsDiffInteriorVsGradedSource"], int(d))
            lock["maxAbsDiffInteriorVsSourceBeforeGrade"] = max(lock["maxAbsDiffInteriorVsSourceBeforeGrade"], int(d0))

        # lock proof: source | composite | |composite - graded source| x20 on the subject (black = identical)
        subj = (A[i] >= 250)[..., None]
        dm = np.clip(np.abs(o8.astype(np.int16) - ref.astype(np.int16)) * 20, 0, 255).astype(np.uint8)
        dm = np.where(subj, dm, np.array([60, 30, 10], np.uint8))
        pan = [cv2.resize(x, (W // 2, H // 2), interpolation=cv2.INTER_AREA) for x in (S[i], o8, dm)]
        for p_, label in zip(pan, ("SOURCE", "VFX-002", "SUBJECT DIFF x20")):
            cv2.putText(p_, label, (18, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
        cmp_.stdin.write(np.hstack(pan).tobytes())

        # matte preview: alpha | subject over checkerboard (half size)
        al = cv2.cvtColor((Af[i] * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        chk = (((xx // 40 + yy // 40) % 2) * 0.35 + 0.35)[..., None]
        cb = ((Fg * a + chk * (1 - a)) * 255).astype(np.uint8)
        mat.stdin.write(np.hstack([cv2.resize(al, (W // 2, H // 2)), cv2.resize(cb, (W // 2, H // 2))]).tobytes())
        if i % 30 == 0:
            print("frame", i, round(time.time() - t0, 1), "s", flush=True)
    enc.stdin.close(); mat.stdin.close(); cmp_.stdin.close(); enc.wait(); mat.wait(); cmp_.wait()

    # matte flicker on STATIC content: alpha change where the source itself did not change
    fl, n, fr_, nr = 0.0, 0, 0.0, 0
    Ar = A.astype(np.float32) / 255
    for i in range(1, T):
        ds_ = cv2.GaussianBlur(np.abs(S[i].astype(np.int16) - S[i - 1].astype(np.int16)).max(-1).astype(np.float32), (0, 0), 2)
        m = (ds_ < 1.5) & (Af[i] > 0.02) & (Af[i] < 0.98)
        if m.any():
            fl += float(np.abs(Af[i] - Af[i - 1])[m].sum()); n += int(m.sum())
            fr_ += float(np.abs(Ar[i] - Ar[i - 1])[m].sum()); nr += int(m.sum())
    report = {
        "matteFlickerStaticEdgeMeanAbs": round(fl / max(n, 1), 4),
        "matteFlickerStaticEdgeMeanAbsRawRvm": round(fr_ / max(nr, 1), 4),
        "method": {
            "segmentation": "Robust Video Matting mobilenetv3 (ONNX, CPU), recurrent temporal state, downsample 0.25; choke 3% + 0.8px soften; motion-adaptive temporal smoothing (static pixels only); no chroma key",
            "edgeDecontamination": "un-premultiply against a clean apartment plate (temporal median of uncovered pixels, fixed camera)",
            "background": "Luma VFX-001 output reused as raw plate only: generated person matted out (RVM), temporal median of uncovered pixels, residual hole Telea-inpainted, lanczos 720->1080, night grade + DOF blur + bloom; ambient motion local (fog drift, light flicker, grain)",
            "transition": f"spatial reveal ordered by distance from the subject + room luminance (shadows first), low-frequency organic edge, {REVEAL_START}-{REVEAL_END}s, warm light-sweep front, local displacement of the apartment at the front",
            "subject": "original source pixels; fixed per-pixel grade ramp (exposure -7%, warmer, contrast +6%); light wrap on rim only",
        },
        "matte": matte_stats(A),
        "fakeMatte": matte_stats(fake_a),
        "plateHoleSeenBehindSubjectFraction": round(float(seen_hole), 5),
        "subjectLock": lock,
        "seconds": round(time.time() - t0, 1),
    }
    json.dump(report, open(os.path.join(outdir, "vfx-002-report.json"), "w"), indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

"""ATOMIVID VFX-002 (correction) — subject-locked composite over a REAL NYC motion plate (local, USD 0).

HANS ORIGINAL PIXELS + VALIDATED SUBJECT MATTE (RVM) + REAL VIDEO PLATE (Times Square at night, stock
footage, locked-off camera) + "AI render scan" transformation in the ATOMIVID accent colour.
No generative pass touches the subject: inside the matte every pixel is the source pixel through a
fixed per-pixel grade.

Transformation: a thin accent-coloured scan line rises behind the subject; just ahead of it the room is
re-drawn as a glowing edge render (the scene being "re-generated"), behind it the real city plays. The
line lights the subject's rim as it passes (light wrap only, no subject distortion).

usage: vfx002b.py <rvm.onnx> <source.mp4> <plate.mp4> <outdir> [plate_start_s]
"""
import json, os, subprocess, sys, time, warnings
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(__file__))
from vfx002_matte import run_rvm, matte_stats  # noqa: E402

warnings.filterwarnings("ignore", message="All-NaN slice")
W, H, FPS = 1080, 1920, 30
SCAN_START, SCAN_END = 0.45, 1.75           # seconds into the clip
ACCENT = np.array([239, 106, 124], np.float32) / 255   # BGR of #7c6aef (ATOMIVID accent)
ACCENT_HI = np.array([255, 205, 214], np.float32) / 255  # BGR of #d6cdff (accent tint for the core)


def read_frames(path, size=(W, H), start=0.0, n=None):
    w, h = size
    args = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", path, "-vf", f"scale={w}:{h}:flags=lanczos,fps={FPS}", "-pix_fmt", "bgr24"]
    if n:
        args += ["-frames:v", str(n)]
    raw = subprocess.run(args + ["-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


RELIGHT = (1 - 0.14 * smoothstep(560, 1920, np.arange(H, dtype=np.float32)))[:, None, None]


def fg_grade(x, s):
    """Fixed per-pixel grade on the subject (grade only, never regenerate). x float BGR [0,1].
    Night relight toward the city: exposure -8%, slightly cooler shadows, +5% contrast, key falloff."""
    y = x * (1 - 0.08 * s)
    lum = y @ np.array([0.114, 0.587, 0.299], np.float32)
    cool = (1 - smoothstep(0.0, 0.5, lum))[..., None] * np.array([0.018, 0.004, -0.010], np.float32)
    y = y + cool * s
    y = 0.45 + (y - 0.45) * (1 + 0.05 * s)
    y = y * (1 + (RELIGHT - 1) * s)
    return np.clip(y, 0, 1)


def grade_plate(p):
    """Integrate a real 4K night plate behind a ~1 m subject: light lens DOF (not a mush), deeper blacks,
    highlight bloom from the screens, a touch less saturation so the subject stays the hero."""
    p = cv2.GaussianBlur(p, (0, 0), 1.6)
    lum = p @ np.array([0.114, 0.587, 0.299], np.float32)
    p = lum[..., None] + (p - lum[..., None]) * 0.9
    p = np.clip((p - 0.015) * 1.04, 0, 1)
    hi = np.clip((lum - 0.6) / 0.4, 0, 1)[..., None] * p
    p = p + cv2.GaussianBlur(hi, (0, 0), 22) * 0.45
    return np.clip(p, 0, 1)


def main():
    model, src_path, plate_path, outdir = sys.argv[1:5]
    plate_start = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
    os.makedirs(outdir, exist_ok=True)
    t0 = time.time()
    S = read_frames(src_path)
    T = len(S)
    cache = os.environ.get("VFX002_MATTE_CACHE")
    if cache and os.path.exists(cache + ".hans.npy"):
        A = np.load(cache + ".hans.npy")
    else:
        A = run_rvm(model, src_path, 0.4, (W, H))  # 0.4: smoother edges on motion-blurred shoulders than 0.25
        if cache:
            np.save(cache + ".hans.npy", A)
    assert len(A) == T, (len(A), T)
    P = read_frames(plate_path, (W, H), plate_start, T)
    if len(P) < T:
        raise SystemExit(f"plate too short: {len(P)} < {T} frames")

    # matte refinement (validated in VFX-002): choke + soften + motion-adaptive temporal smoothing on edges
    Af = np.empty((T, H, W), np.float32)
    for i in range(T):
        a = np.clip((A[i].astype(np.float32) / 255 - 0.03) / 0.94, 0, 1)
        a = cv2.GaussianBlur(a, (0, 0), 0.8)
        if i > 0:
            ds_ = cv2.GaussianBlur(np.abs(S[i].astype(np.int16) - S[i - 1].astype(np.int16)).max(-1).astype(np.float32), (0, 0), 3)
            w = 0.65 * np.exp(-ds_ / 2.0)
            solid = (a >= 0.995) | (a <= 0.005)
            a = np.where(solid, a, w * Af[i - 1] + (1 - w) * a)
        Af[i] = a

    # clean apartment plate (fixed camera) for edge decontamination + the edge render of the room
    st = S[::3].astype(np.float32)
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    cov = np.stack([cv2.dilate((c > 2).astype(np.uint8), kd) > 0 for c in A[::3]])
    seen_count = (~cov).sum(0)  # how many sampled frames show the empty room at each pixel
    st[cov] = np.nan
    apt = np.nanmedian(st, axis=0)
    apt_known = ~np.isnan(apt[..., 0])
    # pixels never uncovered (always behind the subject): inpaint the room so edge decontamination
    # applies everywhere (otherwise wall colour bleeds into the edge band as a grey smudge)
    apt = cv2.inpaint(np.nan_to_num(apt).astype(np.uint8), (~apt_known).astype(np.uint8) * 255, 9, cv2.INPAINT_TELEA).astype(np.float32) / 255
    # trust the empty-room plate only where the room was seen uncovered often enough (otherwise the median
    # can be contaminated by motion-blurred hair/edges and the refinement would cut real subject detail)
    apt_seen = apt_known & (seen_count >= 8)
    apt_known[:] = True
    del st
    # clean-plate difference refinement, edge band only: where the source pixel equals the empty room,
    # partial alpha is a matte error (static objects behind motion-blurred edges) -> push to background
    for i in range(T):
        band = (Af[i] > 0.02) & (Af[i] < 0.7) & apt_seen
        if band.any():
            d = cv2.GaussianBlur(np.abs(S[i].astype(np.float32) / 255 - apt).max(-1), (0, 0), 1.0)
            ref_ = Af[i] * smoothstep(0.035, 0.11, d)
            Af[i] = np.where(band, cv2.GaussianBlur(ref_, (0, 0), 0.6), Af[i])  # anti-alias the refined edge
    g_apt = cv2.cvtColor((apt * 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx, gy = cv2.Sobel(g_apt, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g_apt, cv2.CV_32F, 0, 1, ksize=3)
    edges = np.clip(np.hypot(gx, gy) / 90, 0, 1)
    edges = np.maximum(edges, cv2.GaussianBlur(edges, (0, 0), 2.5) * 0.8)[..., None]

    yy = np.arange(H, dtype=np.float32)[:, None]
    rng = np.random.default_rng(5)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
                            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart",
                            os.path.join(outdir, "vfx-002-composite.mp4")], stdin=subprocess.PIPE)
    cmp_ = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{3 * W // 2}x{H // 2}", "-r", str(FPS), "-i", "-",
                             "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", os.path.join(outdir, "vfx-002-source-vs-composite.mp4")], stdin=subprocess.PIPE)
    mat = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H // 2}", "-r", str(FPS), "-i", "-",
                            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", os.path.join(outdir, "vfx-002-matte-preview.mp4")], stdin=subprocess.PIPE)
    plate_out = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                                  "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", os.path.join(outdir, "vfx-002-background-plate.mp4")], stdin=subprocess.PIPE)
    ONLY = {int(x) for x in os.environ.get("VFX002_ONLY", "").split(",") if x}
    lock = {"maxAbsDiffInteriorVsGradedSource": 0, "interiorPixels": 0, "maxAbsDiffInteriorVsSourceBeforeGrade": 0}
    ke = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    xx = np.arange(W)[None, :]
    chk = ((((xx // 40) + (yy.astype(int) // 40)) % 2) * 0.35 + 0.35)[..., None]
    for i in range(T):
        if ONLY and i not in ONLY:
            continue
        t = i / FPS
        I = S[i].astype(np.float32) / 255
        a = Af[i][..., None]
        lin = float(np.clip((t - SCAN_START) / (SCAN_END - SCAN_START), 0, 1))
        prog = float(smoothstep(0, 1, lin))
        g = float(smoothstep(SCAN_START + 0.3, SCAN_END + 0.3, t))
        ys = 1450 - prog * (1450 + 160)                       # scan line rises from the hands to above the frame
        R = (smoothstep(ys - 6, ys + 26, yy))[..., None]        # 1 below the line = NYC
        ahead = np.exp(-np.clip(ys - yy, 0, None) / 260.0) * (yy < ys)   # edge-render band above the line
        ahead = (ahead * (0 < lin < 1))[..., None].astype(np.float32)
        core = (np.exp(-((yy - ys) / 3.0) ** 2) * (0 < lin < 1))[..., None].astype(np.float32)
        halo = (np.exp(-((yy - ys) / 38.0) ** 2) * (0 < lin < 1))[..., None].astype(np.float32)

        nyc = grade_plate(P[i].astype(np.float32) / 255)
        nyc = nyc * (1 + 0.7 * (np.exp(-np.clip(yy - ys, 0, None) / 110.0) * (yy >= ys) * (0 < lin < 1))[..., None])  # city switches on behind the line
        nyc = np.clip(nyc + rng.normal(0, 0.010, nyc.shape).astype(np.float32), 0, 1)
        room = I * (1 - 0.8 * ahead) * (1 - 0.25 * prog) + edges * ACCENT * np.clip(ahead * 1.6, 0, 1) * 1.15  # room re-drawn as glowing edges
        bg = room * (1 - R) + nyc * R
        light = np.clip(core * ACCENT_HI * 1.0 + halo * ACCENT * 0.55, 0, 1)
        bg = 1 - (1 - bg) * (1 - light)                                     # screen blend

        Fg = I.copy()
        edge = ((Af[i] > 0.02) & (Af[i] < 0.98) & apt_known)[..., None]
        Fg = np.where(edge, np.clip((I - (1 - a) * apt) / np.maximum(a, 0.05), 0, 1), Fg)
        Fg_g = fg_grade(Fg, g)
        rim = np.clip(a - cv2.GaussianBlur(Af[i], (0, 0), 6)[..., None], 0, 1) * 2.2
        wrap_src = nyc * R + light
        wrap = cv2.GaussianBlur(wrap_src, (0, 0), 12) * rim * 0.22
        fgc = np.clip(Fg_g + wrap, 0, 1)
        out = fgc * a + bg * (1 - a)
        if lin <= 0:
            out = I  # before the transformation the clip is the untouched source
        o8 = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
        if ONLY:
            cv2.imwrite(os.path.join(outdir, f"test-{i:03d}.png"), o8)
            continue
        enc.stdin.write(o8.tobytes())
        plate_out.stdin.write((nyc * 255 + 0.5).astype(np.uint8).tobytes())

        ref = (fg_grade(S[i].astype(np.float32) / 255, g) * 255 + 0.5).astype(np.uint8)
        if lin <= 0:
            ref = S[i]
        inner = cv2.erode((A[i] >= 254).astype(np.uint8), ke) > 0
        if inner.any():
            lock["interiorPixels"] += int(inner.sum())
            lock["maxAbsDiffInteriorVsGradedSource"] = max(lock["maxAbsDiffInteriorVsGradedSource"], int(np.abs(o8[inner].astype(np.int16) - ref[inner].astype(np.int16)).max()))
            lock["maxAbsDiffInteriorVsSourceBeforeGrade"] = max(lock["maxAbsDiffInteriorVsSourceBeforeGrade"], int(np.abs(o8[inner].astype(np.int16) - S[i][inner].astype(np.int16)).max()))
        subj = (A[i] >= 250)[..., None]
        dm = np.where(subj, np.clip(np.abs(o8.astype(np.int16) - ref.astype(np.int16)) * 20, 0, 255).astype(np.uint8), np.array([60, 30, 10], np.uint8))
        pan = [cv2.resize(x, (W // 2, H // 2), interpolation=cv2.INTER_AREA) for x in (S[i], o8, dm)]
        for p_, label in zip(pan, ("SOURCE", "VFX-002", "SUBJECT DIFF x20")):
            cv2.putText(p_, label, (18, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
        cmp_.stdin.write(np.hstack(pan).tobytes())
        al = cv2.cvtColor((Af[i] * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        cb = ((Fg * a + chk * (1 - a)) * 255).astype(np.uint8)
        mat.stdin.write(np.hstack([cv2.resize(al, (W // 2, H // 2)), cv2.resize(cb, (W // 2, H // 2))]).tobytes())
        if i % 30 == 0:
            print("frame", i, round(time.time() - t0, 1), "s", flush=True)
    for p_ in (enc, cmp_, mat, plate_out):
        p_.stdin.close()
        p_.wait()
    if ONLY:
        return

    fl, n, fr_, nr = 0.0, 0, 0.0, 0
    Ar = A.astype(np.float32) / 255
    for i in range(1, T):
        ds_ = cv2.GaussianBlur(np.abs(S[i].astype(np.int16) - S[i - 1].astype(np.int16)).max(-1).astype(np.float32), (0, 0), 2)
        m = (ds_ < 1.5) & (Af[i] > 0.02) & (Af[i] < 0.98)
        if m.any():
            fl += float(np.abs(Af[i] - Af[i - 1])[m].sum()); n += int(m.sum())
            fr_ += float(np.abs(Ar[i] - Ar[i - 1])[m].sum()); nr += int(m.sum())
    pm = [float(np.abs(P[i].astype(np.int16) - P[i - 1].astype(np.int16)).mean()) for i in range(1, T)]
    report = {
        "matteFlickerStaticEdgeMeanAbs": round(fl / max(n, 1), 4),
        "matteFlickerStaticEdgeMeanAbsRawRvm": round(fr_ / max(nr, 1), 4),
        "plateMotionMeanAbsFrameDiff": round(float(np.mean(pm)), 2),
        "method": {
            "segmentation": "Robust Video Matting mobilenetv3 (ONNX, CPU), recurrent, downsample 0.4; choke + soften + motion-adaptive temporal smoothing on edges; no chroma key",
            "edgeDecontamination": "un-premultiply against a clean apartment plate (temporal median, fixed camera); conservative clean-plate difference refinement only where alpha < 0.7 and the room was seen uncovered in >= 8 sampled frames",
            "background": "real stock video plate (locked-off camera), Times Square at night, native 2160x3840 downscaled to 1080x1920; light DOF (sigma 1.6), slight desaturation, screen bloom, grain",
            "transition": f"AI render scan {SCAN_START}-{SCAN_END}s: accent (#7c6aef) scan line rising behind the subject, room re-drawn as glowing edges ahead of it, real city behind it",
            "subject": "original source pixels; fixed per-pixel grade ramp (exposure -8%, cooler shadows, contrast +5%, key falloff); light wrap on the rim only",
        },
        "matte": matte_stats(A),
        "subjectLock": lock,
        "seconds": round(time.time() - t0, 1),
    }
    json.dump(report, open(os.path.join(outdir, "vfx-002-report.json"), "w"), indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

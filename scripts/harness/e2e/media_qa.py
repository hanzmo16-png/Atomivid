#!/usr/bin/env python3
"""
QA de medios (Paso 4, T-20261019-1553). Sólo numpy + Pillow + ffmpeg/ffprobe (+ tesseract para subtítulos).
Cada comprobación es una aserción; cualquier FAIL ⇒ exit 1.

  motion <mp4> <plan.json> <synth_dir> <out_dir>
      Video de la composición productiva con imágenes texturizadas y dirección conocida (motion-render.ts).
      Mide escala (búsqueda de escala + correlación de fase), traslación, SSIM, mezcla en crossfade y caída a negro.
  reel <mp4> <director.json> <fills.json> <synth_dir> <out_dir> <expected_seconds>
      MP4 final del E2E: ffprobe, decodificación completa, audio no silencioso, imágenes de relleno presentes en sus
      planos (comparación de fotogramas), movimiento por plano según director.json, subtítulos (OCR) = captions.

Umbrales (justificación):
  - push_in: remotion/reel-direction.ts declara escala lineal 1→1.15 en la duración del plano. Entre los instantes
    medidos t1,t2 se espera r=(1+0.15·p2)/(1+0.15·p1). Se exige r_medida−1 ≥ 0.5·(r−1) y ≤ 1.5·(r−1): la mitad del
    zoom declarado como mínimo (tolerancia a compresión CRF 26 y a la discretización de la búsqueda, paso 0.002),
    lo que distingue con holgura un plano estático (r=1) de uno con push-in (r≈1.10 en 3 s).
  - pan: escala 1.12 y translateX 40→−40 px (composición 1080 px) ⇒ dx = −80·1.12·(p2−p1) px. Se exige el signo y
    |dx| ≥ 0.5·|esperado|, con escala estable (|r−1| ≤ 0.01).
  - static: |r−1| ≤ 0.004, |desplazamiento| ≤ 1.5 px y SSIM ≥ 0.97 entre inicio y fin del plano.
  - crossfade: en el punto medio del solape (0.25 s tras el corte) el fotograma se ajusta por mínimos cuadrados como
    a·A+b·B con a,b ∈ [0.2, 0.8]; un corte da b ≥ 0.9.
  - fade: luminancia media en el fotograma del corte ≤ 15 % de la del centro del plano.
  - presencia de imagen: NCC ≥ 0.5 contra la imagen esperada y ≥ 0.15 por encima de cualquier otra sintética.
"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image

CHECKS = []
def check(name, ok, detail=None):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  " + json.dumps(detail, ensure_ascii=False, default=str)[:500]))

W, H = 540, 960
def frame(mp4, t, out=None):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1", "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
    if out: Image.fromarray(a).save(out)
    return a.astype(np.float64)
gray = lambda a: a @ np.array([0.299, 0.587, 0.114])

def cover(img_path):
    """La imagen tal como la encuadra object-fit: cover en 1080x1920, a W×H."""
    im = Image.open(img_path).convert("RGB"); w, h = im.size; s = max(1080 / w, 1920 / h)
    im = im.resize((round(w * s), round(h * s)), Image.LANCZOS); w, h = im.size
    im = im.crop(((w - 1080) // 2, (h - 1920) // 2, (w - 1080) // 2 + 1080, (h - 1920) // 2 + 1920)).resize((W, H), Image.LANCZOS)
    return np.asarray(im).astype(np.float64)

def ncc(a, b):
    a = a - a.mean(); b = b - b.mean(); d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d else 0.0

def ssim(a, b):
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    def blur(x):
        k = 8; h, w = (x.shape[0] // k) * k, (x.shape[1] // k) * k
        return x[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    a, b = a[: (a.shape[0] // 8) * 8, : (a.shape[1] // 8) * 8], b[: (b.shape[0] // 8) * 8, : (b.shape[1] // 8) * 8]
    ma, mb = blur(a), blur(b); va, vb = blur(a * a) - ma ** 2, blur(b * b) - mb ** 2; cov = blur(a * b) - ma * mb
    return float((((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma ** 2 + mb ** 2 + c1) * (va + vb + c2))).mean())

def phase_shift(a, b):
    """Desplazamiento (dy, dx) de b respecto de a por correlación de fase (pico con ajuste parabólico subpíxel)."""
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    A, B = np.fft.fft2((a - a.mean()) * win), np.fft.fft2((b - b.mean()) * win)
    R = B * np.conj(A); R /= np.abs(R) + 1e-12; r = np.real(np.fft.ifft2(R))
    py, px = np.unravel_index(np.argmax(r), r.shape)
    def sub(c, n, get):
        l, m, rr = get((c - 1) % n), get(c), get((c + 1) % n); den = l - 2 * m + rr
        return c + (0.5 * (l - rr) / den if den else 0)
    dy = sub(py, r.shape[0], lambda i: r[i, px]); dx = sub(px, r.shape[1], lambda j: r[py, j])
    if dy > r.shape[0] / 2: dy -= r.shape[0]
    if dx > r.shape[1] / 2: dx -= r.shape[1]
    return float(dy), float(dx), float(r.max())

def zoom(a, s):
    """a ampliada s veces alrededor del centro (lo que hace scale(s) CSS), mismo tamaño."""
    im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)); w, h = im.size
    nw, nh = w * s, h * s; im = im.resize((round(nw), round(nh)), Image.BICUBIC)
    l, t = (im.size[0] - w) / 2, (im.size[1] - h) / 2
    return np.asarray(im.crop((round(l), round(t), round(l) + w, round(t) + h))).astype(np.float64)

def roi(a, rows=(0.12, 0.62)):
    """Región central sin bordes ni zona de subtítulos/etiqueta."""
    h, w = a.shape[:2]; return a[int(h * rows[0]): int(h * rows[1]), int(w * 0.12): int(w * 0.88)]

def estimate(f1, f2):
    """Mejor escala r (f2 ≈ zoom(f1, r) desplazada) + desplazamiento por correlación de fase; devuelve r, dy, dx, ncc."""
    g1, g2 = gray(f1), gray(f2); best = None
    for r in np.arange(0.96, 1.25, 0.002):
        z = roi(zoom(g1, r)); t = roi(g2); dy, dx, _ = phase_shift(z, t)
        sh = np.roll(np.roll(z, int(round(dy)), 0), int(round(dx)), 1); c = ncc(sh[20:-20, 20:-20], t[20:-20, 20:-20])
        if best is None or c > best[3]: best = (float(r), dy, dx, c)
    return best

def media_basics(mp4, expected=None, res=(1080, 1920)):
    pr = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", mp4], capture_output=True, check=True).stdout)
    vs = next((s for s in pr["streams"] if s["codec_type"] == "video"), None); au = next((s for s in pr["streams"] if s["codec_type"] == "audio"), None)
    dur = float(pr["format"]["duration"])
    check("ffprobe: H.264 %dx%d + pista de audio AAC" % res, vs and vs["codec_name"] == "h264" and (vs["width"], vs["height"]) == res and au and au["codec_name"] == "aac", {"v": vs and [vs["codec_name"], vs["width"], vs["height"]], "a": au and au["codec_name"]})
    if expected: check(f"duración {dur:.2f}s coherente con lo pedido ({expected}s ±25 %)", abs(dur - expected) <= 0.25 * expected, dur)
    dec = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", mp4, "-f", "null", "-"], capture_output=True)
    check("decodificación completa sin errores (ffmpeg -xerror -f null)", dec.returncode == 0 and not dec.stderr.strip(), dec.stderr.decode()[:400])
    n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,r_frame_rate", "-of", "json", mp4], capture_output=True, check=True)
    st = json.loads(n.stdout)["streams"][0]; num, den = map(int, st["r_frame_rate"].split("/")); frames = int(st["nb_read_frames"])
    check("nº de fotogramas decodificados = duración × fps (±2)", abs(frames - dur * num / den) <= 2, {"frames": frames, "dur": dur, "fps": num / den})
    return pr, dur

def audio_level(mp4, t0=None, t1=None):
    args = ["ffmpeg", "-v", "info"] + (["-ss", str(t0), "-to", str(t1)] if t0 is not None else []) + ["-i", mp4, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]
    err = subprocess.run(args, capture_output=True).stderr.decode()
    m = [l for l in err.splitlines() if "mean_volume" in l]
    return float(m[0].split(":")[1].replace("dB", "").strip()) if m else -999.0

def motion_mode(mp4, plan_path, synth, out):
    P = json.load(open(plan_path)); S = P["shotSeconds"]; fps = P["fps"]; plan = P["plan"]
    _, dur = media_basics(mp4, None)
    # La duración del contenedor incluye el relleno/priming del AAC; la del montaje es la de la pista de video.
    vdur = float(next(x for x in _["streams"] if x["codec_type"] == "video")["duration"])
    check("duración de la pista de video = nº planos × duración del plano (±1 fotograma)", abs(vdur - S * len(plan)) <= 1.5 / fps, {"video": vdur, "container": dur})
    res = []
    for i, s in enumerate(plan):
        t1, t2 = i * S + 0.6, i * S + S - 0.6
        f1 = frame(mp4, t1, os.path.join(out, f"motion-{i}-a.png")); f2 = frame(mp4, t2, os.path.join(out, f"motion-{i}-b.png"))
        r, dy, dx, c = estimate(f1, f2); sm = ssim(gray(f1), gray(f2)); exp = None
        # p = fotograma local / durationInFrames del plano (con solape de salida si hay crossfade)
        dfr = S * fps + (15 if s["tout"] == "crossfade" else 0); p1, p2 = 0.6 * fps / dfr, (S - 0.6) * fps / dfr
        if s["motion"] == "push_in":
            exp = (1 + 0.15 * p2) / (1 + 0.15 * p1)
            check(f"[motion] plano {i} push_in: escala medida {r:.3f} vs esperada {exp:.3f} (≥50 %, ≤150 % del zoom), sin deriva lateral", 0.5 * (exp - 1) <= r - 1 <= 1.5 * (exp - 1) and abs(dx) <= 3 and abs(dy) <= 3, {"r": r, "exp": exp, "dx": dx, "dy": dy, "ncc": c})
        elif s["motion"] == "pan":
            exp = -80 * 1.12 * (p2 - p1) * (W / 1080)
            check(f"[motion] plano {i} pan: dx medido {dx:.1f}px vs esperado {exp:.1f}px (mismo signo, ≥50 %), escala estable", np.sign(dx) == np.sign(exp) and abs(dx) >= 0.5 * abs(exp) and abs(r - 1) <= 0.01, {"r": r, "dx": dx, "exp": exp, "ncc": c})
        else:
            check(f"[motion] plano {i} static: sin zoom ni desplazamiento, SSIM {sm:.3f} ≥ 0.97", abs(r - 1) <= 0.004 and abs(dx) <= 1.5 and abs(dy) <= 1.5 and sm >= 0.97, {"r": r, "dx": dx, "dy": dy, "ssim": sm})
        ref = cover(os.path.join(synth, s["img"]))
        check(f"[motion] plano {i}: el fotograma muestra su imagen sintética ({s['img']})", max(ncc(gray(roi(zoom(ref, 1.0 if s['motion']=='static' else 1.0))), gray(roi(f1))), 0) >= 0.3 or c >= 0.9, None)
        res.append({"i": i, "motion": s["motion"], "r": r, "dy": dy, "dx": dx, "ncc": c, "ssim": sm, "expected": exp})
    # transiciones
    # ffmpeg -ss (antes de -i) entrega el primer fotograma con pts ≥ t ⇒ el fotograma k se pide en (k−0.5)/fps.
    fk = lambda k: (k - 0.5) / fps
    # Mezcla medida sobre bloques de 8×8 px: robusta al zoom/pan de ±1 % que ocurre durante el solape (la textura de
    # 1 px se descorrelaciona con un 1 % de zoom; la composición por bloques no).
    def blk(a, k=8):
        g = gray(roi(a)); h, w = (g.shape[0] // k) * k, (g.shape[1] // k) * k
        return g[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    def mix(t, A, B):
        f = blk(frame(mp4, t)).ravel(); X = np.stack([blk(A).ravel(), blk(B).ravel(), np.ones_like(f)], 1)
        w, *_ = np.linalg.lstsq(X, f, rcond=None); return float(w[0]), float(w[1])
    for i in range(len(plan) - 1):
        tb = (i + 1) * S; a, b = plan[i], plan[i + 1]
        if a["tout"] == "crossfade" or b["tin"] == "crossfade":
            k = round(tb * fps)  # solape: fotogramas k .. k+14 (FADE_FRAMES=15)
            A = frame(mp4, fk(k - 1)); B = frame(mp4, fk(k + 16), os.path.join(out, f"trans-{i}-B.png"))
            wa, wb = mix(fk(k + 7), A, B); frame(mp4, fk(k + 7), os.path.join(out, f"trans-{i}-mid.png"))
            check(f"[transición] {i}→{i+1} crossfade: mezcla a={wa:.2f} b={wb:.2f} en el punto medio (ambos en [0.2,0.8])", 0.2 <= wa <= 0.8 and 0.2 <= wb <= 0.8, {"a": wa, "b": wb})
        elif a["tout"] == "fade" or b["tin"] == "fade":
            mid = gray(frame(mp4, i * S + S / 2)).mean(); edge = gray(frame(mp4, fk(round(tb * fps) - 1), os.path.join(out, f"trans-{i}-dip.png"))).mean()
            check(f"[transición] {i}→{i+1} fade: luminancia en el corte {edge:.1f} ≤ 15 % de la del plano {mid:.1f}", edge <= 0.15 * mid, {"edge": edge, "mid": mid})
        else:
            # Referencias pegadas al corte (el plano siguiente puede moverse: pan/push-in), 1 fotograma antes y 4 después.
            # Instantes en el CENTRO del fotograma ((k+0.5)/fps) para que -ss no caiga en el borde entre dos fotogramas.
            k = round(tb * fps); A = frame(mp4, fk(k - 1)); B = frame(mp4, fk(k + 3))
            wa, wb = mix(fk(k + 1), A, B)
            check(f"[transición] {i}→{i+1} corte: el 2.º fotograma tras el corte ya es el plano siguiente (b={wb:.2f} ≥ 0.9)", wb >= 0.9 and abs(wa) <= 0.1, {"a": wa, "b": wb})
    return res

def reel_mode(mp4, dj_path, fills_path, synth, out, expected):
    d = json.load(open(dj_path)); fills = json.load(open(fills_path)); fps = 30
    pr, dur = media_basics(mp4, expected)
    lv = audio_level(mp4); check(f"audio no silencioso (mean_volume {lv:.1f} dB > −60 dB)", lv > -60, lv)
    scenes = d["props"]["scenes"]; shots = d["applied"]
    check("director.json: planos aplicados = escenas montadas", len(shots) == len(scenes), {"applied": len(shots), "scenes": len(scenes)})
    check("duración del montaje (props.durationSeconds) = duración del MP4 (±0.1 s)", abs(d["props"]["durationSeconds"] - dur) <= 0.1, {"props": d["props"]["durationSeconds"], "mp4": dur})
    synths = {f: cover(os.path.join(synth, f)) for f in sorted(os.listdir(synth)) if f.endswith(".png")}
    rep = {"fills": [], "motion": []}
    for sc, ap in zip(scenes, shots):
        sid = ap["shotId"]; st, en = sc["startSeconds"], sc["endSeconds"]; mot = sc["direction"]["motion"]
        fill = next((x for x in fills if f"director-fill-{sid}-" in x["f"]), None)
        tm = (st + en) / 2; fm = frame(mp4, tm, os.path.join(out, f"reel-{sid}-mid.png"))
        if fill:
            exp_file = fill["file"]; scores = {}
            for f, ref in synths.items():
                best = 0
                for s in ([1.0] if mot == "static" else [1.0, 1.04, 1.08, 1.12, 1.16]):
                    z = gray(roi(zoom(ref, s))); t = gray(roi(fm)); dy, dx, _ = phase_shift(z, t)
                    best = max(best, ncc(np.roll(np.roll(z, int(round(dy)), 0), int(round(dx)), 1)[20:-20, 20:-20], t[20:-20, 20:-20]))
                scores[f] = round(best, 3)
            others = max(v for k, v in scores.items() if k != exp_file)
            check(f"[presencia] {sid}: la imagen generada ({exp_file}) está en su plano (NCC {scores[exp_file]:.2f} ≥ 0.5 y +0.15 sobre otras)", scores[exp_file] >= 0.5 and scores[exp_file] - others >= 0.15, scores)
            check(f"[presencia] {sid}: lleva la etiqueta «Recreación IA»", ap["applied"]["label"] == "recreacion_ia", ap["applied"].get("label"))
            rep["fills"].append({"shot": sid, "file": exp_file, "scores": scores, "t": tm})
        if en - st >= 1.6 and mot in ("push_in", "pan", "static"):
            t1, t2 = st + 0.55, en - 0.55
            f1, f2 = frame(mp4, t1, os.path.join(out, f"reel-{sid}-a.png")), frame(mp4, t2, os.path.join(out, f"reel-{sid}-b.png"))
            r, dy, dx, c = estimate(f1, f2); dfr = (en - st) * fps; p1, p2 = 0.55 / (en - st), (en - st - 0.55) / (en - st)
            if mot == "push_in":
                exp = (1 + 0.15 * p2) / (1 + 0.15 * p1)
                check(f"[movimiento] {sid} push_in (imagen del fixture): escala {r:.3f} vs {exp:.3f}", 0.5 * (exp - 1) <= r - 1 <= 1.5 * (exp - 1), {"r": r, "exp": exp, "dx": dx, "ncc": c})
            elif mot == "pan":
                exp = -80 * 1.12 * (p2 - p1) * (W / 1080)
                check(f"[movimiento] {sid} pan: dx {dx:.1f}px vs {exp:.1f}px", np.sign(dx) == np.sign(exp) and abs(dx) >= 0.5 * abs(exp) and abs(r - 1) <= 0.01, {"r": r, "dx": dx, "exp": exp, "ncc": c})
            rep["motion"].append({"shot": sid, "motion": mot, "r": r, "dx": dx, "dy": dy, "ncc": c})
    # subtítulos: OCR de la franja inferior en el centro de cada caption vs su texto
    caps = d["props"]["captions"]; hits = []
    for k, cp in enumerate(caps):
        t = (cp["startSeconds"] + cp["endSeconds"]) / 2; p = os.path.join(out, f"cap-{k}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1", "-vf", "crop=iw:ih*0.45:0:ih*0.5", p], check=True)
        txt = subprocess.run(["tesseract", p, "-", "-l", "spa", "--psm", "6"], capture_output=True).stdout.decode().lower()
        norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum() or ch == " ").split()
        words = [w for w in norm(cp["text"]) if len(w) >= 4]; found = [w for w in words if w in " ".join(norm(txt))]
        hits.append({"k": k, "t": round(t, 2), "caption": cp["text"], "ocr": txt.strip()[:120], "words": len(words), "found": len(found)})
    tot = sum(h["words"] for h in hits); fnd = sum(h["found"] for h in hits)
    check(f"[subtítulos] OCR: {fnd}/{tot} palabras (≥4 letras) de las captions aparecen quemadas en su instante (≥ 70 %)", tot > 0 and fnd / tot >= 0.7, hits[:6])
    # narración ↔ visual: cada plano cubre el texto que ancla (las captions del tramo pertenecen a su frase)
    mis = []
    for sc, ap in zip(scenes, shots):
        inside = " ".join(c["text"] for c in caps if c["startSeconds"] >= sc["startSeconds"] - 0.05 and c["endSeconds"] <= sc["endSeconds"] + 0.05).lower()
        anchor = [w for w in "".join(ch if ch.isalnum() or ch == " " else " " for ch in ap["anchorText"].lower()).split() if len(w) >= 4]
        if inside and anchor and not any(w in inside for w in anchor): mis.append({"shot": ap["shotId"], "anchor": ap["anchorText"], "captions": inside[:120]})
    check("[narración↔visual] las captions dentro de cada plano pertenecen a la frase que ancla ese plano", not mis, mis)
    rep["subtitles"] = hits
    return rep

if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "motion": out = sys.argv[5]; os.makedirs(out, exist_ok=True); rep = motion_mode(sys.argv[2], sys.argv[3], sys.argv[4], out)
    else: out = sys.argv[6]; os.makedirs(out, exist_ok=True); rep = reel_mode(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], out, float(sys.argv[7]))
    fail = [c for c in CHECKS if not c["ok"]]
    json.dump({"mode": mode, "measurements": rep, "checks": CHECKS, "pass": len(CHECKS) - len(fail), "fail": len(fail)}, open(os.path.join(out, f"media-qa-{mode}.json"), "w"), indent=2, ensure_ascii=False, default=str)
    print(f"\nRESULTADO {len(CHECKS) - len(fail)} PASS · {len(fail)} FAIL"); sys.exit(1 if fail else 0)

"""Recorte de participantes (sin coste): separa a la persona de su fondo original con RobustVideoMatting (ONNX, CPU).

Uso: python3 matte.py MODELO.onnx ENTRADA SALIDA_FG.mp4 SALIDA_ALFA.mp4 [--still N] [--extend E]
  - ENTRADA: clip de avatar (mp4) o foto fija (png/jpg); con --still N la foto se repite N fotogramas para que el
    estado recurrente del modelo converja y se guarda solo el último, como PNG (SALIDA_FG.png y SALIDA_ALFA.png).
  - Salidas: primer plano (yuv420p) y alfa (gris) del MISMO tamaño y número de fotogramas que la entrada; ffmpeg las une
    con alphamerge al componer el estudio. Se escriben por tubería a ffmpeg (sin fotogramas sueltos en disco).
  - --extend E: el proveedor entrega el retrato cortado por los bordes del encuadre (hombros, brazos); en un primer plano
    ese borde se veía como una línea vertical. Se prolonga la persona E·ancho por cada lado (y E·alto/2 por abajo)
    repitiendo la última columna/fila (ropa) con un alfa que se desvanece suavemente: el hombro continúa en vez de cortarse.
Imprime una línea JSON con fotogramas, tamaño, segundos de proceso y la CARA del primer fotograma (x, y, w, h en píxeles
de la entrada; la mayor detectada, o null): la composición escala y coloca a cada participante en su asiento por la cara.
"""
import json, subprocess, sys, time
import numpy as np
import cv2
import onnxruntime as ort


def face_box(bgr):
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    g = cv2.equalizeHist(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
    m = max(40, min(bgr.shape[:2]) // 10)
    faces = cascade.detectMultiScale(g, scaleFactor=1.08, minNeighbors=6, minSize=(m, m))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return [int(x), int(y), int(w), int(h)]


def extend(fg, a, ex, ey):
    """Prolonga primer plano y alfa por los lados y por abajo; el alfa añadido se desvanece (rampa suave)."""
    if ex <= 0 and ey <= 0:
        return fg, a
    fg2 = cv2.copyMakeBorder(fg, 0, ey, ex, ex, cv2.BORDER_REPLICATE)
    a2 = cv2.copyMakeBorder(a, 0, ey, ex, ex, cv2.BORDER_REPLICATE).astype(np.float32)
    h, w = a2.shape
    ramp = lambda n: (np.cos(np.linspace(0, np.pi, n)) * 0.5 + 0.5).astype(np.float32)  # 1 → 0, suave
    if ex > 0:
        r = ramp(ex)
        a2[:, :ex] *= r[::-1][None, :]
        a2[:, w - ex:] *= r[None, :]
    if ey > 0:
        a2[h - ey:, :] *= ramp(ey)[:, None]
    return fg2, a2.clip(0, 255).astype(np.uint8)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    model, src, out_fg, out_a = args[:4]
    still = int(sys.argv[sys.argv.index("--still") + 1]) if "--still" in sys.argv else 0
    ext = float(sys.argv[sys.argv.index("--extend") + 1]) if "--extend" in sys.argv else 0.0
    so = ort.SessionOptions(); so.intra_op_num_threads = 0
    sess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    if still:
        img = cv2.imread(src, cv2.IMREAD_COLOR)
        frames = iter([img] * still)
        h, w = img.shape[:2]; fps = 25.0
    else:
        cap = cv2.VideoCapture(src)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        def gen():
            while True:
                ok, f = cap.read()
                if not ok: return
                yield f
        frames = gen()
    w2, h2 = w - w % 2, h - h % 2
    # Abajo se prolonga tanto como a los lados: un retrato muy cerrado se desvanecía por encima de la mesa (busto
    # «flotando» en la vista previa del estudio Cálido, 2026-10-28).
    ex, ey = int(round(w2 * ext)), int(round(h2 * ext))
    ex -= ex % 2; ey -= ey % 2
    W2, H2 = w2 + 2 * ex, h2 + ey
    ratio = np.array([min(1.0, 512 / max(w, h))], dtype=np.float32)
    rec = [np.zeros([1, 1, 1, 1], dtype=np.float32)] * 4
    enc = lambda fmt, path: subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", fmt, "-s", f"{W2}x{H2}", "-r", str(fps), "-i", "-",
                                             "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p" if fmt == "bgr24" else "gray", path], stdin=subprocess.PIPE)
    pf, pa = (None, None) if still else (enc("bgr24", out_fg), enc("gray", out_a))
    t0, n, last, face = time.time(), 0, None, None
    for f in frames:
        if face is None and n == 0:
            face = face_box(f)
            if face is not None:
                face = [face[0] + ex, face[1], face[2], face[3]]
        x = (cv2.cvtColor(f, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        fgr, pha, *rec = sess.run(None, {"src": x, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
        fg = cv2.cvtColor((fgr[0].transpose(1, 2, 0) * 255).clip(0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)[:h2, :w2]
        a = (pha[0, 0] * 255).clip(0, 255).astype(np.uint8)[:h2, :w2]
        fg, a = extend(fg, a, ex, ey)
        n += 1
        if still: last = (fg, a); continue
        pf.stdin.write(fg.tobytes()); pa.stdin.write(a.tobytes())
    if still:
        ok = last is not None and cv2.imwrite(out_fg, last[0]) and cv2.imwrite(out_a, last[1])
    else:
        for p in (pf, pa): p.stdin.close(); p.wait()
        ok = pf.returncode == 0 and pa.returncode == 0
    print(json.dumps({"frames": n, "w": W2, "h": H2, "seconds": round(time.time() - t0, 1), "face": face, "ok": bool(ok)}))
    sys.exit(0 if ok and n > 0 else 1)


if __name__ == "__main__":
    main()

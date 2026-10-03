"""VFX-002 phase A: temporally consistent subject matte with Robust Video Matting (ONNX, CPU, USD 0).

RVM is recurrent (r1..r4 states carry over frames), so the matte is temporally coherent by design;
no chroma key. `run_rvm` returns alpha as uint8 (T,H,W).
"""
import subprocess
import numpy as np
import onnxruntime as ort


def run_rvm(model: str, video: str, ds: float = 0.25, size=(1080, 1920)) -> np.ndarray:
    W, H = size
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", video, "-vf", f"scale={W}:{H}:flags=lanczos", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4
    dr = np.array([ds], np.float32)
    alphas = []
    while True:
        buf = proc.stdout.read(W * H * 3)
        if len(buf) < W * H * 3:
            break
        src = np.frombuffer(buf, np.uint8).reshape(H, W, 3).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        _fgr, pha, *rec = sess.run(None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": dr})
        alphas.append((np.clip(pha[0, 0], 0, 1) * 255 + 0.5).astype(np.uint8))
    proc.wait()
    return np.stack(alphas)


def matte_stats(A: np.ndarray) -> dict:
    f = A.astype(np.float32) / 255
    edge = (f > 0.02) & (f < 0.98)
    diff = np.abs(np.diff(f, axis=0))
    band = edge[1:] | edge[:-1]
    return {
        "frames": int(len(A)),
        "meanCoverage": round(float((f > 0.5).mean()), 4),
        "edgeFraction": round(float(edge.mean()), 4),
        "meanAbsFrameDiff": round(float(diff.mean()), 5),
        "meanAbsFrameDiffEdgeBand": round(float(diff[band].mean()), 4),
        "p99AbsFrameDiff": round(float(np.percentile(diff, 99)), 4),
    }

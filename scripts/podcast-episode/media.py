"""Image/video helpers for the podcast episode. Usage: media.py <step> <workdir>. Prints numbers only."""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageOps


def frames(video: Path, out: Path, count: int, width: int) -> list[Path]:
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)]).decode().strip())
    paths = []
    for i in range(count):
        t = dur * (i + 0.5) / count
        p = out / f"f{i:02d}.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={width}:-2", str(p)], check=True)
        paths.append(p)
    return paths


def sheet(paths: list[Path], cols: int) -> Image.Image:
    ims = [Image.open(p).convert("RGB") for p in paths]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    s = Image.new("RGB", (w * cols, h * rows), (20, 20, 20))
    for i, im in enumerate(ims):
        s.paste(im.resize((w, h)), ((i % cols) * w, (i // cols) * h))
    return s


def inspect(work: Path) -> None:
    out = work / "out"
    out.mkdir(exist_ok=True)
    photo = ImageOps.exif_transpose(Image.open(work / "photo")).convert("RGB")
    photo.thumbnail((900, 900))
    photo.save(out / "photo.jpg", quality=88)
    fr = frames(work / "test.mp4", out, 6, 360)
    sheet(fr, 6).save(out / "test-frames.jpg", quality=85)
    from rembg import new_session, remove

    session = new_session("birefnet-portrait")
    full = ImageOps.exif_transpose(Image.open(work / "photo")).convert("RGB")
    cut = remove(full, session=session)
    alpha = cut.split()[-1]
    bbox = alpha.getbbox()
    cut.save(work / "cutout.png")
    prev = Image.new("RGB", cut.size, (40, 60, 90))
    prev.paste(cut, mask=alpha)
    prev.thumbnail((900, 900))
    prev.save(out / "cutout-preview.jpg", quality=88)
    print("INSPECT", json.dumps({"photo": list(full.size), "personBBox": bbox, "alphaCoverage": round(sum(alpha.histogram()[128:]) / (full.size[0] * full.size[1]), 3)}))


if __name__ == "__main__":
    step, work = sys.argv[1], Path(sys.argv[2])
    {"inspect": inspect}[step](work)

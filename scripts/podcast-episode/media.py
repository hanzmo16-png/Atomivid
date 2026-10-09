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


def composite(work: Path) -> None:
    """Person cut-out (from the approved photo, face untouched) over each studio plate, 1920x1080."""
    import numpy as np
    from PIL import ImageFilter

    out = work / "out"
    out.mkdir(exist_ok=True)
    wide = work / "cutout-wide.png"
    cut = Image.open(wide if wide.exists() else work / "cutout.png").convert("RGBA")
    W, H = 1920, 1080
    # The approved photo clips the jacket at its left/right borders below some row. Scale so that row
    # lands just below the frame: the silhouette stays natural and no straight cut edge is visible.
    alpha_full = np.asarray(cut.split()[-1])
    touching = np.where((alpha_full[:, :3].max(1) > 127) | (alpha_full[:, -3:].max(1) > 127))[0]
    clip_row = int(touching.min()) if touching.size else cut.height
    visible = min(cut.height, clip_row - 6)
    scale = H / visible
    person = cut.resize((round(cut.width * scale), round(cut.height * scale)), Image.LANCZOS).crop((0, 0, round(cut.width * scale), H))
    report = []
    for plate_path in sorted(work.glob("plate-*.png")):
        n = plate_path.stem.split("-")[1]
        plate = Image.open(plate_path).convert("RGB")
        # Fill 16:9 (plates are 3:2), then a gentle lens blur: the set sits behind the presenter.
        r = max(W / plate.width, H / plate.height)
        plate = plate.resize((round(plate.width * r), round(plate.height * r)), Image.LANCZOS)
        left, top = (plate.width - W) // 2, (plate.height - H) // 2
        bg = plate.crop((left, top, left + W, top + H)).filter(ImageFilter.GaussianBlur(2.2))
        x = (W - person.width) // 2
        rgb = np.asarray(person.convert("RGB")).astype(np.float32)
        a = np.asarray(person.split()[-1]).astype(np.float32) / 255.0
        # Colour coherence: pull the presenter 18% toward the set's mean tone (keeps skin natural).
        region = np.asarray(bg.crop((x, 0, x + person.width, H))).astype(np.float32)
        set_mean = region.reshape(-1, 3).mean(0)
        p_mean = rgb[a > 0.5].mean(0)
        rgb = np.clip(rgb + (set_mean - p_mean) * 0.18, 0, 255)
        # Cool rim light on the silhouette edge, like the studio's blue accents.
        edge = np.asarray(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255.0
        rim = np.array([120, 170, 255], np.float32)
        rgb = np.clip(rgb + edge[..., None] * a[..., None] * rim * 0.22, 0, 255)
        canvas = np.asarray(bg).astype(np.float32)
        sl = canvas[:, x:x + person.width]
        canvas[:, x:x + person.width] = sl * (1 - a[..., None]) + rgb * a[..., None]
        comp = Image.fromarray(canvas.astype(np.uint8))
        comp.save(work / f"composite-{n}.png")
        prev = comp.copy()
        prev.thumbnail((1280, 720))
        prev.save(out / f"composite-{n}.jpg", quality=90)
        report.append({"plate": n, "clipRow": clip_row, "scale": round(scale, 3), "personX": x, "personW": person.width, "setMean": [round(v) for v in set_mean]})
    print("COMPOSITE", json.dumps(report))


def extend_prep(work: Path) -> None:
    """Square canvas: the approved photo in the centre, transparent side bands for the jacket extension."""
    photo = ImageOps.exif_transpose(Image.open(work / "photo")).convert("RGBA")
    side = photo.height
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    x = (side - photo.width) // 2
    canvas.paste(photo, (x, 0))
    canvas.resize((1024, 1024), Image.LANCZOS).save(work / "extend-in.png")
    (work / "extend-geom.json").write_text(json.dumps({"side": side, "x": x, "w": photo.width}))
    print("EXTEND_PREP", json.dumps({"side": side, "x": x}))


def extend_merge(work: Path) -> None:
    """Generated side bands + the ORIGINAL photo pixels pasted back on top (face and original area untouched)."""
    import numpy as np
    from rembg import new_session, remove

    g = json.loads((work / "extend-geom.json").read_text())
    side, x, w = g["side"], g["x"], g["w"]
    gen = Image.open(work / "extend-out.png").convert("RGB").resize((side, side), Image.LANCZOS)
    photo = ImageOps.exif_transpose(Image.open(work / "photo")).convert("RGB")
    merged = np.asarray(gen).astype(np.float32)
    orig = np.asarray(photo).astype(np.float32)
    feather = 28
    ramp = np.ones(w, np.float32)
    ramp[:feather] = np.linspace(0, 1, feather)
    ramp[-feather:] = np.linspace(1, 0, feather)
    region = merged[:, x:x + w]
    merged[:, x:x + w] = region * (1 - ramp[None, :, None]) + orig * ramp[None, :, None]
    out = Image.fromarray(merged.astype(np.uint8))
    out.save(work / "extended.png")
    cut = remove(out, session=new_session("birefnet-portrait"))
    cut.save(work / "cutout-wide.png")
    prev = out.copy()
    prev.thumbnail((900, 900))
    prev.save(work / "out" / "extended.jpg", quality=88)
    # Identity check: the original photo area must be pixel-identical outside the feather band.
    inner = np.abs(np.asarray(out).astype(np.int16)[:, x + feather:x + w - feather] - orig.astype(np.int16)[:, feather:w - feather]).max()
    print("EXTEND_MERGE", json.dumps({"side": side, "originalAreaMaxDiff": int(inner)}))


if __name__ == "__main__":
    step, work = sys.argv[1], Path(sys.argv[2])
    {"inspect": inspect, "composite": composite, "extend-prep": extend_prep, "extend-merge": extend_merge}[step](work)

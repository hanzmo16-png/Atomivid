"""Free editorial preview using downloaded assets and approved caption timings.

This FFmpeg review does not replace or validate the Remotion/web composition.
No provider calls, credentials, remote writes or image generation.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from PIL import ImageFont


def run(args):
    subprocess.run(args, check=True)


def stamp(seconds):
    cs = round(seconds * 100)
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


def escape(text):
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("assets", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    spec_path = Path("docs/quality/ocean-deep-001/opening-review.json")
    spec = json.loads(spec_path.read_text())
    caps = json.loads((args.assets / "opening-captions.json").read_text())
    work = args.assets / "opening-render"
    work.mkdir(exist_ok=True)
    fps = spec["fps"]
    font_path = subprocess.check_output(["fc-match", "Arial:style=Bold", "-f", "%{file}"], text=True)
    font = ImageFont.truetype(font_path, 31)
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,31,&H00FFFFFF,&H0066D1FF,&H60000000,&H80000000,-1,0,0,0,100,100,0,0,1,1,1,2,40,40,80,1
Style: Credit,Arial,17,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,7,38,38,30,1
Style: Title,Arial,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1.5,1,7,38,38,110,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []

    def event(layer, start, end, style, text):
        if end > start:
            events.append(f"Dialogue: {layer},{stamp(start)},{stamp(end)},{style},,0,0,0,,{text}")

    for c in caps:
        # A fixed phrase box; only the active word color changes.
        width = int(font.getlength(c["text"]))
        assert width <= 934, f"Caption exceeds safe width: {c['text']}"
        left, right = (1280 - width) // 2 - 22, (1280 + width) // 2 + 22
        box = (r"{\an7\pos(0,0)\p1\bord0\shad0\1c&H0E0A0A&\1a&H52&}"
               f"m {left} 591 l {right} 591 l {right} 646 l {left} 646" + r"{\p0}")
        event(0, c["startSeconds"], c["endSeconds"], "Caption", box)
        words = c["words"]
        for i, word in enumerate(words):
            start = max(c["startSeconds"], word["startSeconds"])
            end = min(c["endSeconds"], words[i + 1]["startSeconds"] if i + 1 < len(words) else c["endSeconds"])
            text = " ".join((r"{\1c&H66D1FF&}" if j == i else r"{\1c&HFFFFFF&}") + escape(w["text"]) for j, w in enumerate(words))
            event(1, start, end, "Caption", r"{\an2\pos(640,638)}" + text)

    for s in spec["scenes"]:
        label = escape(s["label"])
        if s["credit"]:
            label += r"\N{\fs14}" + escape(s["credit"])
        event(2, s["startSeconds"], s["endSeconds"], "Credit", label)
    for overlay in spec["overlays"]:
        event(3, overlay["startSeconds"], overlay["endSeconds"], "Title", r"{\fad(100,120)}" + escape(overlay["text"]))

    subtitles = work / "captions.ass"
    subtitles.write_text(header + "\n".join(events) + "\n")
    parts = []
    hashes = {}
    for i, scene in enumerate(spec["scenes"]):
        source = args.assets / scene["file"]
        hashes[scene["file"]] = hashlib.sha256(source.read_bytes()).hexdigest()
        frames = round(scene["endSeconds"] * fps) - round(scene["startSeconds"] * fps)
        duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source)]))
        assert scene["sourceStartSeconds"] + frames / fps <= duration
        part = work / f"part-{i:02}.mp4"
        run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(scene["sourceStartSeconds"]),
             "-i", str(source), "-an", "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30",
             "-frames:v", str(frames), "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", str(part)])
        parts.append(part)
        print(f"Prepared {scene['id']}: {frames} frames", flush=True)

    concat = work / "parts.txt"
    concat.write_text("\n".join(f"file '{p.resolve()}'" for p in parts))
    joined = work / "picture.mp4"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(joined)])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(joined), "-i", str(args.assets / spec["audioFile"]),
         "-map", "0:v", "-map", "1:a:0", "-vf", f"ass={subtitles.resolve()}", "-af", "afade=t=out:st=29.05:d=0.15",
         "-t", str(spec["durationSeconds"]), "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(args.output)])
    totals = {}
    for scene in spec["scenes"]:
        totals[scene["kind"]] = totals.get(scene["kind"], 0) + scene["endSeconds"] - scene["startSeconds"]
    report = {"durationSeconds": spec["durationSeconds"], "secondsByKind": {k: round(v, 3) for k, v in totals.items()},
              "stillSeconds": 0, "blackTextCardSeconds": 0, "paidGenerationCalls": 0, "sourceSha256": hashes,
              "audioSourceSha256": hashlib.sha256((args.assets / spec["audioFile"]).read_bytes()).hexdigest(),
              "captionWords": sum(len(c["words"]) for c in caps), "renderer": "FFmpeg editorial review; web integration not tested"}
    (work / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

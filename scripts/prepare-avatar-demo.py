#!/usr/bin/env python3
"""Local-only avatar reframing and technical QA. Never calls a paid provider.

Crop coordinates refer to the image after conversion to 1080x1920 square
pixels. Inspect the source before choosing them; no automatic face guessing.
Watermarks within the selected picture remain untouched.
"""
import argparse
import json
import subprocess
from pathlib import Path


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def probe(file):
    return json.loads(run(["ffprobe", "-v", "error", "-show_streams",
                           "-show_format", "-of", "json", str(file)]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--crop", nargs=4, type=int, required=True,
                        metavar=("X", "Y", "WIDTH", "HEIGHT"))
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve() or args.output.exists():
        raise ValueError("Choose a new output path; source files are never overwritten")
    x, y, w, h = args.crop
    if min(x, y) < 0 or min(w, h) < 2 or x+w > 1080 or y+h > 1920:
        raise ValueError("Crop must fit the 1080x1920 display image")
    if abs((w/h)/(9/16)-1) > .01:
        raise ValueError("Crop must have approximately 9:16 proportions")
    source = probe(args.source)
    if not any(s["codec_type"] == "audio" for s in source["streams"]):
        raise ValueError("Source has no audio")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-i", str(args.source),
         "-map", "0:v:0", "-map", "0:a:0", "-vf",
         f"scale=1080:1920,setsar=1,crop={w}:{h}:{x}:{y},scale=1080:1920:flags=lanczos,setsar=1",
         "-c:v", "libx264", "-preset", "fast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
         str(args.output)])
    result = probe(args.output)
    video = next(s for s in result["streams"] if s["codec_type"] == "video")
    duration_delta = abs(float(result["format"]["duration"])-float(source["format"]["duration"]))
    assert (video["width"], video["height"]) == (1080, 1920)
    assert video["sample_aspect_ratio"] == "1:1"
    assert duration_delta < .1, "Unexpected duration change"
    run(["ffmpeg", "-v", "error", "-xerror", "-i", str(args.output), "-f", "null", "-"])
    report = {
        "output": args.output.name, "duration_seconds": float(result["format"]["duration"]),
        "width": 1080, "height": 1920, "fps": video["r_frame_rate"],
        "audio": "copied without re-encoding", "decode_check": "passed",
        "duration_delta_seconds": duration_delta,
        "provider_calls": 0, "crop_display_pixels": args.crop,
        "limitations": ["Upscaling does not restore lost detail",
                        "No lip-sync or transcription approval from technical QA",
                        "Existing watermarks inside the picture remain"],
    }
    args.output.with_suffix(".qa.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

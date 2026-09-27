"""Builds minute1-manifest.json (stage A, beat b1) from the recorded narration.

Cuts sit in the silences between Brian's words (run 36319594264, @@WORDS b1);
each scene's `narration` is taken from those words so it always matches what is
spoken. Assets come from the candidate review (runs 36319717981, 36319901385 and
the narrower Commons pass in search-spec-b1-r2.json). Paid items keep the keys of
the draft so a clip already paid is never requested again.

    python3 docs/quality/ocean-deep-001/build_minute1_manifest.py <words-b1.json>
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
NARRATION_SECONDS = 41.053
TAIL = 1.2
LOOK = {"saturation": 0.85, "contrast": 1.05}

words = json.loads(Path(sys.argv[1]).read_text())
draft = json.loads((HERE / "minute1-manifest.draft.json").read_text())
draft_src = {s["id"]: s["source"] for s in draft["scenes"]}


def spoken(start, end):
    return " ".join(w for w, a, b in words if start <= (a + b) / 2 < end)


def approved(note, relevance="directa"):
    return {"status": "approved", "relevance": relevance, "note": note}


end_all = round(NARRATION_SECONDS + TAIL, 3)

# The draft's reference (File:Deep Discoverer (51816198671).jpg) never came back as public domain from the
# Commons search; the second pass found NOAA's own PD frame of the vehicle lighting the seabed off Puerto Rico.
S01_REFERENCE = "File:Deep Discoverer seabed Puerto Rico 11 April 2025.png"
s01 = dict(draft_src["s01"])
s01["reference"] = {"kind": "commons", "title": S01_REFERENCE}
s01["placeholder"] = {
    "source": {"kind": "commons", "title": S01_REFERENCE},
    "provenance": "archival_documentary",
    "creditText": "NOAA Ocean Exploration",
    "camera": "push",
}
s04 = dict(draft_src["s04"])
# Free stand-in only while the clip does not exist (never shown in the approval render once the clip is paid).
s04["placeholder"] = {"source": {"kind": "pexels-video", "id": 11025402}, "provenance": "stock_illustrative", "camera": "still"}

scenes = [
    # (id, start, end, source, provenance, credit, direction, review)
    ("s01", 0.0, 5.03, s01, "ai_recreation", "Animated from a NOAA photo",
     {"camera": "still", "look": LOOK},
     approved("Veo image-to-video from the NOAA public-domain photo; labelled AI recreation; nothing added to the scene")),
    ("s02", 5.03, 11.70, {"kind": "commons", "title": "File:Expn0686 (14526221693).jpg"}, "archival_documentary",
     "NOAA Ocean Exploration (public domain)",
     {"camera": "push", "look": LOOK, "transition": {"type": "dissolve", "seconds": 0.6}},
     approved("NOAA Photo Library, public domain, 1920x1080: pale sediment and scattered rock in ROV lights (a cold seep; the bubbles are not narrated)")),
    ("s03", 11.70, 14.19, {"kind": "commons", "title": "File:Coronate of the genus Atolla Puerto Rico 28 April 2015.png"}, "archival_documentary",
     "NOAA Ocean Exploration (public domain)",
     {"camera": "still", "look": LOOK},
     approved("NOAA OER 2015, public domain, 1724x967: a small medusa drifting in the ROV lights at ~800 m (lit by the vehicle; not described as bioluminescent). Preferred over the 400x300 Crossota photo")),
    ("s04", 14.19, 18.05, s04, "ai_recreation", None,
     {"camera": "still", "look": LOOK, "transition": {"type": "dissolve", "seconds": 0.6}},
     approved("Veo image-to-video from an AI still; labelled AI recreation")),
    ("s05", 18.05, 24.13, {"kind": "graphic", "spec": {
        "kind": "text", "title": "One lit patch at a time",
        "body": "Almost everything seen in the deep sea was seen within reach of a vehicle's lights",
        "citation": "Observed seafloor: Bell et al. 2025, Science Advances",
        "isFixture": False, "size": "large"}}, "data_graphic", None,
     {"camera": "still"},
     approved("Large text card (Atomivid code)")),
    ("s06", 24.13, 29.07, {"kind": "commons", "title": "File:NOAA ETOPO Global Relief map.jpg"}, "data_graphic",
     "NOAA NCEI ETOPO global relief (public domain) · Seabed 2030: 28.7% of the seafloor mapped (Apr 2026)",
     {"camera": "left", "look": LOOK, "transition": {"type": "dissolve", "seconds": 0.6}},
     approved("NOAA NCEI, public domain, 5400x2700: real coastlines and seafloor relief")),
    ("s07", 29.07, 33.54, {"kind": "graphic", "spec": {
        "kind": "text", "title": "Two kinds of knowing",
        "body": "Mapped: measured from a distance, mostly by sonar. Seen: observed directly, by camera or eye.",
        "isFixture": False, "size": "large"}}, "data_graphic", None,
     {"camera": "still"},
     approved("Large text card (Atomivid code)")),
    ("s08", 33.54, end_all, {"kind": "pexels-video", "id": 38178142}, "stock_illustrative", None,
     {"camera": "still", "look": LOOK, "transition": {"type": "dissolve", "seconds": 0.6}},
     # 30248500 (4K, 18 s) exceeded the Storage object size limit in the free prepare (run 36322811375).
     approved("Pexels License (Çağrı KANMAZ, 1920x1080, 10 s): calm ocean surface at dusk; present-day surface, not deep-sea footage", "indirecta")),
]

out = []
for sid, start, end, src, prov, credit, direction, review in scenes:
    scene = {"id": sid, "startSeconds": start, "endSeconds": end, "narration": spoken(start, end), "source": src,
             "provenance": prov, "direction": direction, "review": review}
    if credit:
        scene["creditText"] = credit
    out.append(scene)

manifest = {
    "requestId": draft["requestId"],
    "script": draft["script"],
    "voiceId": draft["voiceId"],
    "beats": ["b1"],
    "outputLabel": "minute1",
    "tailSeconds": TAIL,
    "outputPrefix": draft["outputPrefix"],
    "scenes": out,
    "soundCues": [{"id": "m1-bed", "track": "atomivid-suspense-a-v1", "role": "music", "startSeconds": 0,
                   "endSeconds": end_all, "fadeInSeconds": 2.0, "fadeOutSeconds": 1.2, "loop": True, "gain": 0.8}],
    "missingSound": draft["missingSound"],
    # Kicker ≤ 32 characters (cover-rules «kicker_too_long»); the draft's 46-character kicker would block the render.
    "packaging": {"cover": {**draft["packaging"]["cover"], "kicker": "What we've seen, what we haven't"}},
}
(HERE / "minute1-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
for s in out:
    print(f'{s["id"]} {s["startSeconds"]:6.2f}-{s["endSeconds"]:6.3f}  {s["narration"]}')

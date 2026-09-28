"""Dulce Part I: Smart Mix audit of the 44 planned Runway clips, Plan A vs Plan B economics,
shift-left narrative fields per slot. Planning only (no API calls).
Reads content/long-form/dulce-part1/storyboard.json; writes smart-mix.json and docs/quality/dulce-part1/SMART-MIX.md."""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sb = json.load(open(f"{ROOT}/content/long-form/dulce-part1/storyboard.json"))
shots, NEW = sb["shots"], sb["newAssets"]

# asset: (class, shot_class, deformation_risk, motion_value, method, clip_s, reason, storyboard_change)
# method: i2v_economy (5 s) | i2v_hero (10 s) | ken_burns | parallax (layered pan/push on the approved still)
C = {
 "N01": ("B","landscape","LOW","MEDIUM","parallax",0,"Hook drone read works as a slow push over the mesa at 2.6 s.",""),
 "N02": ("C","landscape","LOW","LOW","ken_burns",0,"Distant town lights: a slow pan is indistinguishable at 2.4 s.",""),
 "N03": ("C","landscape","LOW","LOW","ken_burns",0,"Static entrance and floodlights; push-in carries it.",""),
 "N04": ("B","corridor","LOW","MEDIUM","ken_burns",0,"A centred push-in on a vanishing-point tunnel reads as a dolly.",""),
 "N05": ("B","single_human","MEDIUM","MEDIUM","ken_burns",0,"Thomas identity outranks screen flicker; one still gives three framings (wide, medium, monitors).",""),
 "N06": ("C","object","LOW","LOW","ken_burns",0,"Insert: badge reader with lit LED.",""),
 "N07": ("C","object","LOW","LOW","ken_burns",0,"Insert: vault door and keypad.",""),
 "N08": ("C","multi_human","MEDIUM","LOW","ken_burns",0,"Barrier with a guard: people should not move here.",""),
 "N09": ("B","other","LOW","MEDIUM","ken_burns",0,"Technical area: vapor would help, a slow pan is enough.",""),
 "N10": ("B","other","LOW","MEDIUM","ken_burns",0,"Shaft looking down: a push-in downward gives the vertigo.",""),
 "N11": ("A","creature","MEDIUM","HIGH","i2v_economy",5,"First clear grey: a slight head turn and breath make it a living being, not concept art.",""),
 "N12": ("A","creature","MEDIUM","HIGH","i2v_economy",5,"First reptilian: breathing and a slight turn; also used as a 1.4 s flash in p13.",""),
 "N13": ("B","creature","MEDIUM","MEDIUM","ken_burns",0,"Grey at a console seen from the side; N11 already establishes the beings as alive.",""),
 "N14": ("C","human_creature","HIGH","LOW","ken_burns",0,"Human + grey at the same bench: interaction class, still by rule.",""),
 "N15": ("B","creature","MEDIUM","MEDIUM","ken_burns",0,"Silhouette behind glass: stillness is part of the menace.",""),
 "N16": ("C","creature","MEDIUM","LOW","ken_burns",0,"POV with a distant, motionless grey.",""),
 "N18": ("C","multi_human","HIGH","LOW","ken_burns",0,"Turnstiles with staff: multi-human by rule.",""),
 "N19": ("C","human_creature","HIGH","LOW","ken_burns",0,"Typing hands + a figure crossing: two banned motions.","Grey silhouette STANDS behind the frosted glass (no crossing); hands out of frame."),
 "N20": ("A","single_human","MEDIUM","HIGH","i2v_economy",5,"Emotional core: Thomas silent at dinner. Breath and a blink keep a 5 s close-up alive; one micro-gesture only.","Slot trimmed to 5.0 s; the extra 1.3 s goes to D10-04."),
 "N21": ("B","landscape","LOW","MEDIUM","parallax",0,"Truck at dawn: a lateral pan past a parked truck on the road reads as departure.",""),
 "N22": ("B","single_human","MEDIUM","LOW","ken_burns",0,"Thomas close-up in the corridor; push-in only.",""),
 "N23": ("C","human_creature","HIGH","LOW","ken_burns",0,"Humans and a grey across a partition: interaction class.",""),
 "N25": ("B","single_human","MEDIUM","MEDIUM","ken_burns",0,"Thomas at the observation window: slow push, reflection static.",""),
 "N26": ("C","laboratory","LOW","LOW","ken_burns",0,"Empty medical bay: dolly-in on a still.",""),
 "N27": ("B","object","LOW","MEDIUM","ken_burns",0,"Strange equipment: a push plus an FFmpeg glow pulse on the lights.",""),
 "N28": ("C","human_creature","HIGH","LOW","ken_burns",0,"Technician at microscope with a grey beside him: interaction class, hands.",""),
 "N29": ("C","laboratory","MEDIUM","LOW","ken_burns",0,"Gallery view from above with small figures.",""),
 "N30": ("C","single_human","LOW","LOW","ken_burns",0,"Thomas from behind facing a lift door.",""),
 "N31": ("C","multi_human","HIGH","LOW","ken_burns",0,"Two workers talking: multi-human, lips.",""),
 "N32": ("B","single_human","MEDIUM","MEDIUM","ken_burns",0,"Worker's sideways glance; a push-in carries the warning.",""),
 "N33": ("B","single_human","MEDIUM","LOW","ken_burns",0,"Man seated in the holding room through a small window.",""),
 "N34": ("B","single_human","MEDIUM","LOW","ken_burns",0,"Thomas in profile at the door window.",""),
 "N35": ("A","single_human","MEDIUM","HIGH","i2v_economy",5,"George's introduction: lifting his eyes to the lens is the moment the story turns.","Slot P1-088 trimmed to 5.0 s; p10 reuse (P1-092) uses the approved still with a push-in."),
 "N36": ("B","single_human","MEDIUM","LOW","ken_burns",0,"George close-up; still push after N35 has established him alive.",""),
 "N37": ("C","single_human","HIGH","LOW","ken_burns",0,"Thomas walking = complex body action; identity first.","Thomas STANDS in the corridor, head lowered; camera dolly-back on the still."),
 "N38": ("B","single_human","MEDIUM","MEDIUM","ken_burns",0,"Thomas in low light; slow push.",""),
 "N41": ("A","corridor","LOW","HIGH","i2v_hero",10,"Nightmare Hall: drifting fog and pulsing red light are the atmosphere; used in four slots (up to 11 s).",""),
 "N43": ("B","single_human","MEDIUM","MEDIUM","ken_burns",0,"Thomas descending: the rising red light is done in FFmpeg as a graded light sweep over the still.",""),
 "N44": ("B","object","LOW","MEDIUM","ken_burns",0,"Blast door with fog: push-in; fog stays in the still.",""),
 "N46": ("A","object","LOW","HIGH","i2v_economy",5,"A rotating emergency beacon has no meaning without rotation; object class, low risk.",""),
 "N47": ("C","landscape","LOW","LOW","ken_burns",0,"Night sky: a pan on a still is the standard treatment.",""),
 "N48": ("C","object","LOW","LOW","ken_burns",0,"Radio equipment insert.",""),
 "N49": ("C","object","LOW","LOW","ken_burns",0,"Antennas against the sky.",""),
 "D04-01": ("C","creature","MEDIUM","MEDIUM","ken_burns",0,"The approved still of the grey in the flashlight beam is excellent; the V1 animation turned it into another being. Push-in on the still, no new generation.",""),
}
PLAN_A = {k: (10 if NEW.get(k, {}).get("kind", "").endswith("rw10") else 5) for k in C}
assert len(C) == 44 and set(C) == set(PLAN_A)

IMG, IMG_MAX, SEC = 0.10, 0.30, 0.05
CREATOR = 11.0
FIN_SEC = sb["summary"]["timelineSeconds"]
rows = []
for k, (cls, sclass, risk, mval, method, clip, reason, change) in C.items():
    slots = [s for s in shots if s["src"] == k]
    accepted = round(sum(s["sec"] for s in slots), 1)
    a_cost = PLAN_A[k] * SEC
    b_cost = clip * SEC
    rows.append({"asset": k, "slots": [s["id"] for s in slots], "narrationIntent": " / ".join(s["cue"] for s in slots),
                 "visualIntent": NEW[k]["description"] if k in NEW else "Gris en el haz de la linterna (still aprobado V1)",
                 "characters": NEW[k]["characters"] if k in NEW else ["gris"], "shotClass": sclass, "slotSeconds": [s["sec"] for s in slots],
                 "planA": {"method": "i2v_runway", "clipSeconds": PLAN_A[k], "costUsd": a_cost},
                 "classification": {"A": "MOTION_ESSENTIAL", "B": "MOTION_BENEFICIAL", "C": "MOTION_UNNECESSARY"}[cls],
                 "deformationRisk": risk, "motionValue": mval, "recommendedMethod": method, "clipSeconds": clip,
                 "expectedCostUsd": b_cost, "savingsUsd": round(a_cost - b_cost, 2), "reason": reason, "storyboardChange": change,
                 "acceptedSeconds": accepted})

def plan(clips):
    clips = list(clips)
    n = sum(1 for c in clips if c > 0); gen_s = sum(clips); video = round(gen_s * SEC, 2)
    return n, gen_s, video
nA, gA, vA = plan(PLAN_A.values()); nB, gB, vB = plan(r["clipSeconds"] for r in rows)
imgs = sb["summary"]["newGenerations"]["images"]
img_cost = round(imgs * IMG, 2)
retry_img = round(img_cost * 0.5, 2)                     # V1 needed ~50% extra images
retryA = round(retry_img + vA * 0.35, 2)                 # prior plan's reserve
retryB = round(retry_img + vB * 0.5, 2)                  # one modified retry expected for half the clips
expA = round(img_cost + vA + retryA + CREATOR, 2); expB = round(img_cost + vB + retryB + CREATOR, 2)
worstA = round(imgs * IMG_MAX * 2 + vA * 1.8 + CREATOR, 2); worstB = round(imgs * IMG_MAX * 2 + vB * 2 + CREATOR, 2)
acceptedA = round(sum(r["acceptedSeconds"] for r in rows), 1)
STILL_SLOTS = {"P1-092"}  # N35 reuse in p10 uses the approved still
for r in rows:
    if r["clipSeconds"]:
        r["acceptedSecondsB"] = round(sum(min(sec, r["clipSeconds"]) for sid, sec in zip(r["slots"], r["slotSeconds"]) if sid not in STILL_SLOTS), 1)
acceptedB = round(sum(r.get("acceptedSecondsB", 0) for r in rows), 1)
v1_runway = round(sum(s["sec"] for s in shots if s["origin"] == "V1"), 1)
still_motion_B = sum(1 for s in shots if (s["src"] in C and C[s["src"]][5] == 0) or (s["src"] in NEW and NEW[s["src"]]["kind"] == "img+ff"))
still_motion_A = sum(1 for s in shots if s["src"] in NEW and NEW[s["src"]]["kind"] == "img+ff")
# Plan B+: seven low-risk i2v_economy upgrades chosen to break runs of consecutive stills.
UPGRADE = ["N01", "N04", "N05", "N26", "N33", "N43", "N48"]  # breaks the still runs: hook P1-001..004, p08-p09 P1-081..087, p14 teaser
up_cost = round(len(UPGRADE) * 5 * SEC, 2); up_retry = round(up_cost * 0.5, 2)
summary = {
 "counts": {c: sum(1 for r in rows if r["classification"] == c) for c in ("MOTION_ESSENTIAL", "MOTION_BENEFICIAL", "MOTION_UNNECESSARY")},
 "finishedSeconds": FIN_SEC,
 "planA": {"generativeClips": nA, "generativeSeconds": gA, "acceptedGenerativeSeconds": acceptedA, "stillMotionSlots": still_motion_A,
           "imageCost": img_cost, "videoCost": vA, "retryReserve": retryA, "creator": CREATOR, "expected": expA, "worstCase": worstA,
           "genSecondsPerFinishedMinute": round(gA / (FIN_SEC / 60), 1), "newGenerativeShareOfTimeline": round(acceptedA / FIN_SEC, 3)},
 "planB": {"generativeClips": nB, "generativeSeconds": gB, "acceptedGenerativeSeconds": acceptedB, "stillMotionSlots": still_motion_B,
           "imageCost": img_cost, "videoCost": vB, "retryReserve": retryB, "creator": CREATOR, "expected": expB, "worstCase": worstB,
           "genSecondsPerFinishedMinute": round(gB / (FIN_SEC / 60), 1), "newGenerativeShareOfTimeline": round(acceptedB / FIN_SEC, 3)},
 "v1RunwayFootageSeconds": v1_runway,
 "savingsExpected": round(expA - expB, 2), "savingsWorst": round(worstA - worstB, 2),
 "upgradePack": {"assets": UPGRADE, "videoCost": up_cost, "retryReserve": up_retry, "expectedWithB": round(expB + up_cost + up_retry, 2)},
}
json.dump({"summary": summary, "clips": rows}, open(f"{ROOT}/content/long-form/dulce-part1/smart-mix.json", "w"), ensure_ascii=False, indent=2)

L = ["# DULCE Part I — Smart Mix audit (44 planned Runway clips)", "", "Planning only. Generated by `scripts/lib/dulce-part1-smartmix.py`.", "",
     "| Asset | Slots | Narration intent | Visual intent | Characters | Class | Slot s | Plan A | Class. | Risk | Motion value | Method | Clip s | Cost B | Saving | Reason | Storyboard change |",
     "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
for r in rows:
    L.append(f"| {r['asset']} | {', '.join(r['slots'])} | {r['narrationIntent']} | {r['visualIntent']} | {', '.join(r['characters'])} | {r['shotClass']} | {', '.join(map(str, r['slotSeconds']))} | {r['planA']['clipSeconds']} s · ${r['planA']['costUsd']:.2f} | {r['classification']} | {r['deformationRisk']} | {r['motionValue']} | {r['recommendedMethod']} | {r['clipSeconds']} | ${r['expectedCostUsd']:.2f} | ${r['savingsUsd']:.2f} | {r['reason']} | {r['storyboardChange']} |")
L += ["", "```json", json.dumps(summary, indent=1), "```"]
open(f"{ROOT}/docs/quality/dulce-part1/SMART-MIX.md", "w").write("\n".join(L) + "\n")
print(json.dumps(summary, indent=1))

# ---- Shift-left narrative QA fields on every storyboard slot ----
GROUP = {"family": "D08-06 D12-06 D12-01 D12-03 D11-06 D10-05 D10-04 D09-04 D11-04 D11-03 D12-04 N20 N21",
         "exterior": "N01 N02 N03 N47 N49 D02-03",
         "security": "N05 N06 N07 N08 N18 N24 D07-04 D07-05 D08-04 D08-03 D02-06 D07-02 N17",
         "corridor-levels": "N04 D01-01 D01-03 D01-07 D03-06 D07-01 D07-03 D07-06 D08-01 D04-01 D04-02 D04-03 D04-04 N16 N22 N37 N38 D05-06 D02-04 D03-05 N09",
         "elevator-shaft": "D03-03 D03-04 N10 N30 N42 N43 N44",
         "beings-at-work": "N11 N12 N13 N14 N15 N19 N23 N28",
         "laboratory": "D01-04 D01-05 D01-06 D05-01 D05-02 D06-01 D06-02 D06-03 D06-05 N25 N26 N27 N29",
         "workers-george": "N31 N32 N33 N34 N35 N36",
         "documents-archive": "N39 N40 N45 D06-06 N48 N50",
         "nightmare-hall": "N41 N46", "graphics": "G1 G2 G3 G4 G5 G6 G7"}
group_of = {a: g for g, ids in GROUP.items() for a in ids.split()}
BASE_FORBID = ["readable text or logos", "people entering or leaving frame", "extra or duplicated people", "morphing objects"]
CLASS_FORBID = {"single_human": ["face or hair change", "cap or hat", "blue shirt on Thomas", "hands performing tasks"],
                "multi_human": ["people crossing", "position swaps", "lip-sync talking"],
                "creature": ["transformation", "extra limbs", "change of species"],
                "human_creature": ["touching or handing objects", "anyone changing places"],
                "laboratory": ["gore", "bodies being handled"], "landscape": ["vehicles appearing"], "corridor": ["figures emerging from the dark"]}
by_asset = {r["asset"]: r for r in rows}
for i, s in enumerate(shots):
    a = s["src"]; r = by_asset.get(a)
    s["productionMethod"] = (r["recommendedMethod"] if r else ("v1_recut" if s["origin"] == "V1" else "graphic" if a.startswith("G") else "ken_burns"))
    if a == "N35" and s["id"] == "P1-092": s["productionMethod"] = "ken_burns"
    s["shotClass"] = r["shotClass"] if r else ("graphic" if a.startswith("G") else "family" if group_of.get(a) == "family" else "other")
    s["narrationIntent"] = s["cue"]; s["visualIntent"] = s["visual"]
    ents = [e for e in (s.get("chars") or "").split(", ") if e]
    s["requiredEntities"] = ents
    s["forbiddenElements"] = BASE_FORBID + CLASS_FORBID.get(s["shotClass"], []) + (["door opening/closing", "family members moving"] if group_of.get(a) == "family" else [])
    s["continuityGroup"] = group_of.get(a, "other")
    s["previousState"] = shots[i-1]["visual"] if i else "(episode opens)"
    s["nextState"] = shots[i+1]["visual"] if i + 1 < len(shots) else "(end)"
    if r and r["storyboardChange"]: s["storyboardChange"] = r["storyboardChange"]
json.dump(sb, open(f"{ROOT}/content/long-form/dulce-part1/storyboard.json", "w"), ensure_ascii=False, indent=2)

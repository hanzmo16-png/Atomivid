import json
VEO=0.96; STILL=0.06
PD_NOAA="Public domain (U.S. Government work, NOAA) — verify per file at candidate review: reject if caption says 'copyright' or licence is CC BY-SA"
PEXELS="Pexels License — free commercial use, no attribution required; not presented as deep-sea footage"
OWN="Deterministic graphic rendered by Atomivid code — no third-party material"
NE="Natural Earth (public domain) — data map rendered by Atomivid code"
AI_LABEL="On-screen label: 'AI illustration' / 'AI animation' — never presented as filmed discovery"
# (beat, secs, kind, intent/visualIntent, method detail, source/query, cost, extra)
# v002 (Hans's review of the first minute): short text cards (≤ 5 s, only when the words ARE the picture);
# figures preferably over moving footage (stat-overlay); motion priority: real footage > AI animation of a real
# photo > AI animation of an AI still > animated graphic > still with a slow push (archival only).
S=[]
def add(beat,sec,kind,intent,desc,source,cost=0.0,**kw): S.append(dict(beat=beat,sec=sec,kind=kind,intent=intent,desc=desc,source=source,cost=cost,**kw))
REUSED="REUSED from the approved first minute (already paid / already cleared) — no new cost"
# b1 — approved first minute (42.25 s), reused as rendered except the two text cards, which become overlays on motion.
add("b1",5.0,"veo-from-pd","A light switches on over pale sediment 3,000 m down","Veo animation of NOAA's public-domain frame of Deep Discoverer lighting the seabed (key ocean-b1-s01-lights-v1). Kept as approved; not regenerated for the particle plume",REUSED,0,first_minute=True,reused=True,cover="Title over this shot: 'The Deep Ocean' / 'What we've seen, what we haven't'")
add("b1",6.7,"pd-photo","'pale sediment, a few scattered stones'","NOAA public-domain photo Expn0686 (cold seep seafloor), slow push",REUSED,0,first_minute=True,reused=True)
add("b1",2.5,"pd-photo","'a small animal drifting through the beam'","NOAA public-domain photo of an Atolla medusa in the ROV lights",REUSED,0,first_minute=True,reused=True)
add("b1",3.9,"veo-from-ai-still","'the vehicle moves on, and the darkness closes behind it'","Veo animation of an AI still (key ocean-b1-s04-recede-v1)",REUSED,0,first_minute=True,reused=True)
add("b1",6.1,"stat-overlay","'One lit patch at a time' — over real ROV footage","Was a black card: now the words sit over real NOAA ROV footage moving along the seafloor (motion under text), citation Bell et al. 2025","NOAA OE video (PD) + overlay — new free asset; the rest of b1 is reused",0,first_minute=True)
add("b1",4.9,"stat-overlay","'More than a quarter mapped' over the ETOPO relief","NOAA NCEI ETOPO relief with a slow lateral move; overlay '28.7% mapped — Seabed 2030, Apr 2026'",REUSED,0,first_minute=True,reused=True)
add("b1",4.5,"card","'Two kinds of knowing' — Mapped · Seen","Short card (4.5 s, 16 words): the words are the picture here",REUSED,0,first_minute=True,reused=True)
add("b1",8.7,"pexels-video","'How do we actually know what is down there?'","Pexels 38178142, ocean surface at dusk",REUSED,0,first_minute=True,reused=True)
# b2 (~43 s)
add("b2",6,"pexels-video","'Below about two hundred metres, sunlight fades away'","Real underwater footage: sun rays fading into blue-black","Pexels: 'underwater sun rays deep blue'",0)
add("b2",7,"graphic","Depth zones: Sunlight 0–200 m -> Twilight 200–1,000 m -> Midnight 1,000–4,000 m -> Abyss 4,000–6,000 m -> Hadal 6,000–11,000 m","Animated descent through the zone limits (NOAA), camera moving down",OWN,0)
add("b2",6,"stat-overlay","'More than 90% of the ocean's volume is deep ocean' (NOAA)","Figure over real footage of a slow descent into dark water","Pexels: 'descending into deep blue water' + overlay",0)
add("b2",6,"data-map","The deep seafloor covers about two thirds of Earth's surface","World map (Natural Earth) with oceans shaded; caption cites Bell et al. 2025",NE,0)
add("b2",5,"card","'Three different measurements' — Mapped · Seen · Volume","Short three-column key (returns in b7)",OWN,0)
add("b2",6,"pd-video","'mapped with modern sonar'","Real NOAA OE multibeam data-acquisition screen recording or 3D fly-through (public domain)","NOAA OE video / Commons webm: 'Okeanos Explorer multibeam' (PD)",0,fallback="veo-from-pd")
add("b2",7,"pd-video","'seen, with a camera or with their own eyes'","Real NOAA OE ROV dive footage over the seafloor (public domain)","NOAA OE video / Commons webm: 'Deep Discoverer dive video' (PD)",0,fallback="veo-from-pd")
# b3 (~143 s)
add("b3",5,"pexels-video","'Take the maps first.'","Real footage: ship bow in open sea (no brand names)","Pexels: 'ship bow open sea'",0)
add("b3",7,"archival-still","'lower a weight on a rope' — HMS Challenger","Public-domain engraving/photo of HMS Challenger (1870s), slow push — archival, not animated","commons: 'HMS Challenger 1872' (PD, 19th-century)",0)
add("b3",6,"archival-still","'a weighted hemp line again and again'","Public-domain plate from the Challenger Report showing sounding gear","commons: 'Challenger Report sounding apparatus' (PD)",0)
add("b3",5,"stat-overlay","'Fewer than 500 deep soundings in 3½ years'","Figure over real footage of rope running through water","Pexels: 'rope underwater' + overlay",0)
add("b3",7,"data-map","1875 sounding: more than 8,000 m, near today's Mariana Trench","Western Pacific map (existing 'marianas' land region) with the 1875 station marked (reduced precision)",NE,0)
add("b3",7,"graphic","Echo sounding: Pulse goes down -> Echo returns -> Time becomes depth","Animated diagram (Meteor-era single beam)",OWN,0)
add("b3",5,"stat-overlay","'Meteor, 1925–27: about 67,000 echo soundings'","Figure over real footage of a ship crossing open ocean","Pexels: 'ship crossing ocean aerial' + overlay",0)
add("b3",8,"graphic","Six echo profiles line up -> A notch at the ridge crest -> A rift valley","Animated diagram built from our own profile drawing (not a copy of the Heezen–Tharp map)",OWN,0)
add("b3",6,"pd-image","'as if the water had been drained away'","NOAA NCEI ETOPO relief of the Atlantic (public domain) with a slow tilt — a modern equivalent, labelled as such","commons: 'NOAA ETOPO Atlantic relief' (PD)",0)
add("b3",6,"pd-video","'Today, most seafloor maps still begin with sound'","Real NOAA footage of Okeanos Explorer at sea","NOAA OE video (PD)",0,fallback="pd-image")
add("b3",8,"graphic","Multibeam sonar: Ship sends a fan of sound -> Echoes return -> Travel time becomes depth","Animated fan-shaped swath diagram",OWN,0)
add("b3",8,"pd-video","'ridges, canyons, and volcanoes that never reach the surface'","Real NOAA 3D multibeam fly-through of a seamount (public domain)","NOAA OE mapping video (PD)",0,fallback="veo-from-pd")
add("b3",6,"graphic","'a strip a few times wider than the water is deep' — swath ≈ 1.3–6× depth","Animated diagram: water depth vs swath width",OWN,0)
add("b3",7,"pd-image","'a map of the entire ocean floor… from space'","NASA/CNES SWOT artist's concept (credit 'NASA/JPL-Caltech'), labelled as illustration","NASA JPL: 'SWOT satellite illustration'",0)
add("b3",9,"graphic","Satellite altimetry: Seamount's gravity pulls water -> Sea surface bulges slightly -> Satellite measures the bump -> Seafloor shape is estimated","Animated diagram",OWN,0)
add("b3",6,"stat-overlay","'Satellites: features around 8 km across'","Figure over real footage of open-ocean swell","Pexels: 'open ocean swell' + overlay",0)
add("b3",6,"pd-video","'a shipwreck, a cold seep, or many smaller hills'","Real NOAA ROV footage of a cold-seep mussel bed","NOAA OE video (PD)",0,fallback="veo-from-pd")
add("b3",7,"stat-overlay","'28.7% of the global seafloor mapped to modern standards' — Seabed 2030, April 2026","Figure over a slowly turning globe of seafloor relief (public-domain NOAA/NASA visualisation; not the b1 ETOPO still)","NOAA/NASA globe bathymetry visualisation (PD) + overlay",0)
add("b3",5,"card","'Mapped = at least one measured depth per grid cell'","Short card; the grid follows",OWN,0)
add("b3",7,"graphic","Grid cells: 100 m (0–1,500 m) -> 200 m -> 400 m -> 800 m (>5,750 m)","Animated grid-cell diagram (GEBCO/Seabed 2030 definition)",OWN,0)
add("b3",6,"pd-video","'It does not tell us what lives there.'","Real NOAA ROV footage: animals on a seamount","NOAA OE video (PD)",0,fallback="veo-from-pd")
# b4 (~101 s)
add("b4",6,"veo-from-ai-still","'Light does not travel far in seawater'","AI animation: a beam fading within a few metres, particles drifting","prompt: realistic deep-sea documentary still, a single white beam of light fading into black water within a few metres, drifting particles, no creatures, no text",STILL+VEO)
add("b4",8,"graphic","Pressure: surface 1 atm -> 1,000 m ≈ 100 atm -> 4,000 m ≈ 400 atm -> 11,000 m ≈ 1,100 atm","Animated descent with the pressure counter",OWN,0)
add("b4",6,"pd-video","'remotely operated vehicles, tethered to a ship'","Real NOAA footage of Deep Discoverer being launched","NOAA OE video (PD); exclude CC BY-SA files",0,fallback="pd-image")
add("b4",6,"pd-video","'scientists on shore can watch its cameras in real time'","Real NOAA footage from the control van / telepresence","NOAA OE video (PD)",0,fallback="pd-image")
add("b4",6,"pd-video","'crewed submersibles, and autonomous vehicles'","Real public-domain footage of a crewed submersible or AUV (NOAA / U.S. Navy)","NOAA / U.S. Navy video (PD)",0,fallback="pd-image")
add("b4",7,"stat-overlay","'About 44,000 dive records · 1958–2024' — Bell et al. 2025","Figure over real ROV footage descending","NOAA OE video (PD) + overlay",0)
add("b4",9,"graphic","'About 3,800 km² seen — roughly 0.001% of the deep seafloor'","Animated scale graphic: a vast dark field and a barely visible speck; 1.5 s of silence after the line",OWN,0)
add("b4",7,"data-map","Seen so far — an area about the size of Rhode Island","Rhode Island at scale (U.S. Census Bureau outline)",NE,0)
add("b4",4,"card","'An estimate' — records are incomplete; some imagery was never shared","Short caveat card",OWN,0)
add("b4",9,"data-map","About two thirds of observations — near the U.S., Japan and New Zealand","Pacific map highlighting three countries",NE,0)
add("b4",6,"stat-overlay","'High seas: most of the ocean — less than a fifth of the dives'","Figure over real open-ocean footage at night","Pexels: 'open ocean night' + overlay",0)
add("b4",7,"pexels-video","'We have mapped more than a quarter…'","Real footage: dark ocean surface at night","Pexels: 'ocean at night dark waves'",0)
add("b4",8,"pd-video","'…We have seen a vanishingly small part of it.'","Real NOAA ROV footage at the edge of its lights, darkness beyond","NOAA OE video (PD)",0,fallback="veo-from-pd")
# b5 (~134 s)
add("b5",7,"veo-from-ai-still","'the darkness is not empty, and it is not entirely dark'","AI animation: scattered blue sparks blinking in black water — an illustration of bioluminescence","prompt: realistic deep-sea documentary still, black water with a few scattered faint blue bioluminescent sparks at different distances, no identifiable animals, no text",STILL+VEO)
add("b5",6,"pd-video","'many animals make their own light'","Real public-domain footage of a bioluminescent display (NOAA). Fallback: AI animation (+still+clip)","NOAA OE video (PD); MBARI excluded (copyrighted)",0,contingentUsd=STILL+VEO)
add("b5",7,"stat-overlay","'240 dives · surface to ~3,900 m · 350,000+ animals' — Martini & Haddock 2017","Figure over real ROV midwater footage","NOAA OE video (PD) + overlay",0)
add("b5",5,"stat-overlay","'About three quarters could produce light (76%)'","Figure over real midwater footage (small animals in the ROV lights)","NOAA OE video (PD) + overlay",0)
add("b5",7,"graphic","Light in seawater: red is absorbed first -> then yellow and green -> blue travels farthest","Animated spectrum/attenuation diagram",OWN,0)
add("b5",7,"veo-from-ai-still","'to erase their own silhouette' (counterillumination)","AI animation of a small silvery fish whose belly lights match faint light from above","prompt: realistic documentary still, small silvery midwater fish seen from below against faint blue light, glowing ventral photophores matching the light, dark water, no text",STILL+VEO)
add("b5",6,"veo-from-ai-still","'A few deep-sea dragonfishes even make red light'","AI animation (was a still): dragonfish gliding with a red light organ beneath the eye","prompt: realistic deep-sea documentary still, dragonfish (Malacosteus-like) in black water, small red light organ below the eye and a faint blue one behind it, no text",STILL+VEO)
add("b5",8,"veo-from-ai-still","'The most famous light in the deep belongs to the anglerfishes'","AI animation: a deep-sea anglerfish swimming slowly through black water, its lure glowing; labelled AI recreation — no public-domain footage of a live ceratioid was found","prompt: realistic deep-sea documentary still, a female deep-sea anglerfish (ceratioid, Melanocetus-like) swimming slowly in black water, a single glowing blue-white lure on a modified fin ray above the mouth, soft falloff, no other animals, no text",STILL+VEO,priority="Hans",overlay="About 160 species of deep-sea anglerfish (Pietsch 2009)")
add("b5",7,"veo-from-ai-still","'It comes from bacteria living inside the lure'","AI animation: extreme close-up of the glowing lure pulsing gently; labelled AI recreation","prompt: realistic macro documentary still, the glowing lure (esca) of a deep-sea anglerfish, translucent bulb with a soft blue-white glow, black background, no text",STILL+VEO,priority="Hans")
add("b5",8,"graphic","Tiny male -> fuses to the female -> immune genes lost (Swann et al. 2020)","Animated scientific diagram (no gore, silhouettes)",OWN,0)
add("b5",7,"graphic","Sonar screen: a 'false bottom' at 300–500 m by day -> rises at night","Animated echogram of the deep scattering layer",OWN,0)
add("b5",7,"pexels-video","'climbing at dusk to feed… sinking again before dawn'","Real footage: ocean surface at dusk turning to night","Pexels: 'ocean dusk to night timelapse'",0)
add("b5",6,"stat-overlay","'Twilight-zone fish: about 2 to 16 billion tonnes' — estimates vary","Figure over real midwater footage with small animals","NOAA OE video (PD) + overlay",0)
add("b5",8,"pd-video","'a slow rain from above… marine snow'","Real NOAA dive footage with marine snow drifting through the lights. Fallback: AI animation","NOAA OE video (PD)",0,contingentUsd=VEO)
add("b5",6,"pd-video","'for many animals in the deep, it is food'","Real NOAA footage of a filter-feeding animal (crinoid, sponge, sea pen)","NOAA OE video (PD)",0,fallback="pd-image")
add("b5",7,"data-map","Monterey Bay — where the 76% figure was measured","Map of Monterey Bay (Natural Earth) — 'one region, not a census'",NE,0)
# b6 (~93 s)
add("b6",6,"pd-video","'the animals themselves'","Real NOAA footage of a deep-sea animal","NOAA OE video (PD)",0,fallback="pd-image")
add("b6",6,"stat-overlay","'1,121 species new to science in one year' — Ocean Census, Apr 2025–Mar 2026","Figure over real footage of a small deep-sea animal","NOAA OE video (PD) + overlay",0)
add("b6",4,"card","'How many remain undescribed? Estimates vary widely.'","Short uncertainty card (no single number)",OWN,0)
add("b6",7,"pd-video","'a steep slope, a seamount or a cold seep worth visiting'","Real NOAA multibeam fly-through dissolving to ROV footage of the same area if available","NOAA OE video (PD)",0,fallback="veo-from-pd")
add("b6",6,"pd-video","'corals, microbes or whole communities'","Real NOAA footage of a deep-sea coral community","NOAA OE video (PD)",0,fallback="veo-from-pd")
add("b6",7,"pd-image","'a camera sled towed over a volcanic rift near the Galápagos'","Public-domain NOAA/WHOI-cleared photo of a towed camera sled or the Galápagos Rift (licence checked per file)","commons: 'ANGUS camera sled' / 'Galapagos Rift 1977' (PD only)",0,fallback="graphic")
add("b6",7,"pd-video","'hot springs crowded with clams, crabs and tube worms'","Real NOAA footage of a hydrothermal vent community (public domain)","NOAA OE / NOAA PMEL vent video (PD)",0,contingentUsd=VEO)
add("b6",5,"stat-overlay","'1977 · about 2,500 m · no biologists aboard'","Figure over the vent footage","same clip + overlay",0)
add("b6",7,"graphic","Energy without sunlight: Vent chemicals -> Microbes -> Tube worms, clams, crabs","Animated food-web diagram (chemosynthesis)",OWN,0)
add("b6",7,"data-map","Challenger Deep, Mariana Trench — about 10,935 m","Western Pacific with the Challenger Deep marked",NE,0)
add("b6",7,"stat-overlay","'10,935 m ± 6 m (2021)' — other surveys differ by tens of metres","Figure over a slow descent into black water (real footage)","Pexels / NOAA (PD) + overlay",0)
add("b6",9,"archival-still","'The first two people reached it in 1960'","U.S. Navy public-domain photo of the bathyscaphe Trieste, slow push — archival","commons: 'Bathyscaphe Trieste US Navy' (PD-USGov-Military-Navy)",0)
add("b6",5,"stat-overlay","'Descent: nearly 5 hours · about 20 minutes on the bottom'","Figure over a second archival Trieste photo","commons (PD) + overlay",0)
# b7 (~44 s)
add("b7",6,"pd-video","'sound and satellites have measured it'","Real NOAA multibeam fly-through (the 'map')","NOAA OE video (PD)",0,fallback="pd-image")
add("b7",6,"pd-video","'cameras and samples have visited small, scattered patches'","Real NOAA ROV footage (the 'visit')","NOAA OE video (PD)",0,fallback="pd-image")
add("b7",7,"stat-overlay","'Mapped: 28.7% · Seen: about 0.001%' — two kinds of knowing","Recap figures over real ROV footage",OWN+" + NOAA OE video (PD)",0)
add("b7",5,"card","'A map tells you that a place exists. An observation is a visit.'","Short card; the one line that is the picture",OWN,0)
add("b7",8,"veo-from-ai-still","'The next time a light switches on three thousand metres down…'","AI animation: lights switch on over untouched sediment — callback to the opening","prompt: realistic deep-sea documentary still, two ROV lights just switching on over untouched pale sediment with a faint animal track, black water beyond, no text",STILL+VEO)
add("b7",5,"card","'Sources: NOAA Ocean Exploration · Seabed 2030 / GEBCO · Bell et al. 2025 · Martini & Haddock 2017 · Ocean Census 2026 · WHOI · Pietsch 2009' — end card","End card with references; channel name 'Earthward Chronicles'",OWN,0)

KIND = {
 "veo-from-pd":("generated_image","AI_RECREATION","veo-clip (reference: public-domain photo)"),
 "veo-from-ai-still":("generated_image","AI_RECREATION","veo-clip (reference: AI still)"),
 "archival-still":("documentary_image","REAL_DOCUMENTARY","commons archival still (public domain, slow push)"),
 "stat-overlay":("stat_overlay","DETERMINISTIC","figure overlaid on moving footage (source named on screen)"),
 "card":("text","DETERMINISTIC","short text card (≤ 5 s)"),
 "ai-still":("generated_image","AI_RECREATION","ai-still (ken burns)"),
 "pd-photo":("documentary_image","REAL_DOCUMENTARY","commons (public domain)"),
 "pd-image":("documentary_image","REAL_DOCUMENTARY","commons / agency (public domain)"),
 "pd-video":("stock_video","REAL_DOCUMENTARY","commons video (public domain)"),
 "pexels-video":("stock_video","STOCK_REAL","pexels-video"),
 "graphic":("diagram","DETERMINISTIC","deterministic graphic"),
 "data-map":("map","DETERMINISTIC","data-map (Natural Earth)"),
}
# Fit each beat to its estimated narration (words ÷ Brian's 3.12 words/s, + planned silences) by stretching only
# the shots that can run longer: never an AI clip (8 s source) nor a text card (kept short on purpose).
import re as _re
_script=json.load(open("ocean-script-001.json"))
PACE=128/41.053
SILENCE={"b4":1.5,"b7":1.2}
for b in _script["beats"]:
    if b["id"]=="b1": continue
    target=len(_re.findall(r"\S+",b["narration"]))/PACE+SILENCE.get(b["id"],0)
    fixed=[x for x in S if x["beat"]==b["id"] and (x["kind"].startswith("veo") or x["kind"]=="card")]
    flex=[x for x in S if x["beat"]==b["id"] and x not in fixed]
    k=(target-sum(x["sec"] for x in fixed))/sum(x["sec"] for x in flex)
    for x in flex: x["sec"]=round(x["sec"]*k,1)
shots=[]; counters={}
for s in S:
    counters[s["beat"]]=counters.get(s["beat"],0)+1
    sid=f'{s["beat"]}-s{counters[s["beat"]]}'
    assetType,hybrid,method=KIND[s["kind"]]
    lic = OWN if s["kind"] in ("graphic","card") else (OWN+"; footage underneath licensed as listed in queryOrPrompt") if s["kind"]=="stat-overlay" else NE if s["kind"]=="data-map" else PEXELS if s["kind"]=="pexels-video" else ("AI-generated for Atomivid (OpenAI image / Google Veo) — "+AI_LABEL) if s["kind"].startswith(("veo","ai")) else PD_NOAA
    if s["kind"]=="veo-from-pd": lic = "Reference photo: "+PD_NOAA+". Animation: AI-generated (Veo) — "+AI_LABEL
    vi = s["intent"]
    if s["kind"]=="graphic" and "->" not in vi and not vi.startswith("'"): vi="'"+vi+"'"
    # Tarjetas de cifra o cita («'texto' — contexto»): tarjeta de texto grande, no un diagrama de un nodo.
    if s["kind"]=="graphic" and "->" not in vi: assetType,method="animated_graphic","deterministic animated graphic"
    motion={"pd-video":"real-footage","pexels-video":"real-footage","veo-from-pd":"ai-animation-of-real-photo","veo-from-ai-still":"ai-animation","graphic":"animated-graphic","data-map":"animated-graphic","stat-overlay":"figure-over-motion","card":"static-text","pd-photo":"still-push","pd-image":"still-push","archival-still":"still-push (archival)","ai-still":"still-push"}[s["kind"]]
    shot={"beatId":s["beat"],"shotId":sid,"durationApprox":s["sec"],"assetType":assetType,"visualIntent":vi,
          "description":s["desc"],"queryOrPrompt":s["source"],"sourceRequirement":method,"hybridClassification":hybrid,
          "licensing":{"status":lic},"estimatedCostUsd":round(s["cost"],2),"aiGenerated":s["kind"].startswith(("veo","ai")),
          "billableVideoSeconds":8 if s["kind"].startswith("veo") and not s.get("reused") else 0,"motion":motion}
    for k in ("reused","fallback","priority","overlay"):
        if s.get(k): shot[k]=s[k]
    if s.get("first_minute"): shot["firstMinute"]=True
    if s.get("cover"): shot["cover"]=s["cover"]
    if s.get("contingentUsd"): shot["contingentUsd"]=s["contingentUsd"]
    shots.append(shot)
# Approved motion-first revision; final sources require independent review.
for shot in shots:
    motion = shot["motion"]
    if motion == "static-text":
        shot.update(assetType="stock_video", motion="figure-over-motion", sourceRequirement="Reviewed real footage (NOAA public domain or licensed stock) with timed overlay")
        shot["description"] = "Short readable figure or statement over relevant moving footage. No full-screen black text card. " + shot["description"]
    elif motion == "still-push":
        shot.update(assetType="stock_video", motion="real-footage", sourceRequirement="Reviewed real footage (NOAA public domain or licensed stock)")
        shot["description"] = "Replace planned still with relevant reviewed video. " + shot["description"]
    elif motion == "animated-graphic":
        if shot["assetType"] == "map":
            shot["motion"] = "map-graphic"
        else:
            shot.update(assetType="stock_video", motion="figure-over-motion", sourceRequirement="Reviewed real footage or scientific animation with short explanatory overlay")
            shot["description"] = "Explain with short timed text over relevant video or a scientific animation, rather than tiny static diagram nodes. " + shot["description"]
tot=round(sum(x["estimatedCostUsd"] for x in shots),2)
fm=round(sum(x["estimatedCostUsd"] for x in shots if x.get("firstMinute")),2)
dur={b:sum(x["durationApprox"] for x in shots if x["beatId"]==b) for b in counters}
doc={"meta":{"videoId":"ocean-deep-001","version":"003","totalShots":len(shots),"format":"1920x1080 (16:9)","language":"en",
 "durationsBasis":"Estimated at Brian's measured pace (b1: 128 words in 41.05 s ≈ 3.1 words/s); b1 uses its real cut times; real scene boundaries are re-cut to the recorded narration's word timings before any paid generation (sample-manifest.ts: cuts only in silences between words).",
 "estimatedSecondsByBeat":dur,"estimatedTotalSeconds":sum(dur.values()),
 "paidItemsUsd":{"total":tot,"firstMinute":fm,"contingent":round(sum(x.get("contingentUsd",0) for x in shots),2)},
 "veoClips":sum(1 for x in shots if x["billableVideoSeconds"]),"veoBillableSeconds":sum(x["billableVideoSeconds"] for x in shots),
 "aiStills":sum(1 for x in shots if x["aiGenerated"] and "ai-still" in x["sourceRequirement"] or "AI still" in x["sourceRequirement"]),
 "assetTypeMapping":"generated_image=AI_RECREATION (production: veo-clip/ai-still in the sample manifest); documentary_image/stock_video=public domain or Pexels; diagram/map/text=deterministic",
 "notReused":"No medieval style, no Pixabay/Eleven Music tracks, no footage or thumbnail from any existing YouTube video."},
 "shots":shots}
json.dump(doc,open("ocean-storyboard-001.json","w"),ensure_ascii=False,indent=2)
doc["meta"]["motionMix"]={m:sum(1 for x in shots if x["motion"]==m) for m in sorted({x["motion"] for x in shots})}
doc["meta"]["cardSecondsMax"]=1.5
doc["meta"]["editorialBasis"]="Approved moving opening and subsequent budget approval. Target real video/animation for all non-map, non-historical shots. This is a source-selection plan, not evidence that assets are already selected or rendered. Maps are reported as graphics, not actual moving footage."
doc["meta"]["estimatedSecondsByMotion"]={m:round(sum(x["durationApprox"] for x in shots if x["motion"]==m),1) for m in doc["meta"]["motionMix"]}
json.dump(doc,open("ocean-storyboard-001.json","w"),ensure_ascii=False,indent=2)
print(len(shots),dur,round(sum(dur.values()),1),tot,fm,doc["meta"]["veoClips"],doc["meta"]["veoBillableSeconds"],doc["meta"]["motionMix"])

import json
VEO=0.96; STILL=0.06
PD_NOAA="Public domain (U.S. Government work, NOAA) — verify per file at candidate review: reject if caption says 'copyright' or licence is CC BY-SA"
PEXELS="Pexels License — free commercial use, no attribution required; not presented as deep-sea footage"
OWN="Deterministic graphic rendered by Atomivid code — no third-party material"
NE="Natural Earth (public domain) — data map rendered by Atomivid code"
AI_LABEL="On-screen label: 'AI illustration' / 'AI animation' — never presented as filmed discovery"
# (beat, secs, kind, intent/visualIntent, method detail, source/query, cost, extra)
S=[]
def add(beat,sec,kind,intent,desc,source,cost=0.0,**kw): S.append(dict(beat=beat,sec=sec,kind=kind,intent=intent,desc=desc,source=source,cost=cost,**kw))
# b1 — first minute (~51 s + opening title)
add("b1",8,"veo-from-pd","A light switches on over pale sediment 3,000 m down","AI animation (Veo 3.1 Fast image-to-video, 8 s, 1080p, audio discarded) of a NOAA public-domain photo: lights sweep across sediment; nothing new is added to the scene","commons: File:Deep Discoverer (51816198671).jpg (NOAA OE, ROV D2 over sedimented seafloor, West Florida Escarpment 2017) — licence to confirm at review",VEO,first_minute=True,cover="Title card over this shot: 'The Deep Ocean' / 'What we've seen — and what we still don't know'")
add("b1",7,"pd-photo","'pale sediment, a few scattered stones'","Slow push on a NOAA public-domain seafloor photo lit by ROV lights","commons search: 'Okeanos Explorer seafloor sediment NOAA' (PD only)",0,first_minute=True)
add("b1",6,"pd-video","'a small animal drifting through the beam'","NOAA public-domain dive video of a medusa in the ROV lights (it is lit by the ROV, NOT bioluminescent — not described as such)","commons: File:Okeanos Explorer PR and USVI Dive 8- Psychedelic Medusa-NOAA-1280x720.webm — licence to confirm",0,first_minute=True)
add("b1",6,"veo-from-ai-still","'the vehicle moves on, and the darkness closes behind it'","AI still (gpt-image-2, 16:9) of an ROV's lights receding into black water, animated with Veo; labelled AI animation","prompt: realistic deep-sea documentary still, a remotely operated vehicle's twin lights receding over dark sediment into black water, fine marine snow in the beams, no text, no creatures, no people",STILL+VEO,first_minute=True)
add("b1",8,"graphic","'One lit patch at a time': dark field -> a few small lit squares -> most of the field stays dark","Deterministic animated graphic: a black field where tiny lit rectangles appear one by one",OWN,0,first_minute=True)
add("b1",8,"pd-image","'More than a quarter of the seafloor has been mapped' — Seabed 2030, April 2026","Global relief image (NOAA NCEI ETOPO, public domain) with a subtle caption","commons/NOAA NCEI: 'ETOPO global relief' PD image — or GEBCO grid render (public domain, attribution 'GEBCO Compilation Group (2025) GEBCO 2025 Grid')",0,first_minute=True)
add("b1",8,"pexels-video","'How do we actually know what is down there?'","Ocean surface from above at dusk, slow drift — a present-day establishing image","Pexels video search: 'aerial ocean surface dusk dark water' (reviewed visually; no logos/boats with branding)",0,first_minute=True)
# b2 (~54 s)
add("b2",7,"pexels-video","'Below about two hundred metres, sunlight fades away'","Sun rays underwater fading to blue-black","Pexels: 'underwater sun rays deep blue'",0)
add("b2",9,"graphic","Ocean depth zones: Sunlight 0–200 m -> Twilight 200–1,000 m -> Midnight 1,000–4,000 m -> Abyss 4,000–6,000 m -> Hadal 6,000–11,000 m","Deterministic diagram (zone names/limits per NOAA)",OWN,0)
add("b2",8,"graphic","'More than 90%' — of the ocean's volume is deep ocean (NOAA)","Proportional bar: surface layer vs deep ocean",OWN,0)
add("b2",7,"data-map","The deep seafloor covers about two thirds of Earth's surface","World map (Natural Earth) with oceans shaded; caption cites Bell et al. 2025",NE,0)
add("b2",8,"graphic","'Three different measurements' — Mapped seafloor · Seen seafloor · Ocean volume","Three-column title card that returns later as the episode's key",OWN,0)
add("b2",7,"pd-image","'mapped with modern sonar'","NOAA OE multibeam bathymetry image","commons/NOAA OE: 'multibeam bathymetry NOAA Okeanos seamount' (PD)",0)
add("b2",8,"pd-image","'seen, with a camera or with their own eyes'","NOAA OE ROV camera frame of the seafloor","commons/NOAA OE: 'Deep Discoverer seafloor NOAA' (PD)",0)
# b3 (~115 s)
add("b3",6,"pexels-video","'Take the maps first.'","Research-style ship at sea (no visible brand names)","Pexels: 'research vessel at sea'",0)
add("b3",10,"graphic","Multibeam sonar: Ship sends a fan of sound -> Echoes return -> Travel time becomes depth","Deterministic animated diagram of a fan-shaped swath",OWN,0)
add("b3",8,"pd-image","'A ship carries a multibeam sonar'","NOAA Ship Okeanos Explorer","commons: File:NOAA R337 Okeanos Explorer.jpg (PD-US-NOAA)",0)
add("b3",10,"pd-image","'ridges, canyons, and volcanoes that never reach the surface'","NOAA OE 3D multibeam render of a seamount/canyon (slow pan)","commons/NOAA OE mapping gallery: 'seamount multibeam 3D NOAA' (PD)",0)
add("b3",7,"graphic","'a strip a few times wider than the water is deep' — swath ≈ 1.3–6× depth","Deterministic diagram: water depth vs swath width",OWN,0)
add("b3",6,"pexels-video","'Mapping a single region can keep a ship busy for weeks.'","Ship wake lines from above","Pexels: 'ship wake aerial open sea'",0)
add("b3",10,"pd-image","'a map of the entire ocean floor… from space'","NASA/CNES SWOT spacecraft illustration (NASA media, credit 'NASA/JPL-Caltech') — an artist's concept, labelled as such","NASA JPL: 'SWOT satellite illustration' (NASA media guidelines: free use with credit, no endorsement)",0)
add("b3",10,"graphic","Satellite altimetry: Seamount's gravity pulls water -> Sea surface bulges slightly -> Satellite measures the bump -> Seafloor shape is estimated","Deterministic diagram",OWN,0)
add("b3",8,"graphic","'Satellite: features around 8 km across' — sonar grid cells: 100–800 m","Scale comparison grid",OWN,0)
add("b3",8,"pd-image","'a shipwreck, a cold seep, or many smaller hills'","NOAA OE photo of a cold-seep mussel bed","commons/NOAA OE: 'cold seep mussels NOAA Okeanos' (PD)",0)
add("b3",12,"graphic","'28.7% of the global seafloor mapped to modern standards' — Seabed 2030, April 2026","Progress bar with source caption; +5 million km² in one year",OWN,0)
add("b3",10,"graphic","'Mapped = at least one measured depth per grid cell' — cells of 100 m (0–1,500 m) · 200 m · 400 m · 800 m (>5,750 m)","Deterministic grid-cell diagram (GEBCO/Seabed 2030 definition)",OWN,0)
add("b3",10,"pd-image","'It does not tell us what lives there.'","NOAA OE photo: animals on a seamount lit by ROV","commons/NOAA OE: 'deep-sea coral seamount NOAA' (PD)",0)
# b4 (~126 s)
add("b4",7,"veo-from-ai-still","'Light does not travel far in seawater'","AI animation: a single beam of light fading within a few metres in dark water, particles drifting","prompt: realistic deep-sea documentary still, a single white beam of light fading into black water within a few metres, drifting particles, no creatures, no text",STILL+VEO)
add("b4",10,"graphic","Pressure: surface 1 atm -> 1,000 m ≈ 100 atm -> 4,000 m ≈ 400 atm -> 11,000 m ≈ 1,100 atm","Deterministic pressure-scale diagram (≈1 atm per 10 m, NOAA)",OWN,0)
add("b4",8,"pd-image","'remotely operated vehicles, tethered to a ship'","NOAA OE photo of ROV Deep Discoverer on deck or being launched (PD only)","commons/NOAA OE: 'Deep Discoverer launch NOAA' — exclude CC BY-SA 'Deep Discoverer on NOAA Ship Okeanos Explorer.jpg'",0)
add("b4",10,"pd-image","'scientists on shore can watch its cameras in real time'","Okeanos Explorer control room / telepresence","commons: File:Control Room of the Okeanos Explorer R337.jpg — licence to confirm",0)
add("b4",8,"pd-image","'crewed submersibles, and autonomous vehicles'","NOAA/U.S. Navy public-domain photo of a crewed submersible or AUV","commons: 'autonomous underwater vehicle NOAA' / 'DSV submersible US Navy' (PD only)",0)
add("b4",10,"graphic","'43,681 dive records · 1958–2024' — Bell et al., Science Advances, 2025","Timeline of dive records",OWN,0)
add("b4",12,"graphic","'About 3,800 km² seen — roughly 0.001% of the deep seafloor'","Scale graphic: a vast dark square with a barely visible bright speck; music drops to silence here",OWN,0)
add("b4",8,"data-map","Seen so far — an area about the size of Rhode Island","Rhode Island outline at scale (Natural Earth admin-1)",NE,0)
add("b4",8,"graphic","'An estimate' — records are incomplete; some imagery was never shared","Uncertainty card (authors' caveat)",OWN,0)
add("b4",12,"data-map","About two thirds of observations — near the U.S., Japan and New Zealand","World map highlighting three countries",NE,0)
add("b4",9,"graphic","'High seas: most of the ocean — less than a fifth of the dives'","Two-bar comparison",OWN,0)
add("b4",12,"pexels-video","'We have mapped more than a quarter…'","Dark ocean surface at night, slow","Pexels: 'ocean at night dark waves'",0)
add("b4",12,"pd-image","'…We have seen a vanishingly small part of it.'","NOAA OE ROV frame at the edge of its lights, darkness beyond","commons/NOAA OE: 'ROV lights darkness seafloor' (PD)",0)
# b5 (~86 s)
add("b5",8,"veo-from-ai-still","'the darkness is not empty, and it is not entirely dark'","AI animation: scattered blue points of light blinking in black water — an illustration of bioluminescence, not footage","prompt: realistic deep-sea documentary still, black water with a few scattered faint blue bioluminescent sparks at different distances, no identifiable animals, no text",STILL+VEO)
add("b5",8,"pd-image","'many animals make their own light'","Public-domain photo of a bioluminescent deep-sea animal (NOAA). Fallback if none PD: AI still labelled 'AI illustration' (+$0.06)","commons/NOAA OE: 'bioluminescence NOAA Ocean Exploration' (PD); MBARI imagery excluded (copyrighted)",0,contingentUsd=STILL)
add("b5",8,"graphic","'240 dives · surface to ~3,900 m · 350,000+ animals' — Martini & Haddock 2017 (MBARI)","Data card",OWN,0)
add("b5",8,"graphic","'About three quarters could produce light' (76%)","Proportion graphic",OWN,0)
add("b5",8,"graphic","Light in seawater: red is absorbed first -> then yellow and green -> blue travels farthest","Deterministic spectrum/attenuation diagram",OWN,0)
add("b5",10,"veo-from-ai-still","'to erase their own silhouette against the faint glow from above' (counterillumination)","AI animation of a small silvery fish whose belly lights match faint light from above, labelled AI animation","prompt: realistic scientific illustration style, small silvery midwater fish seen from below against faint blue light, glowing ventral photophores matching the light, dark water, no text",STILL+VEO)
add("b5",7,"ai-still","'A few deep-sea dragonfishes even make red light'","AI illustration (still, slow push) of a dragonfish with a red light organ beneath the eye, labelled AI illustration","prompt: realistic scientific illustration, deep-sea dragonfish (Malacosteus-like) in black water, small red light organ below the eye and a faint blue one behind it, no text",STILL)
add("b5",10,"pd-video","'a slow rain from above… marine snow'","NOAA OE dive video with marine snow drifting through the lights. Fallback: AI still (+$0.06)","commons/NOAA OE: 'marine snow Okeanos video' (PD)",0,contingentUsd=STILL)
add("b5",9,"pd-image","'for many animals in the deep, it is food'","NOAA OE photo of a filter-feeding animal (e.g. sponge, crinoid, sea pen)","commons/NOAA OE: 'crinoid NOAA Okeanos' (PD)",0)
add("b5",10,"data-map","Monterey Bay — where the 76% figure was measured","Map of Monterey Bay, California (Natural Earth) — 'one region, not a census'",NE,0)
# b6 (~72 s)
add("b6",7,"pd-image","'the animals themselves'","NOAA OE photo of a deep-sea animal (clearly credited)","commons/NOAA OE: 'deep-sea animal NOAA Okeanos 2025 expedition' (PD)",0)
add("b6",9,"graphic","'1,121 species new to science in one year' — Ocean Census, Apr 2025–Mar 2026","Data card",OWN,0)
add("b6",7,"graphic","'How many remain undescribed? Estimates vary widely.'","Uncertainty card (no single number shown)",OWN,0)
add("b6",10,"pd-image","'a steep slope, a seamount or a cold seep worth visiting'","NOAA OE multibeam of a seamount, then dissolve to the same area's ROV photo if available","commons/NOAA OE (PD)",0)
add("b6",9,"pd-image","'corals, microbes or whole communities'","NOAA OE photo of a deep-sea coral community","commons: File:ROV and coral - Retriever Seamount.jpg — licence to confirm",0)
add("b6",8,"data-map","Challenger Deep, Mariana Trench — about 10,935 m","Map of the western Pacific with the Challenger Deep marked (≈11.37°N, 142.59°E, reduced precision)",NE,0)
add("b6",10,"graphic","'10,935 m ± 6 m (2021)' — other surveys differ by tens of metres","Error-bar graphic with the 2021 estimate and a band for other surveys",OWN,0)
add("b6",12,"pd-image","'The first people reached it in 1960.'","U.S. Navy public-domain photo of the bathyscaphe Trieste","commons: 'Bathyscaphe Trieste US Navy' (PD-USGov-Military-Navy)",0)
# b7 (~55 s)
add("b7",8,"pd-image","'sound and satellites have measured it'","NOAA multibeam map (the 'map')","commons/NOAA OE (PD)",0)
add("b7",8,"pd-image","'cameras and samples have visited small, scattered patches'","NOAA OE ROV frame (the 'visit')","commons/NOAA OE (PD)",0)
add("b7",10,"graphic","'Mapped: 28.7% · Seen: about 0.001%' — two kinds of knowing","Side-by-side recap of the three-measurement card",OWN,0)
add("b7",7,"graphic","'A map tells you that a place exists. An observation is a visit.'","Text card",OWN,0)
add("b7",12,"veo-from-ai-still","'The next time a light switches on three thousand metres down…'","AI animation: lights switch on over untouched sediment with a faint animal track — callback to the opening, labelled AI animation","prompt: realistic deep-sea documentary still, two ROV lights just switching on over untouched pale sediment with a faint animal track, black water beyond, no text",STILL+VEO)
add("b7",10,"graphic","'Sources: NOAA Ocean Exploration · Seabed 2030 / GEBCO · Bell et al. 2025 · Martini & Haddock 2017 · Ocean Census 2026' — end card","End card with references",OWN,0)

KIND = {
 "veo-from-pd":("generated_image","AI_RECREATION","veo-clip (reference: public-domain photo)"),
 "veo-from-ai-still":("generated_image","AI_RECREATION","veo-clip (reference: AI still)"),
 "ai-still":("generated_image","AI_RECREATION","ai-still (ken burns)"),
 "pd-photo":("documentary_image","REAL_DOCUMENTARY","commons (public domain)"),
 "pd-image":("documentary_image","REAL_DOCUMENTARY","commons / agency (public domain)"),
 "pd-video":("stock_video","REAL_DOCUMENTARY","commons video (public domain)"),
 "pexels-video":("stock_video","STOCK_REAL","pexels-video"),
 "graphic":("diagram","DETERMINISTIC","deterministic graphic"),
 "data-map":("map","DETERMINISTIC","data-map (Natural Earth)"),
}
shots=[]; counters={}
for s in S:
    counters[s["beat"]]=counters.get(s["beat"],0)+1
    sid=f'{s["beat"]}-s{counters[s["beat"]]}'
    assetType,hybrid,method=KIND[s["kind"]]
    lic = OWN if s["kind"]=="graphic" else NE if s["kind"]=="data-map" else PEXELS if s["kind"]=="pexels-video" else ("AI-generated for Atomivid (OpenAI image / Google Veo) — "+AI_LABEL) if s["kind"].startswith(("veo","ai")) else PD_NOAA
    if s["kind"]=="veo-from-pd": lic = "Reference photo: "+PD_NOAA+". Animation: AI-generated (Veo) — "+AI_LABEL
    vi = s["intent"]
    if s["kind"]=="graphic" and "->" not in vi and not vi.startswith("'"): vi="'"+vi+"'"
    # Tarjetas de cifra o cita («'texto' — contexto»): tarjeta de texto grande, no un diagrama de un nodo.
    if s["kind"]=="graphic" and "->" not in vi: assetType,method="text","none (deterministic text card — source named on the card)"
    shot={"beatId":s["beat"],"shotId":sid,"durationApprox":s["sec"],"assetType":assetType,"visualIntent":vi,
          "description":s["desc"],"queryOrPrompt":s["source"],"sourceRequirement":method,"hybridClassification":hybrid,
          "licensing":{"status":lic},"estimatedCostUsd":round(s["cost"],2),"aiGenerated":s["kind"].startswith(("veo","ai")),
          "billableVideoSeconds":8 if s["kind"].startswith("veo") else 0}
    if s.get("first_minute"): shot["firstMinute"]=True
    if s.get("cover"): shot["cover"]=s["cover"]
    if s.get("contingentUsd"): shot["contingentUsd"]=s["contingentUsd"]
    shots.append(shot)
tot=round(sum(x["estimatedCostUsd"] for x in shots),2)
fm=round(sum(x["estimatedCostUsd"] for x in shots if x.get("firstMinute")),2)
dur={b:sum(x["durationApprox"] for x in shots if x["beatId"]==b) for b in counters}
doc={"meta":{"videoId":"ocean-deep-001","version":"001","totalShots":len(shots),"format":"1920x1080 (16:9)","language":"en",
 "durationsBasis":"Estimated at ~2.5 words/s; real scene boundaries are re-cut to the recorded narration's word timings before any paid generation (sample-manifest.ts: cuts only in silences between words).",
 "estimatedSecondsByBeat":dur,"estimatedTotalSeconds":sum(dur.values()),
 "paidItemsUsd":{"total":tot,"firstMinute":fm,"contingent":round(sum(x.get("contingentUsd",0) for x in shots),2)},
 "veoClips":sum(1 for x in shots if x["billableVideoSeconds"]),"veoBillableSeconds":sum(x["billableVideoSeconds"] for x in shots),
 "aiStills":sum(1 for x in shots if x["aiGenerated"] and "ai-still" in x["sourceRequirement"] or "AI still" in x["sourceRequirement"]),
 "assetTypeMapping":"generated_image=AI_RECREATION (production: veo-clip/ai-still in the sample manifest); documentary_image/stock_video=public domain or Pexels; diagram/map/text=deterministic",
 "notReused":"No medieval style, no Pixabay/Eleven Music tracks, no footage or thumbnail from any existing YouTube video."},
 "shots":shots}
json.dump(doc,open("ocean-storyboard-001.json","w"),ensure_ascii=False,indent=2)
print(len(shots),dur,sum(dur.values()),tot,fm,doc["meta"]["veoClips"],doc["meta"]["veoBillableSeconds"])

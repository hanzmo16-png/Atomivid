import json, re
SOURCES = [
 {"id":"seabed2030-2026","title":"Seabed 2030 — Global seabed mapping reaches new milestone as five million square kilometres added in a year (20 Apr 2026)","kind":"primary","locator":"https://seabed2030.org/2026/04/20/global-seabed-mapping-reaches-new-milestone-as-five-million-square-kilometres-added-in-a-year/","notes":"28.7% of the global seafloor mapped to modern standards; ~104 million km²; almost 5 million km² added in one year (record). Page fetch blocked by this environment's network policy; figures confirmed through the IHO/IOC/Hydro International coverage of the same announcement and NOAA's current page."},
 {"id":"noaa-explored","title":"NOAA Ocean Exploration — How much of the ocean has been explored?","kind":"primary","locator":"https://oceanexplorer.noaa.gov/ocean-fact/explored/","notes":"Current page (2026): 28.7% of the global seafloor mapped with modern high-resolution technology as of April 2026; about 56% of the seafloor beneath U.S. waters; explorers have seen less than 0.001% of the deep seafloor, roughly the size of Rhode Island. Direct fetch blocked here; content read through search snippets. The archived copy (archive.oceanexplorer.noaa.gov, frozen Jan 2025, 'not maintained') still says 'more than 80% unmapped, unobserved and unexplored' — outdated, NOT used."},
 {"id":"noaa-mapping","title":"NOAA Ocean Exploration — Seafloor Mapping explainer; Multibeam Sonar","kind":"primary","locator":"https://oceanexplorer.noaa.gov/explainers/mapping/ ; https://oceanexplorer.noaa.gov/technology/sonar-multibeam/","notes":"Multibeam sends a fan of sound pulses; swath width roughly 1.3–6× water depth depending on system (DOSITS, NOAA fact sheet)."},
 {"id":"gebco-definition","title":"GEBCO / Seabed 2030 — definition of 'mapped' (grid resolutions by depth)","kind":"primary","locator":"https://seabed2030.gebco.net/faq/ ; https://iho.int/uploads/user/Inter-Regional%20Coordination/GEBCO/SCUFN/MISC/GEBCO_Seabed2023_Grid_Resolutions.pdf","notes":"A grid cell counts as mapped if it contains at least one sounding; cell size 100 m (0–1,500 m), 200 m (1,500–3,000 m), 400 m (3,000–5,750 m), 800 m (5,750–11,000 m)."},
 {"id":"swot-2024","title":"Yu, Sandwell & Dibarboure (2024), Science — SWOT one-year seafloor gravity/bathymetry","kind":"primary","locator":"https://www.aviso.altimetry.fr/en/news/idm/2024/may-2024-swot-measurements-help-in-seafloor-mapping.html","notes":"Satellite altimetry infers seafloor shape from sea-surface height (gravity); SWOT data resolve structures at ~8 km."},
 {"id":"noaa-deep","title":"NOAA — What is the 'deep' ocean? / Ocean Today: The Deep Ocean","kind":"primary","locator":"https://oceanexplorer.noaa.gov/ocean-fact/deep-ocean/ ; https://oceantoday.noaa.gov/deepocean/","notes":"Deep ocean = below ~200 m; more than 90% of the ocean's volume and of Earth's habitable space."},
 {"id":"bell-2025","title":"Bell, K.L.C. et al. (2025) How little we've seen: A visual coverage estimate of the deep seafloor. Science Advances, 7 May 2025. doi:10.1126/sciadv.adp8602","kind":"primary","locator":"https://www.science.org/doi/10.1126/sciadv.adp8602","notes":"43,681 visual dive records deeper than 200 m, 1958–2024; ~3,823 km² imaged; <0.001% of the deep seafloor; 65% of observations within 200 nm of the US, Japan and New Zealand; 19.1% of dives on the high seas (≈58% of the ocean); deep seafloor ≈66% of Earth's surface. Full text on PMC (PMC12057672) blocked here; figures from the journal abstract, ODL press release and EurekAlert."},
 {"id":"noaa-pressure","title":"NOAA PMEL — Pressure at depth","kind":"primary","locator":"https://www.pmel.noaa.gov/eoi/nemo1998/education/pressure.html","notes":"Pressure increases by about one atmosphere per 10 m of depth."},
 {"id":"noaa-d2","title":"NOAA Ocean Exploration — ROV Deep Discoverer; Okeanos Explorer telepresence","kind":"primary","locator":"https://oceanexplorer.noaa.gov/technology/subs-deep-discoverer/","notes":"Rated to 6,000 m; live video relayed by satellite to scientists ashore; companion vehicle Seirios; Okeanos Explorer multibeam since 2008."},
 {"id":"martini-haddock-2017","title":"Martini, S. & Haddock, S.H.D. (2017) Quantification of bioluminescence from the surface to the deep sea demonstrates its predominance as an ecological trait. Scientific Reports 7:45750; MBARI news release","kind":"primary","locator":"https://www.mbari.org/news/new-study-shows-that-three-quarters-of-deep-sea-animals-make-their-own-light/","notes":"240 ROV dives in and around Monterey Canyon, surface to ~3,900 m; >350,000 animals >1 cm annotated; 76% capable of bioluminescence. MBARI page fetch blocked here; figures via MBARI news/EurekAlert/ScienceDaily."},
 {"id":"biolum-color","title":"Smithsonian Ocean Portal — Bioluminescence; Monterey Bay Aquarium — Illuminating the facts of deep-sea bioluminescence; MBARI Know Your Ocean: Bioluminescence","kind":"secondary","locator":"https://ocean.si.edu/ocean-life/fish/bioluminescence ; https://www.mbari.org/know-your-ocean/bioluminescence/","notes":"Most deep-sea bioluminescence is blue (≈470 nm travels farthest in seawater); uses: defence (startle), luring prey, mates, counterillumination; some dragonfishes (e.g. Malacosteus) emit and see red light."},
 {"id":"noaa-marinesnow","title":"NOAA — What is marine snow?","kind":"primary","locator":"https://oceanservice.noaa.gov/facts/marinesnow.html ; https://oceanexplorer.noaa.gov/ocean-fact/marinesnow/","notes":"Shower of organic material (dead plankton, faecal matter, dust) sinking from upper waters; can take weeks to reach the bottom; primary food for many deep-sea animals."},
 {"id":"ocean-census-2026","title":"Ocean Census — press release (May 2026): 1,121 new marine species in one year","kind":"primary","locator":"https://oceancensus.org/press-release-scientists-discover-over-1100-new-marine-species-in-landmark-ocean-census/","notes":"1 Apr 2025–31 Mar 2026: 1,121 species new to science; specimens from as deep as 6,575 m. Estimates of undescribed species vary widely (Ocean Census cites 'up to 90%'; other estimates differ) — presented only as uncertainty."},
 {"id":"greenaway-2021","title":"Greenaway, S.F. et al. (2021) Revised depth of the Challenger Deep from submersible transects. Deep-Sea Research I 178:103644","kind":"primary","locator":"https://repository.library.noaa.gov/view/noaa/33477","notes":"10,935 m ±6 m (95% CI). Another 2021 estimate differs by ~48 m; a 2026 Scientific Data paper (R/V Hakuho-maru EM124) tests depth-estimate sensitivity."},
 {"id":"trieste-1960","title":"U.S. Navy History and Heritage Command — H-041-6: Bathyscaphe Trieste's Deep Dive","kind":"primary","locator":"https://www.history.navy.mil/about-us/leadership/director/directors-corner/h-grams/h-gram-041/h-041-6.html","notes":"23 January 1960, Jacques Piccard and Don Walsh reach the Challenger Deep."},
]
BEATS = [
 dict(id="b1", type="hook", section="Opening — a light in the dark",
  purpose="Open on a camera lighting a small patch of seafloor; set up the tension between 'mapped' and 'seen'; pose the question.",
  emotionalTone="tension", patternInterrupt=True,
  narration=("A light switches on, three thousand metres below the surface. "
   "For a few seconds, it shows a patch of seafloor about the size of a living room: pale sediment, a few scattered stones, a small animal drifting through the beam. "
   "Then the vehicle moves on, and the darkness closes behind it. "
   "Almost everything we have ever seen of the deep sea was seen like this, one lit patch at a time. "
   "And yet we also say that more than a quarter of the seafloor has now been mapped. "
   "Both statements are true. They describe two very different kinds of knowing. "
   "So how do we actually know what is down there? "
   "And what is the difference between having a map of a place and having truly looked at it?"),
  claims=[
   ("A camera 'lit patch' is a few metres across — framed as an illustrative scene, not a specific dive", "inference", []),
   ("More than a quarter of the seafloor has been mapped (28.7%, April 2026)", "sourced", ["seabed2030-2026","noaa-explored"]),
   ("Most deep-sea visual observation has been made by cameras and observers on dives", "sourced", ["bell-2025"]),
  ]),
 dict(id="b2", type="setup", section="Three different measurements",
  purpose="Define the deep ocean and separate the three metrics: mapped seafloor, observed seafloor, water volume.",
  emotionalTone="curiosity",
  narration=("Start with scale. Below about two hundred metres, sunlight fades away, and scientists call what lies beneath the deep ocean. "
   "By volume, it is most of the ocean, more than ninety percent of it. Its floor covers roughly two thirds of the planet's entire surface. "
   "When people ask how much of all that has been explored, they are usually mixing three different measurements. "
   "One is how much of the seafloor has been mapped with modern sonar. "
   "Another is how much of the seafloor anyone has actually seen, with a camera or with their own eyes. "
   "And the third is the water itself: the enormous volume between the surface and the bottom, the largest living space on Earth. "
   "Those three numbers are not interchangeable. Keep them apart, and the deep ocean starts to make sense."),
  claims=[
   ("Deep ocean begins around 200 m, where sunlight fades", "sourced", ["noaa-deep"]),
   ("Deep ocean is more than 90% of ocean volume and of Earth's habitable space", "sourced", ["noaa-deep"]),
   ("Deep seafloor covers about two thirds of Earth's surface", "sourced", ["bell-2025"]),
   ("Public 'explored' figures often conflate mapped area, observed area and volume", "inference", ["noaa-explored","bell-2025"]),
  ]),
 dict(id="b3", type="discovery", section="What a map reveals — and what it does not",
  purpose="Explain ship multibeam sonar, satellite-derived bathymetry, the 28.7% figure and what 'mapped' means.",
  emotionalTone="wonder",
  narration=("Take the maps first. "
   "Most modern seafloor maps begin with sound. A ship carries a multibeam sonar, which sends a fan of sound pulses toward the bottom and listens for their echoes. "
   "The time each echo takes to return becomes a depth. As the ship moves, it sweeps a strip of seafloor a few times wider than the water is deep, and line by line, a landscape appears: ridges, canyons, and volcanoes that never reach the surface. "
   "It is slow work. Mapping a single region can keep a ship busy for weeks. "
   "There is also a map of the entire ocean floor, and it comes from space. Satellites measure tiny bumps in the height of the sea surface, caused by the pull of mountains and trenches far below. "
   "From those bumps, researchers can estimate the shape of the seafloor everywhere at once. The newest satellite data can pick out features around eight kilometres across. "
   "That is a remarkable achievement. It is also far too coarse to show a shipwreck, a cold seep, or many smaller hills. "
   "So when an international effort called Seabed twenty thirty reports its progress, it counts the more detailed kind of map. "
   "In April twenty twenty-six, it reported that twenty-eight point seven percent of the global seafloor had been mapped to that standard, after a record of almost five million square kilometres was added in a single year. "
   "Even here, the word mapped has a precise meaning. The seafloor is divided into grid cells, and a cell counts once it contains at least one measured depth. "
   "In deep water, those cells are hundreds of metres wide. "
   "A map tells us where the ground rises and falls. It does not tell us what lives there."),
  claims=[
   ("Multibeam sonar sends a fan of sound pulses and measures echo travel time", "sourced", ["noaa-mapping"]),
   ("Swath is a few times wider than the water depth (≈1.3–6× depending on system)", "sourced", ["noaa-mapping"]),
   ("Mapping a region can take a ship weeks", "inference", ["noaa-mapping"]),
   ("Satellites infer seafloor shape from sea-surface height caused by gravity", "sourced", ["swot-2024"]),
   ("Newest satellite (SWOT) data resolve features at ~8 km", "sourced", ["swot-2024"]),
   ("28.7% mapped by April 2026; almost 5 million km² added in a year (record)", "sourced", ["seabed2030-2026","noaa-explored"]),
   ("A grid cell counts as mapped with at least one sounding; deep cells are 400–800 m", "sourced", ["gebco-definition"]),
  ]),
 dict(id="b4", type="escalation", section="Why seeing is so hard",
  purpose="Light, pressure and vehicles; the 0.001% visual-coverage estimate, its caveats and geographic bias.",
  emotionalTone="tension",
  narration=("Seeing is a different problem. "
   "Light does not travel far in seawater, so cameras have to be brought close, usually within a few metres of whatever they are filming. "
   "That means sending a vehicle into an environment that is dark, cold, and crushing. For every ten metres of depth, the pressure rises by roughly one more atmosphere. "
   "At four thousand metres, not far from the ocean's average depth, it is around four hundred times the pressure we feel at the surface. "
   "Most deep-sea observation is done by remotely operated vehicles, tethered to a ship by a cable that carries power and live video. "
   "NOAA's Deep Discoverer, for example, is rated to six thousand metres, and scientists on shore can watch its cameras in real time and ask the pilots to stop, turn, or collect a sample. "
   "There are also crewed submersibles, and autonomous vehicles that survey on their own and come back with images. "
   "In twenty twenty-five, a team of researchers tried to add up how much seafloor all of this has actually shown us. "
   "They gathered records from about forty-four thousand deep-sea dives, from nineteen fifty-eight to twenty twenty-four, and estimated the area that cameras and observers had covered. "
   "Their answer was about three thousand eight hundred square kilometres. That is roughly one thousandth of one percent of the deep seafloor, an area about the size of the U.S. state of Rhode Island. "
   "The authors are careful to call it an estimate. Records are incomplete, and some imagery was never shared. "
   "They also found that about two thirds of these observations were made within two hundred nautical miles of just three countries: the United States, Japan and New Zealand. "
   "The high seas, which cover most of the ocean, received less than a fifth of the dives. "
   "We have mapped more than a quarter of the seafloor. We have seen a vanishingly small part of it."),
  claims=[
   ("Light attenuates quickly in seawater; imaging requires proximity (a few metres)", "inference", ["biolum-color"]),
   ("Pressure rises ~1 atm per 10 m; ~400 atm at 4,000 m", "sourced", ["noaa-pressure"]),
   ("Deep Discoverer rated to 6,000 m; telepresence to scientists ashore", "sourced", ["noaa-d2"]),
   ("~44,000 (43,681) dive records 1958–2024; ~3,823 km²; <0.001% of deep seafloor", "sourced", ["bell-2025"]),
   ("Comparable to the size of Rhode Island (NOAA's framing)", "sourced", ["noaa-explored"]),
   ("Estimate with incomplete records — authors' caveat", "sourced", ["bell-2025"]),
   ("65% of observations within 200 nm of the US, Japan, New Zealand; 19.1% of dives on the high seas", "sourced", ["bell-2025"]),
  ]),
 dict(id="b5", type="twist", section="Life and light in the dark",
  purpose="Bioluminescence (76% in Monterey), why blue, what it is used for, red-light dragonfishes, marine snow; limits of the evidence.",
  emotionalTone="wonder", patternInterrupt=True,
  narration=("And yet the darkness is not empty, and it is not entirely dark. "
   "Far below the reach of sunlight, many animals make their own light. "
   "At the Monterey Bay Aquarium Research Institute in California, scientists reviewed video from two hundred and forty robotic dives, from the surface down to almost four thousand metres, and counted more than three hundred and fifty thousand animals. "
   "About three quarters of them were capable of producing light. "
   "Most of that light is blue, the colour that travels farthest through seawater. "
   "Animals use it in different ways: to startle a predator, to lure prey, to find a mate, or to erase their own silhouette against the faint glow from above. "
   "A few deep-sea dragonfishes even make red light, which most animals around them cannot see. "
   "Much of this life depends on a slow rain from above: fragments of dead plankton, waste and dust, sinking for days or even weeks. "
   "Scientists call it marine snow. In a camera's lights it looks like a blizzard, and for many animals in the deep, it is food. "
   "These observations come from particular places, recorded with particular tools. "
   "The Monterey figure describes the animals that were filmed there. It is a strong clue about the deep ocean as a whole, not a census of it."),
  claims=[
   ("240 ROV dives, surface to ~3,900 m, >350,000 animals, 76% bioluminescent (Monterey region)", "sourced", ["martini-haddock-2017"]),
   ("Blue light travels farthest in seawater; most deep-sea bioluminescence is blue", "sourced", ["biolum-color"]),
   ("Functions: startle, lure, mates, counterillumination", "sourced", ["biolum-color"]),
   ("Some dragonfishes emit red light invisible to most animals", "sourced", ["biolum-color"]),
   ("Marine snow: sinking organic debris, can take weeks; food for deep-sea animals", "sourced", ["noaa-marinesnow"]),
   ("Monterey result is regional, not a global census", "inference", ["martini-haddock-2017"]),
  ]),
 dict(id="b6", type="insight", section="What researchers are still looking for",
  purpose="Undescribed species (Ocean Census), what maps point to but cannot confirm, and uncertainty even in the deepest depth.",
  emotionalTone="curiosity",
  narration=("So what are researchers still looking for? "
   "First, the animals themselves. New marine species are still being described at a steady pace. "
   "One global programme, the Ocean Census, reported more than eleven hundred species new to science in a single year, some collected more than six thousand metres down. "
   "How many remain undescribed is genuinely uncertain, and published estimates vary widely. "
   "Second, the places in between. A detailed map can point to a steep slope, a seamount or a cold seep worth visiting. "
   "But only a camera or a sample can show whether corals, microbes or whole communities are living there. "
   "And third, precision itself. Even the deepest known point in the ocean, the Challenger Deep in the Mariana Trench, does not have one agreed depth. "
   "A careful study published in twenty twenty-one put it at ten thousand nine hundred and thirty-five metres, give or take about six metres, while other surveys have produced figures that differ by tens of metres. "
   "The first people reached it in nineteen sixty. More than six decades later, we are still refining the number."),
  claims=[
   ("Ocean Census: 1,121 new species Apr 2025–Mar 2026; some from >6,000 m", "sourced", ["ocean-census-2026"]),
   ("Number of undescribed marine species is uncertain; estimates vary widely", "sourced", ["ocean-census-2026"]),
   ("Maps identify targets (slopes, seamounts, seeps) that need visual/sample confirmation", "inference", ["noaa-mapping","bell-2025"]),
   ("Challenger Deep 10,935 m ±6 m (2021); other estimates differ by tens of metres", "sourced", ["greenaway-2021"]),
   ("First descent 1960 (Piccard & Walsh, Trieste)", "sourced", ["trieste-1960"]),
  ]),
 dict(id="b7", type="payoff", section="Closing — a map and a visit",
  purpose="Answer the opening question and close on the recurring image of one lit patch at a time.",
  emotionalTone="reflective",
  narration=("So, how do we know what is down there? "
   "We know the shape of much of the seafloor because sound and satellites have measured it, and for more than a quarter of it, in real detail. "
   "We know something about what lives there because cameras and samples have visited small, scattered patches, most of them close to a few coastlines. "
   "And between those two kinds of knowledge lies most of the deep ocean: charted in outline, but never actually seen. "
   "A map tells you that a place exists. An observation is a visit. "
   "The next time a light switches on three thousand metres down, it may well reveal a patch of seafloor that no one has ever looked at before. "
   "For now, that is still how the deep ocean is explored: one lit patch at a time."),
  claims=[
   ("Synthesis of b3–b6", "inference", ["seabed2030-2026","bell-2025"]),
  ]),
]
beats=[]
for b in BEATS:
    beats.append({"id":b["id"],"type":b["type"],"sectionTitle":b["section"],"purpose":b["purpose"],"narration":b["narration"],
      "claims":[{"id":f'{b["id"]}-c{i+1}',"text":t,"support":s,"sourceIds":ids} for i,(t,s,ids) in enumerate(b["claims"])],
      "emotionalTone":b["emotionalTone"],**({"patternInterrupt":True} if b.get("patternInterrupt") else {})})
words=sum(len(re.findall(r"\S+",b["narration"])) for b in BEATS)
chars=sum(len(b["narration"]) for b in BEATS)
per=[(b["id"],len(re.findall(r"\S+",b["narration"])),len(b["narration"])) for b in BEATS]
doc={"meta":{"videoId":"ocean-deep-001","version":"001","topic":"The Deep Ocean: What We've Seen—and What We Still Don't Know","workingTitle":"The Deep Ocean: What We've Seen—and What We Still Don't Know",
 "narrativeQuestion":"How do we know what is in the deep ocean, and what is the difference between having a map of a place and having actually observed it?",
 "language":"en","mode":"curiosity_documentary","status":"DRAFT FOR APPROVAL — not narrated, no paid calls",
 "authoredBy":"Written directly in English in this session from independent sources (no translation or paraphrase of any existing video script).",
 "wordCount":words,"characterCount":chars,"perBeat":[{"id":i,"words":w,"characters":c} for i,w,c in per],
 "isFixtureContent":False,
 "metricDiscipline":"Mapped seafloor (area, sonar ≥ grid standard), observed seafloor (area imaged by cameras/eyes) and ocean volume are kept separate everywhere; no sentence converts one into another.",
 "outdatedFigureAvoided":"NOAA archived page (Jan 2025) '>80% unmapped, unobserved and unexplored' — superseded; not used."},
 "researchPack":{"sources":SOURCES},"beats":beats}
json.dump(doc,open("ocean-script-001.json","w"),ensure_ascii=False,indent=2)
print(words,chars,per)

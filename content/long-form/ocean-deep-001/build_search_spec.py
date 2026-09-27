"""Genera docs/quality/ocean-deep-001/search-spec.json desde el storyboard:
una entrada por plano con material real (Pexels o Commons de dominio público),
más la foto de referencia del plano b1-s1. Búsqueda gratuita; encontrar no es
aprobar (cada candidato se revisa visualmente y por licencia)."""
import json, re, pathlib

here = pathlib.Path(__file__).parent
sb = json.loads((here / "ocean-storyboard-001.json").read_text())

# Consultas explícitas por plano (inglés; Commons solo dominio público).
Q = {
  # b1: only the new overlay background (the rest of the first minute is reused as approved).
  "b1-s5": ([], ["Deep Discoverer ROV seafloor NOAA Okeanos", "NOAA Okeanos Explorer ROV dive seafloor"]),
  "b2-s1": (["underwater sun rays deep blue", "light rays underwater descending"], []),
  "b2-s3": (["descending into deep blue water", "deep blue water underwater dark"], []),
  "b2-s6": ([], ["multibeam bathymetry NOAA Okeanos seamount", "NOAA multibeam sonar seafloor map"]),
  "b2-s7": ([], ["Deep Discoverer dive NOAA seafloor", "NOAA ROV Deep Discoverer dive"]),
  "b3-s1": (["ship bow open sea", "ship open ocean aerial"], []),
  "b3-s2": ([], ["HMS Challenger 1872", "HMS Challenger ship engraving"]),
  "b3-s3": ([], ["Challenger Report sounding apparatus", "HMS Challenger sounding machine"]),
  "b3-s4": (["rope underwater", "rope sinking in water"], []),
  "b3-s7": (["ship crossing ocean aerial", "cargo ship open ocean drone"], []),
  "b3-s9": ([], ["NOAA ETOPO Atlantic relief", "Atlantic Ocean bathymetry NOAA relief"]),
  "b3-s10": ([], ["NOAA R337 Okeanos Explorer", "NOAA Ship Okeanos Explorer"]),
  "b3-s12": ([], ["seamount multibeam 3D NOAA", "NOAA bathymetry seamount 3D"]),
  "b3-s14": ([], ["SWOT satellite", "Surface Water and Ocean Topography satellite NASA"]),
  "b3-s16": (["open ocean swell", "ocean swell aerial"], []),
  "b3-s17": ([], ["cold seep mussels NOAA Okeanos", "NOAA methane seep mussels"]),
  "b3-s18": ([], ["global bathymetry globe NOAA", "ocean floor relief globe NASA"]),
  "b3-s21": ([], ["deep-sea coral seamount NOAA", "NOAA deep sea coral Okeanos"]),
  "b4-s3": ([], ["Deep Discoverer launch NOAA", "ROV Deep Discoverer recovery Okeanos"]),
  "b4-s4": ([], ["Control Room of the Okeanos Explorer R337", "NOAA Okeanos Explorer control room"]),
  "b4-s5": ([], ["autonomous underwater vehicle NOAA", "DSV Alvin US Navy"]),
  "b4-s6": ([], ["NOAA ROV descending water column", "Okeanos Explorer ROV descent"]),
  "b4-s11": (["open ocean night", "dark sea night aerial"], []),
  "b4-s12": (["ocean at night dark waves", "dark sea night"], []),
  "b4-s13": ([], ["ROV lights darkness seafloor NOAA", "NOAA ROV lights deep sea"]),
  "b5-s2": ([], ["bioluminescence NOAA Ocean Exploration", "bioluminescent NOAA deep sea"]),
  "b5-s3": ([], ["NOAA midwater ROV jellyfish", "Okeanos Explorer midwater siphonophore"]),
  "b5-s4": ([], ["NOAA Okeanos midwater animals", "NOAA ctenophore deep sea"]),
  "b5-s12": (["ocean dusk to night timelapse", "sea sunset to night"], []),
  "b5-s13": ([], ["NOAA lanternfish", "NOAA midwater fish Okeanos"]),
  "b5-s14": ([], ["marine snow Okeanos", "marine snow NOAA deep sea"]),
  "b5-s15": ([], ["crinoid NOAA Okeanos", "sea lily NOAA deep sea"]),
  "b6-s1": ([], ["NOAA Okeanos deep-sea animal 2025", "NOAA Ocean Exploration new species"]),
  "b6-s2": ([], ["NOAA Okeanos sponge deep sea", "NOAA Ocean Exploration octopus deep"]),
  "b6-s4": ([], ["NOAA seamount multibeam cold seep", "NOAA Okeanos seep ROV"]),
  "b6-s5": ([], ["ROV and coral - Retriever Seamount", "NOAA ROV coral seamount"]),
  "b6-s6": ([], ["ANGUS camera sled", "Galapagos Rift 1977 hydrothermal"]),
  "b6-s7": ([], ["hydrothermal vent tubeworms NOAA", "Riftia pachyptila NOAA"]),
  "b6-s8": ([], ["hydrothermal vent clams NOAA", "Galapagos Rift vent NOAA"]),
  "b6-s11": (["descending into dark water", "deep dark water underwater"], []),
  "b6-s12": ([], ["Bathyscaphe Trieste US Navy", "Trieste bathyscaphe 1960 Challenger Deep"]),
  "b6-s13": ([], ["Trieste bathyscaphe 1959", "Trieste Piccard Walsh 1960"]),
  "b7-s1": ([], ["NOAA Okeanos multibeam map", "NOAA Ocean Exploration bathymetry map"]),
  "b7-s2": ([], ["NOAA Okeanos ROV seafloor survey", "NOAA Ocean Exploration seafloor"]),
  "b7-s3": ([], ["NOAA Okeanos ROV sediment", "Deep Discoverer seafloor lights"]),
}

scenes = []
for shot in sb["shots"]:
    if shot["shotId"] not in Q:
        continue
    pexels, commons = Q[shot["shotId"]]
    scenes.append({"id": shot["shotId"], "passage": shot["visualIntent"], "pexels": pexels, "commons": commons})

missing = [s["shotId"] for s in sb["shots"] if (s["hybridClassification"] in ("REAL_DOCUMENTARY", "STOCK_REAL") or s["assetType"] == "stat_overlay") and s["shotId"] not in Q and not s.get("reused")]
assert not missing, missing

spec = {
  "requestId": "ocean-deep-001",
  "note": "v002 — Commons search only returns bitmaps: real NOAA dive VIDEO needs the commons-video support planned in PLAN.md §12 (until then these queries find stills for review). Candidate searches per shot (free: Pexels API + Wikimedia Commons, public domain only). Finding is not approving: every candidate is reviewed visually and its licence re-read on the file page (reject captions saying 'copyright', CC BY-SA, MBARI). Passage = shot intent; exact cut times come from the real narration (PART=words).",
  "scenes": scenes,
}
out = here.parent.parent.parent / "docs/quality/ocean-deep-001/search-spec.json"
out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
print(len(scenes), "scenes ->", out)

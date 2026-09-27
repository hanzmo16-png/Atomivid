"""Genera docs/quality/ocean-deep-001/search-spec.json desde el storyboard:
una entrada por plano con material real (Pexels o Commons de dominio público),
más la foto de referencia del plano b1-s1. Búsqueda gratuita; encontrar no es
aprobar (cada candidato se revisa visualmente y por licencia)."""
import json, re, pathlib

here = pathlib.Path(__file__).parent
sb = json.loads((here / "ocean-storyboard-001.json").read_text())

# Consultas explícitas por plano (inglés; Commons solo dominio público).
Q = {
  "b1-s1": ([], ["Deep Discoverer (51816198671)", "Deep Discoverer ROV seafloor lights NOAA"]),
  "b1-s2": ([], ["Okeanos Explorer seafloor sediment NOAA", "NOAA Ocean Exploration abyssal plain"]),
  "b1-s3": ([], ["Okeanos Explorer Psychedelic Medusa webm", "NOAA Okeanos jellyfish video"]),
  "b1-s6": ([], ["ETOPO global relief", "GEBCO world bathymetry"]),
  "b1-s7": (["aerial ocean surface dusk dark water", "open ocean aerial evening"], []),
  "b2-s1": (["underwater sun rays deep blue", "light rays underwater descending"], []),
  "b2-s6": ([], ["multibeam bathymetry NOAA Okeanos seamount", "NOAA multibeam sonar seafloor map"]),
  "b2-s7": ([], ["Deep Discoverer seafloor NOAA", "NOAA ROV Deep Discoverer dive"]),
  "b3-s1": (["research vessel at sea", "ship open ocean aerial"], []),
  "b3-s3": ([], ["NOAA R337 Okeanos Explorer", "NOAA Ship Okeanos Explorer"]),
  "b3-s4": ([], ["seamount multibeam 3D NOAA", "NOAA bathymetry seamount 3D"]),
  "b3-s6": (["ship wake aerial open sea", "vessel wake ocean drone"], []),
  "b3-s7": ([], ["SWOT satellite", "Surface Water and Ocean Topography satellite NASA"]),
  "b3-s10": ([], ["cold seep mussels NOAA Okeanos", "NOAA methane seep mussels"]),
  "b3-s13": ([], ["deep-sea coral seamount NOAA", "NOAA deep sea coral Okeanos"]),
  "b4-s3": ([], ["Deep Discoverer launch NOAA", "ROV Deep Discoverer recovery Okeanos"]),
  "b4-s4": ([], ["Control Room of the Okeanos Explorer R337", "NOAA Okeanos Explorer control room"]),
  "b4-s5": ([], ["autonomous underwater vehicle NOAA", "DSV Alvin US Navy"]),
  "b4-s12": (["ocean at night dark waves", "dark sea night"], []),
  "b4-s13": ([], ["ROV lights darkness seafloor NOAA", "NOAA ROV lights deep sea"]),
  "b5-s2": ([], ["bioluminescence NOAA Ocean Exploration", "bioluminescent NOAA deep sea"]),
  "b5-s8": ([], ["marine snow Okeanos", "marine snow NOAA deep sea"]),
  "b5-s9": ([], ["crinoid NOAA Okeanos", "sea lily NOAA deep sea"]),
  "b6-s1": ([], ["NOAA Okeanos deep-sea animal 2025", "NOAA Ocean Exploration new species"]),
  "b6-s4": ([], ["NOAA Okeanos sponge deep sea", "NOAA Ocean Exploration octopus deep"]),
  "b6-s5": ([], ["ROV and coral - Retriever Seamount", "NOAA ROV coral seamount"]),
  "b6-s8": ([], ["Bathyscaphe Trieste US Navy", "Trieste bathyscaphe 1960 Challenger Deep"]),
  "b7-s1": ([], ["NOAA Okeanos ROV seafloor survey", "NOAA Ocean Exploration seafloor"]),
  "b7-s2": ([], ["NOAA Okeanos Explorer at sea sunset", "NOAA Ocean Exploration ship deck"]),
}

scenes = []
for shot in sb["shots"]:
    if shot["shotId"] not in Q:
        continue
    pexels, commons = Q[shot["shotId"]]
    scenes.append({"id": shot["shotId"], "passage": shot["visualIntent"], "pexels": pexels, "commons": commons})

missing = [s["shotId"] for s in sb["shots"] if s["hybridClassification"] in ("REAL_DOCUMENTARY", "STOCK_REAL") and s["shotId"] not in Q]
assert not missing, missing

spec = {
  "requestId": "ocean-deep-001",
  "note": "Candidate searches per shot (free: Pexels API + Wikimedia Commons, public domain only). Finding is not approving: every candidate is reviewed visually and its licence re-read on the file page (reject captions saying 'copyright', CC BY-SA, MBARI). Passage = shot intent; exact cut times come from the real narration (PART=words).",
  "scenes": scenes,
}
out = here.parent.parent.parent / "docs/quality/ocean-deep-001/search-spec.json"
out.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
print(len(scenes), "scenes ->", out)

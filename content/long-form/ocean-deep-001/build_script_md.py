"""Versión legible del guion (SCRIPT.md) desde ocean-script-001.json y el
storyboard: narración por sección, hechos con fuente, incertidumbres,
inferencias de encuadre, recreaciones IA y referencias de cada sección."""
import json, pathlib

here = pathlib.Path(__file__).parent
s = json.loads((here / "ocean-script-001.json").read_text())
sb = json.loads((here / "ocean-storyboard-001.json").read_text())
src = {x["id"]: x for x in s["researchPack"]["sources"]}

# Afirmaciones que el guion presenta explícitamente como inciertas o acotadas.
UNCERTAIN = {"b4-c6", "b5-c6", "b6-c2", "b6-c4"}

out = [f"# {s['meta']['topic']}", "",
       f"Script for approval: {s['meta']['wordCount']} words, {s['meta']['characterCount']} characters, English (voice-over).",
       f"Question: *{s['meta']['narrativeQuestion']}*", "",
       f"Metric discipline: {s['meta']['metricDiscipline']}", "",
       f"Superseded figure not used: {s['meta']['outdatedFigureAvoided']}", "",
       "Structure: a cold open (b1) followed by six narrative sections (b2–b7, the last one being the close). Numbers are written the way they are spoken so the voice reads them correctly.", ""]
for i, b in enumerate(s["beats"]):
    label = "Cold open" if i == 0 else f"Section {i}"
    title = b["sectionTitle"].split(" — ", 1)[-1] if i == 0 else b["sectionTitle"]
    words = len(b["narration"].split())
    out += [f"## {label} — {title} (`{b['id']}`, {words} words, tone: {b['emotionalTone']})", "", b["narration"], ""]
    facts = [c for c in b["claims"] if c["support"] == "sourced" and c["id"] not in UNCERTAIN]
    unc = [c for c in b["claims"] if c["id"] in UNCERTAIN]
    inf = [c for c in b["claims"] if c["support"] == "inference" and c["id"] not in UNCERTAIN]
    rec = [x for x in sb["shots"] if x["beatId"] == b["id"] and x["aiGenerated"]]
    def cite(c): return ", ".join(f"[{i}]" for i in c["sourceIds"]) if c["sourceIds"] else "framing"
    if facts: out += ["**Facts (sourced)**", ""] + [f"- {c['text']} — {cite(c)}" for c in facts] + [""]
    if unc: out += ["**Stated uncertainty / limits**", ""] + [f"- {c['text']} — {cite(c)}" for c in unc] + [""]
    if inf: out += ["**Inference or framing (no figure attached)**", ""] + [f"- {c['text']}" for c in inf] + [""]
    if rec: out += ["**AI recreations on screen (labelled \"AI recreation\")**", ""] + [f"- `{x['shotId']}`: {x['visualIntent']}" for x in rec] + [""]
    ids = sorted({i for c in b["claims"] for i in c["sourceIds"]})
    if ids: out += ["**References**", ""] + [f"- [{i}] {src[i]['title']} — {src[i]['locator']}" for i in ids] + [""]
out += ["## All sources", ""] + [f"- [{x['id']}] ({x['kind']}) {x['title']} — {x['locator']}. {x['notes']}" for x in s["researchPack"]["sources"]]
(here.parent.parent.parent / "docs/quality/ocean-deep-001/SCRIPT.md").write_text("\n".join(out) + "\n")

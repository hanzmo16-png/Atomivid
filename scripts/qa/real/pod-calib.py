# Calibración/verificación del verificador visual REAL (scripts/podcast-3-0/verify-images.py de la rama del estudio)
# sobre imágenes etiquetadas a mano (revisión visual del 2026-10-28). USD 0. Imprime cada veredicto y la matriz de
# confusión; falla si alguna imagen ajena se acepta o si se rechaza alguna pertinente.
# Uso: python3 pod-calib.py items.json   (items: [{"image","label":"ok|ajena","expected","topic","name"}])
import json, os, subprocess, sys, tempfile
items = json.load(open(sys.argv[1]))
tmp = tempfile.mkdtemp()
inp, out = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
json.dump({"topic": items[0]["topic"], "items": [{"image": i["image"], "expected": i["expected"]} for i in items]}, open(inp, "w"), ensure_ascii=False)
r = subprocess.run([sys.executable, "scripts/podcast-3-0/verify-images.py", inp, out], capture_output=True, text=True)
if r.returncode != 0: print("FAILED", r.stderr[-800:]); sys.exit(1)
v = json.load(open(out))["verdicts"]
cm = {"ok_aceptada": 0, "ok_rechazada": 0, "ajena_aceptada": 0, "ajena_rechazada": 0}
for it, x in zip(items, v):
    cm[f"{it['label']}_{'aceptada' if x['ok'] else 'rechazada'}"] += 1
    print("CALIB", json.dumps({"name": it["name"], "label": it["label"], "ok": x["ok"], "score": x["score"], "object": x.get("object"), "objectP": x.get("objectP"), "reason": x["reason"]}, ensure_ascii=False))
print("CONFUSION", json.dumps(cm))
bad = cm["ajena_aceptada"] + cm["ok_rechazada"]
print(f"{'PASS' if bad == 0 else 'FAIL'} verificador: {cm['ajena_rechazada']} ajenas rechazadas, {cm['ok_aceptada']} pertinentes aceptadas, {bad} errores")
FINAL_BAD = bad

# --- Variantes candidatas del detector (análisis; no cambia el veredicto anterior) ---
if os.environ.get("CALIB_VARIANTS") == "1":
    from PIL import Image
    from sentence_transformers import SentenceTransformer, util
    m = SentenceTransformer("clip-ViT-B-32")
    ns = {}; exec(open("scripts/podcast-3-0/verify-images.py").read().split("def main")[0], ns)
    OBJ = list(ns["OBJETOS"])
    N1 = ["a painting or digital illustration of a scene", "an ancient artifact, ruin, statue, relief or monument", "a historical or documentary scene", "a scientific image or diagram"]
    N2 = N1 + ["a natural landscape with mountains, desert or sea"]
    N3 = N1 + ["a photograph of people or objects related to the story being told"]
    ims = m.encode([Image.open(i["image"]).convert("RGB") for i in items], convert_to_tensor=True, normalize_embeddings=True)
    for name, neutral in [("N1", N1), ("N2", N2), ("N3", N3)]:
        t = m.encode(OBJ + neutral, convert_to_tensor=True, normalize_embeddings=True)
        worst_ok, best_ajena = 0.0, 1.0
        for it, k in zip(items, range(len(items))):
            p = (util.cos_sim(ims[k:k+1], t)[0] * 100).softmax(dim=0); op = float(p[: len(OBJ)].max())
            if it["label"] == "ok": worst_ok = max(worst_ok, op)
            else: best_ajena = min(best_ajena, op)
            print("VARIANT", name, it["name"], it["label"], round(op, 3), OBJ[int(p[: len(OBJ)].argmax())])
        print("VARIANT_SUMMARY", name, json.dumps({"maxOk": round(worst_ok, 3), "minAjena": round(best_ajena, 3), "separa": worst_ok < best_ajena}))

sys.exit(1 if FINAL_BAD else 0)

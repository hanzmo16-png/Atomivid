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
sys.exit(1 if bad else 0)

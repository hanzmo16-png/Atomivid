# Calibración del verificador visual (USD 0): imágenes del episodio original etiquetadas a mano (revisión visual del
# 2026-10-28) + la ilustración Recraft del fragmento. Para cada una imprime las puntuaciones de varias reglas candidatas:
#  A) la actual (multilingüe: lo esperado gana a todos los rivales y p ≥ 0,35);
#  B) A + margen mínimo de similitud sobre el mejor rival;
#  C) A + detector de objetos ajenos con el codificador de texto NATIVO de CLIP (inglés): rechaza si un objeto ajeno
#     gana claramente a «una escena/obra relacionada con el tema».
# Uso: python3 pod-calib.py items.json  (items: [{"image","label":"ok|ajena","expected","topic","name"}])
import json, sys
from PIL import Image
from sentence_transformers import SentenceTransformer, util
sys.path.insert(0, "scripts/podcast-3-0")
items = json.load(open(sys.argv[1]))
img_model = SentenceTransformer("clip-ViT-B-32")
txt_model = SentenceTransformer("sentence-transformers/clip-ViT-B-32-multilingual-v1")
src = open("scripts/podcast-3-0/verify-images.py").read()
ns = {}; exec(src.split("def main")[0], ns); AJENOS = ns["AJENOS"]
EN = ["a bicycle", "an airplane", "easter eggs", "potted plants in a nursery", "a crop field with green plants", "clothes in a shop",
      "a gift box with a welcome note", "people talking in a modern restaurant or meeting", "a modern office desk with papers and a bottle",
      "a woman posing in lingerie", "a person wearing modern clothes", "a car on a street", "a mobile phone", "food on a plate", "a sign with text",
      "an empty sky at dusk"]
NEUTRAL = "ancient Mesopotamian art: stone reliefs, statues, ruins, clay tablets or an ancient scene"
imgs = img_model.encode([Image.open(i["image"]).convert("RGB") for i in items], convert_to_tensor=True, normalize_embeddings=True)
en_txt = img_model.encode(EN + [NEUTRAL], convert_to_tensor=True, normalize_embeddings=True)
rows = []
for k, it in enumerate(items):
    own = [it["expected"], it["topic"]]; labels = own + AJENOS
    t = txt_model.encode(labels, convert_to_tensor=True, normalize_embeddings=True)
    s = util.cos_sim(imgs[k:k+1], t)[0]; p = (s * 100).softmax(dim=0)
    bo = max(float(s[0]), float(s[1])); ri = max(range(2, len(labels)), key=lambda j: float(s[j])); br = float(s[ri])
    e = util.cos_sim(imgs[k:k+1], en_txt)[0]; ep = (e * 100).softmax(dim=0)
    eo = max(range(len(EN)), key=lambda j: float(e[j]))
    rows.append({"name": it["name"], "label": it["label"], "ownP": round(float(p[:2].sum()), 3), "own": round(bo, 4), "rival": labels[ri], "rivalSim": round(br, 4),
                 "margin": round(bo - br, 4), "enTop": EN[eo], "enTopP": round(float(ep[eo]), 3), "enNeutralP": round(float(ep[-1]), 3)})
for r in rows: print("CALIB", json.dumps(r, ensure_ascii=False))

"""Verificación VISUAL de las ilustraciones del podcast (sin coste, sin proveedores): mira cada imagen con CLIP y la
compara con lo que debe mostrar su turno y con una lista de cosas AJENAS al tema (las que aparecieron con el banco de
fotos: avión, huevos de Pascua, bicicleta, plantas de vivero, ropa, regalo…). Las palabras del prompt no prueban lo
que muestra la imagen: el veredicto sale del contenido visual.

Uso: python3 verify-images.py ENTRADA.json SALIDA.json
  ENTRADA: {"topic": "...", "items": [{"image": "ruta", "expected": "qué debe verse (es)"}]}
  SALIDA:  {"verdicts": [{"ok": bool, "reason": "...", "score": float, "rival": "..."}]}
Modelos abiertos: clip-ViT-B-32 (imagen) + clip-ViT-B-32-multilingual-v1 (texto en español en el mismo espacio).
Regla: se acepta si lo esperado (o el tema) gana a TODAS las alternativas ajenas y su probabilidad (softmax con la
escala de CLIP) es al menos 0,35; si no, se rechaza nombrando la alternativa que ganó.
"""
import json, sys
from PIL import Image
import torch
from sentence_transformers import SentenceTransformer, util

AJENOS = [
    "un avión comercial en un aeropuerto", "huevos de Pascua decorados", "una bicicleta", "plantas en macetas de un vivero",
    "ropa en una tienda", "una caja de regalo con un letrero de bienvenida", "una oficina moderna con computadoras",
    "un coche en una calle", "un teléfono móvil", "comida en un plato", "una persona posando en lencería", "un cartel con texto",
    # Escenas actuales genéricas (escaneo del episodio original, 2026-10-28: dos hombres en un restaurante moderno y un
    # escritorio con papeles pasaban por «pertinentes» a un tema de historia antigua).
    "personas conversando en un restaurante o una reunión moderna", "un escritorio moderno con papeles, bolígrafos y una botella",
    "un campo de cultivo con plantas verdes", "una persona con ropa moderna",
    # Imagen casi vacía (un cielo al atardecer sin nada reconocible) pasaba por pertinente en el episodio recompuesto.
    "un cielo casi vacío al atardecer, sin objetos reconocibles",
]

# Segunda regla (calibrada el 2026-10-28 con 35 imágenes etiquetadas a mano, run 40770470472): detector de objetos
# ajenos con el codificador de texto NATIVO de CLIP (en inglés, más preciso que el multilingüe para objetos) frente a lo
# que debe mostrar el turno. Una silueta de bicicleta recortada contra el cielo pasaba la primera regla (p=0,91) y aquí da
# «an empty sky at dusk» 0,52 / «a bicycle» 0,99. Umbral: ajenas ≥ 0,51, pertinentes ≤ 0,27 → 0,40.
OBJETOS = ["a bicycle", "an airplane", "easter eggs", "potted plants in a nursery", "a crop field with green plants", "clothes in a shop",
           "a gift box with a welcome note", "people talking in a modern restaurant or meeting", "a modern office desk with papers and a bottle",
           "a woman posing in lingerie", "a person wearing modern clothes", "a car on a street", "a mobile phone", "food on a plate",
           "a sign with text", "an empty sky at dusk"]
OBJETO_MAX = 0.40


def main():
    data = json.load(open(sys.argv[1]))
    items, topic = data["items"], data.get("topic", "")
    img_model = SentenceTransformer("clip-ViT-B-32")
    txt_model = SentenceTransformer("sentence-transformers/clip-ViT-B-32-multilingual-v1")
    imgs = img_model.encode([Image.open(i["image"]).convert("RGB") for i in items], convert_to_tensor=True, normalize_embeddings=True)
    obj_txt = img_model.encode(OBJETOS, convert_to_tensor=True, normalize_embeddings=True)
    verdicts = []
    for k, it in enumerate(items):
        own = [it["expected"]] + ([topic] if topic else [])
        labels = own + AJENOS
        txt = txt_model.encode(labels, convert_to_tensor=True, normalize_embeddings=True)
        sims = util.cos_sim(imgs[k:k + 1], txt)[0]
        probs = (sims * 100).softmax(dim=0)
        best_own = max(range(len(own)), key=lambda j: float(sims[j]))
        rival = max(range(len(own), len(labels)), key=lambda j: float(sims[j]))
        own_p = float(probs[: len(own)].sum())
        first = float(sims[best_own]) > float(sims[rival]) and own_p >= 0.35
        # Detector: lo esperado (multilingüe, mismo espacio de CLIP) contra los objetos ajenos (codificador nativo).
        obj_sims = util.cos_sim(imgs[k:k + 1], obj_txt)[0]
        mixed = (torch.cat([sims[: len(own)], obj_sims]) * 100).softmax(dim=0)
        oi = max(range(len(OBJETOS)), key=lambda j: float(mixed[len(own) + j]))
        obj_p = float(mixed[len(own) + oi])
        ok = first and obj_p < OBJETO_MAX
        reason = "" if ok else (f"la imagen se parece más a «{labels[rival]}» que a lo pedido (p={own_p:.2f})" if not first
                                else f"se reconoce un objeto ajeno al tema: «{OBJETOS[oi]}» (p={obj_p:.2f})")
        verdicts.append({"ok": ok, "score": round(own_p, 3), "rival": labels[rival], "object": OBJETOS[oi], "objectP": round(obj_p, 3), "reason": reason})
    json.dump({"verdicts": verdicts}, open(sys.argv[2], "w"), ensure_ascii=False)
    print(json.dumps({"n": len(items), "ok": sum(v["ok"] for v in verdicts)}))


if __name__ == "__main__":
    main()

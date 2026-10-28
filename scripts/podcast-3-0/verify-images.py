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

# Segunda regla (calibrada el 2026-10-28 con 35 imágenes etiquetadas a mano, runs 40770470472/40771551917): detector de
# objetos ajenos con el codificador de texto NATIVO de CLIP (inglés, más preciso que el multilingüe para objetos), frente
# a etiquetas NEUTRAS genéricas (sin depender del tema). Una silueta de bicicleta recortada contra el cielo pasaba la
# primera regla (p=0,91); aquí «an empty sky at dusk» da 0,49. Pertinentes ≤ 0,22 · ajenas ≥ 0,49 → umbral 0,35.
# Un objeto que el propio tema o turno menciona (p. ej. un episodio sobre bicicletas) no cuenta como ajeno.
OBJETOS = {"a bicycle": ["bicicleta", "ciclismo"], "an airplane": ["avion", "aviacion", "aeropuerto", "vuelo"], "easter eggs": ["pascua", "huevo"],
           "potted plants in a nursery": ["planta", "vivero", "jardin"], "a crop field with green plants": ["cultivo", "agricult", "cosecha", "campo"],
           "clothes in a shop": ["ropa", "moda", "tienda"], "a gift box with a welcome note": ["regalo"],
           "people talking in a modern restaurant or meeting": ["restaurante", "reunion", "negocio", "empresa"],
           "a modern office desk with papers and a bottle": ["oficina", "escritorio"], "a woman posing in lingerie": ["lenceria", "moda"],
           "a person wearing modern clothes": ["moda", "ropa"], "a car on a street": ["coche", "auto", "automovil", "calle"],
           "a mobile phone": ["telefono", "celular", "movil", "smartphone"], "food on a plate": ["comida", "cocina", "receta", "gastronom"],
           "a sign with text": ["cartel", "letrero", "tipografia"], "an empty sky at dusk": ["cielo", "atardecer", "anochecer", "meteor", "astronom"]}
NEUTRAS = ["a painting or digital illustration of a scene", "an ancient artifact, ruin, statue, relief or monument",
           "a historical or documentary scene", "a scientific image or diagram"]
OBJETO_MAX = 0.35


def _plain(t):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFKD", t.lower()) if not unicodedata.combining(c))


def main():
    data = json.load(open(sys.argv[1]))
    items, topic = data["items"], data.get("topic", "")
    img_model = SentenceTransformer("clip-ViT-B-32")
    txt_model = SentenceTransformer("sentence-transformers/clip-ViT-B-32-multilingual-v1")
    imgs = img_model.encode([Image.open(i["image"]).convert("RGB") for i in items], convert_to_tensor=True, normalize_embeddings=True)
    obj_names = list(OBJETOS)
    obj_txt = img_model.encode(obj_names + NEUTRAS, convert_to_tensor=True, normalize_embeddings=True)
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
        # Detector: objetos ajenos frente a etiquetas neutras (codificador nativo); se ignoran los que el tema menciona.
        context = _plain(" ".join(own))
        allowed = [j for j, n in enumerate(obj_names) if not any(w in context for w in OBJETOS[n])]
        op = (util.cos_sim(imgs[k:k + 1], obj_txt)[0] * 100).softmax(dim=0)
        oi = max(allowed, key=lambda j: float(op[j])) if allowed else 0
        obj_p = float(op[oi]) if allowed else 0.0
        ok = first and obj_p < OBJETO_MAX
        reason = "" if ok else (f"la imagen se parece más a «{labels[rival]}» que a lo pedido (p={own_p:.2f})" if not first
                                else f"se reconoce un objeto ajeno al tema: «{obj_names[oi]}» (p={obj_p:.2f})")
        verdicts.append({"ok": ok, "score": round(own_p, 3), "rival": labels[rival], "object": obj_names[oi], "objectP": round(obj_p, 3), "reason": reason})
    json.dump({"verdicts": verdicts}, open(sys.argv[2], "w"), ensure_ascii=False)
    print(json.dumps({"n": len(items), "ok": sum(v["ok"] for v in verdicts)}))


if __name__ == "__main__":
    main()

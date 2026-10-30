# Podcast Studio — nueva presentadora del catálogo (concepto, sin alta productiva)

Estado: **concepto**. No se ha generado ninguna imagen, no se ha llamado a ningún proveedor (HeyGen, Recraft, OpenAI
Images, ElevenLabs) y no existe ningún avatar productivo. Gasto: USD 0. Generar los recursos requiere un presupuesto
autorizado por Hans (ver «Coste estimado»).

## 1. Identidad (sintética y original)

| Campo | Valor |
|---|---|
| Nombre de personaje | **Renata Olmedo** (personaje virtual de Atomicvid; nombre inventado, sin referencia a una persona real) |
| Rol | Anfitriona |
| Perfil visual | Mujer latina de 30–35 años, piel bronceada, cabello negro largo y con movimiento, ojos grandes y expresivos, rasgos armónicos; apariencia elegante y profesional |
| Vestuario | Blazer de color sólido (vino o verde botella, para separarse de los tres estudios), blusa lisa, joyería mínima (aretes pequeños) |
| Estilo de conversación | Cálida y segura; conduce con ritmo, hace preguntas concretas y cierra cada bloque con una idea clara |
| Personalidad (guion) | «Directa y cálida; pregunta lo que el oyente quiere saber y resume en una frase» |
| Diferencia con el catálogo actual | Valeria = cercana/curiosa; Ximena = serena/pausada; Víctor = divulgador. Renata = conductora con ritmo, para temas de actualidad y entrevistas |

Reglas de identidad:
- **No** se parte de la foto de una persona real ni se pide «parecida a» nadie (actrices, presentadoras, influencers).
  El prompt describe rasgos genéricos, nunca nombres.
- Antes de darla de alta se compara la imagen final con las de Valeria y Ximena para evitar parecidos (no debe confundirse
  con ellas en un plano general).
- En la interfaz se presenta como «personaje virtual de Atomicvid», igual que Víctor: sin credenciales profesionales.

## 2. Retrato (lo que necesita el estudio)

Lección de F2 (episodio 51883d1c): cuando el retrato del proveedor corta hombros y brazos, el recorte tiene un borde
recto que hay que «extender» y en los planos medios se nota. El retrato de Renata debe evitarlo desde el origen:

- Encuadre **de cintura para arriba**, de frente, mirada a cámara, **los dos hombros y los antebrazos completos dentro
  del cuadro** (margen ≥ 8 % a cada lado), manos apoyadas en una mesa fuera de plano o juntas a la altura de la cintura.
- Cara entre el 18 % y el 24 % del alto de la imagen, centrada en horizontal, ojos en el tercio superior.
- Fondo liso y neutro (gris medio), luz suave frontal + contraluz ligero (pelo negro separado del fondo para un recorte
  RVM limpio). Sin pelo sobre los hombros que se confunda con el fondo.
- Resolución mínima 1536×2048 (vertical), JPEG/PNG sin marcas de agua.
- Expresión neutra-amable con la boca cerrada (el lip-sync parte de ella).

Prompt de referencia (para cuando haya presupuesto; descripción genérica, sin nombres):
> Retrato fotográfico realista de una presentadora de podcast latina de unos 32 años, piel bronceada, cabello negro largo
> ondulado, ojos grandes y expresivos, maquillaje natural, blazer vino liso sobre blusa crema, aretes pequeños. Plano de
> cintura para arriba, de frente, mirando a cámara, hombros y antebrazos completos dentro del encuadre, manos juntas a la
> altura de la cintura. Fondo gris liso, iluminación suave de estudio con contraluz. Fotografía profesional, 50 mm.

## 3. Voz (desacoplada del rostro)

- Se elige entre las voces **nativas en español ya disponibles en la cuenta** (sin clonar a nadie): perfil femenino,
  registro medio, dicción clara, ritmo 150–165 palabras/min.
- Criterio de elección: escuchar 3 candidatas con el mismo párrafo (muestra pública de ElevenLabs, sin coste) y elegir la
  que no se confunda con Callie (Valeria) ni con Ximena.
- La voz queda como campo `voiceId` del catálogo; cambiarla no toca la imagen (y viceversa).
- Nunca se usa ni se modifica un clon de voz (El Duro u otros).

## 4. Licencia y consentimiento

- Imagen generada por un modelo cuyos términos permitan uso comercial de las salidas; se guarda el registro de la
  generación (modelo, fecha, prompt) junto al recurso.
- No hay persona retratada → no aplica consentimiento de imagen; sí se documenta que es sintética.
- Recursos en almacenamiento **privado** (`videos/podcast-catalog/hosts/renata/…`), servidos con enlaces firmados; nunca
  en el repositorio público.

## 5. Integración (puntos exactos, cuando se apruebe)

1. `src/lib/podcast/v3/catalog.ts`: añadir `"renata"` al tipo `CatalogHost["id"]` y su entrada en `HOST_CATALOG`
   (`photo`, `cutout`, `cutoutSize`, `face` medidos con `scripts/podcast-3-0/matte.py` sobre la foto, `voiceId`,
   `voiceName`, `sample: { kind: "elevenlabs" }`).
2. `src/lib/podcast/v3/spec.ts`: `host_id: z.enum(["valeria", "ximena", "victor", "renata"])`.
3. Recorte con alfa: `matte.py --still` sobre la foto → `recorte.png` (privado).
4. Avatar de HeyGen: se crea **solo** con presupuesto autorizado; el `heygenAsset` resultante se guarda en el catálogo
   para reutilizarlo (no se regenera por episodio).
5. Pruebas: `estudio.test.ts`/`podcast-ui.render.test.tsx` (4 anfitriones en el selector) y el caso 13 del E2E
   (`count() === 4`).
6. Revisión visual en los tres estudios (plano general, plano medio y 9:16 dividido) con el render local de F2 antes de
   activarla.

## 6. Coste estimado (no autorizado)

| Paso | Proveedor | Estimación |
|---|---|---|
| 3–4 retratos candidatos | generador de imágenes | ≈ USD 0,10–0,40 |
| Avatar de foto | HeyGen | según plan vigente (verificar antes de autorizar) |
| Muestras de voz | ElevenLabs (muestra pública) | USD 0 |

Nada de esto se ejecuta sin un techo acumulado autorizado por Hans.

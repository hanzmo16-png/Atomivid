# ATOMIVID Precampaign Teaser V1 — QA (corte de revisión, run 37035022140)

**Estado:** BLOQUEADO PARA MASTER — `HEYGEN_AUTH_REJECTED`. La clave `HEYGEN_API_KEY` de GitHub Actions es rechazada por HeyGen
(HTTP 401 `unauthorized`, confirmado con un GET gratuito de verificación). Todo lo demás está listo; el master se genera con
`stage=produce, avatar_mode=heygen` cuando la clave se actualice. Gasto adicional estimado: ≈ USD 0.15 (HeyGen, ~3.8 s).

## Técnica (corte de revisión)
| Check | Resultado |
|---|---|
| Resolución | 1080×1920 ✅ |
| FPS | 30 ✅ |
| Duración | 34.81 s (30–36) ✅ |
| Audio | presente; -14.6 LUFS integrado, true peak -1.3 dBFS ✅ |
| Primer frame | visual (no negro) ✅ |
| Negros accidentales | ninguno ✅ |
| End card | 1.2 s ✅ |

Secciones: apertura real 0–6.3 s · avatar 6.0–9.7 s (marcador) · demo 9.7–15.7 s · resultados 15.7–20.0 s · reveal 20.0–25.0 s · cierre real 25.0–33.6 s · end card 33.6–34.8 s.

## QA de Hans (ORIGINAL → POLISHED, fotogramas a resolución completa)
- Menos pálido: **sí**, piel perceptiblemente más cálida y con más densidad en medios tonos.
- Bronceado ligero: **sí**, dorado moderado aplicado solo a piel (máscara local por crominancia: cara, cuello, pecho, manos).
- Tono natural / sin dominante naranja: **sí**; camisa blanca, pared y ventana se mantienen neutras.
- Identidad y textura: **conservadas**; sin cambios de geometría; suavizado moderado que respeta bordes (barba, cejas, pestañas).
- Coherencia cara/cuello/manos: **sí** (misma máscara para toda la piel).
- Contraluz: altas luces de la ventana contenidas con roll-off; prioridad al rostro, la ventana sigue clara (aceptado según instrucción).
- Coherencia apertura/cierre: **sí**, mismo tratamiento.
- Corrección de ojeras/brillos/imperfecciones: solo la que da el suavizado general de piel; sin retoque puntual → `LOCAL_RETOUCH_LIMIT_REACHED = yes`.

## Revisión visual
- B-roll: elegido sobre hojas de fuentes; los subtítulos en inglés y rótulos de DULCE/Océano quemados en origen se recortan.
- Subtítulos: palabra activa resaltada, ATOMIVID destacado, sobre el pecho (no tapan el rostro), sin solapes.

## Defectos residuales
1. **Avatar = marcador** (bloqueante para el master; ver estado).
2. Un plano ROV de Océano conserva un rótulo diminuto arriba a la izquierda (casi imperceptible).
3. La última palabra del reveal ("ATOMIVID.") sigue en pantalla unos instantes sobre el inicio del cierre real.
4. Ventana del fondo todavía muy clara (contraluz); prioridad al rostro, según lo indicado.
5. La pronunciación de "ATOMIVID" en la voz clonada (alias `atomivid`) requiere escucha humana.

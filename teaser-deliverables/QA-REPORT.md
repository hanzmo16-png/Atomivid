# ATOMIVID Precampaign Teaser V1 — QA del MASTER FINAL POLISHED (run 37039065964)

**Estado:** MASTER LISTO PARA REVISIÓN HUMANA. No publicado.

- Master (Storage privado): `videos/precampaign-teaser-v1/output/ATOMIVID-precampaign-teaser-v1.mp4`
- Artefacto de GitHub Actions: run 37039065964 → `precampaign-teaser-v1-output` (master, preview 540p, informes)
- Copia local de revisión: `teaser-deliverables/master/` (no versionada en git)

## Técnica
| Check | Resultado |
|---|---|
| Resolución | 1080×1920 (9:16) ✅ |
| FPS | 30 ✅ |
| Duración | 34.87 s (30–36) ✅ |
| Códecs | H.264 yuv420p + AAC 48 kHz, faststart ✅ |
| Loudness | -14.6 LUFS integrado, true peak -1.3 dBFS ✅ |
| Primer frame | visual ✅ |
| Negros accidentales | ninguno ✅ |
| Sincronía A/V por segmento | ≤ 39 ms (≈ 1 cuadro) ✅ |
| End card | 1.2 s ✅ |

Estructura: Hans real con gafas 0–6.3 s → transición pixelada 0.3 s → avatar HeyGen (camisa negra) 6.0–9.8 s → demo 9.8–15.7 s →
resultados DULCE/Océano 15.7–20.0 s → reveal "CREATED WITH ATOMIVID" 20.0–25.1 s → Hans real sin gafas + CTA 25.1–33.6 s → end card 33.6–34.9 s.

## QA de Hans (ORIGINAL → POLISHED)
- Menos pálido: **sí**. Bronceado ligero y dorado solo en piel (máscara local): **sí**.
- Tono natural, sin dominante naranja: **sí**; camisa, pared y ventana neutras.
- Identidad, geometría y textura: **conservadas**. Coherencia cara/cuello/manos y apertura/cierre: **sí**.
- Contraluz: altas luces contenidas; la ventana sigue clara (prioridad al rostro).
- `LOCAL_RETOUCH_LIMIT_REACHED = yes` (sin corrección puntual de ojeras/brillos; solo suavizado general de piel).

## Avatar
Avatar existente confirmado (camisa negra, `245a8a51…`). Sin avatar nuevo. Sin deformaciones visibles; voz clonada existente.

## Residuos corregidos en este master
1. Rótulos de Océano: eliminados (recorte seguro más amplio + planos elegidos sobre hojas de fuentes).
2. "ATOMIVID." del reveal ya no invade la toma final de Hans (subtítulos limitados a su segmento + sincronía A/V corregida).
3. Sin negros nuevos ni subtítulos quemados de origen.

## Defectos residuales
1. La ventana del fondo de Hans sigue muy clara (contraluz original; prioridad al rostro).
2. El último cuadro del avatar se mantiene ~0.04 s (relleno a la duración exacta del audio; imperceptible).
3. Pronunciación de "ATOMIVID" (alias `atomivid`) y lip-sync del avatar: confirmar con escucha humana.
4. Línea de pipeline "IDEA → … → VIDEO" en tamaño pequeño (30 px), legible en móvil pero discreta.

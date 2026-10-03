# ATOMIVID Precampaign V2 Cinematic — QA final (master run 37089176748)

**Estado:** MASTER V2 **NO-VFX** LISTO PARA REVISIÓN HUMANA · VFX-001 → `VFX_001_HUMAN_REVIEW_REQUIRED` (vetado en QA de identidad). No publicado.

## VFX-001 (Luma Agents API · ray-3.2 · video_edit · 720p · SDR · ventana 4.700–9.700 s · flex_1 · face/pose precise/trajectory/depth 0.7)
| Intento | Resultado | Gasto |
|---|---|---|
| #1 | HTTP 422 `content_moderated` (prompt; detalle capturado en #2) | USD 0 |
| #2 | HTTP 422 `content_moderated` — "Prompt rejected by content policy" (sin `aspect_ratio`) | USD 0 |
| #3 | Prompt positivo autorizado, sin lista Avoid → **aceptado y COMPLETED** (ledger `vfx:f826cfcc0969c9d9`, COMMITTED) | **USD 1.08** |

Salida #3: 720×1280, 30 fps, 5.0 s, 9:16; flicker bajo (diferencia media entre cuadros 2.85, máx. 7.28).

### QA de identidad (fuente vs salida, 5 cuadros + hoja de contactos) — **VETADO**
| Aspecto | Resultado |
|---|---|
| Identidad / rostro | ❌ Otra persona: forma de cara, pelo, barba (oscura y poblada vs canosa), edad aparente y tez distintos, de forma estable en los 5 s, pese al face conditioning activo |
| Cabello | ❌ distinto |
| Camiseta negra | ✅ |
| Tatuajes | ❌ desaparecen los de los antebrazos |
| Manos visibles | ✅ anatomía correcta, gestos conservados |
| Accesorios | ❌ smartwatch plateado → reloj negro; pulsera y micrófono desaparecen |
| Trayectoria / pose | ✅ conservadas |
| Continuidad temporal / flicker | ✅ |
| Iluminación | ✅ integrada |
| Transformación del entorno | ✅ calle nocturna de Nueva York con brownstones, convincente |
No se regeneró. Fuente y salida se conservan para comparación.

## Master V2 NO-VFX
| Check | Resultado |
|---|---|
| Resolución / fps | 1080×1920 / 30 ✅ |
| Duración | 34.53 s ✅ |
| Loudness | −14.3 LUFS, TP −1.5 dBFS, LRA 2.4 LU ✅ |
| Primer frame visual | ✅ |
| Negros / blancos accidentales | ninguno / ninguno ✅ (flash blanco sustituido por disolvencia de 0.4 s) |
| Subtítulos sin solapes / dentro de su sección / zona segura | ✅ / ✅ / ✅ |
| Sincronía A/V por segmento | ≤ 38 ms ✅ |
| Música con ducking y cortes al beat | 119.96 BPM ✅ |
| End card | 1.2 s ✅ |

Audio real (micrófono nuevo): apto — voz/ruido 37/47 dB, seco (−30 dB en 0.22–0.36 s), clipping inaudible; cadena: −6 dB, HPF, denoise ligero, −2 dB@220 Hz, +3 dB@3.2 kHz, aire, de-esser, compresión 2.5:1, limitador; voz real y TTS igualadas a −16 LUFS.

## Defectos residuales
1. Sin momento hero VFX (VFX-001 vetado por identidad).
2. Micrófono de solapa visible en el cierre.
3. Lip-sync del avatar y pronunciación de "ATOMIVID": escucha humana.

# ATOMIVID Precampaign V2 Cinematic — QA (run 37086740704)

**Estado:** MASTER V2 (SIN VFX) LISTO PARA REVISIÓN · `VFX_001_HUMAN_REVIEW_REQUIRED`
(la única llamada VFX-001 autorizada fue rechazada por Luma con HTTP 422 antes de crear el trabajo: USD 0.00).

## Tomas nuevas (identificadas por transcripción local, nunca por nombre)
| Rol | Archivo | Coincidencia | Voz |
|---|---|---|---|
| APERTURA | `20261002_181854.mp4` (Storage: `precampaign-teaser-v1./20261002_181854-1.mp4`) | 100 % | 3.38–9.34 s |
| CIERRE | `20261002_181957.mp4` (Storage: `precampaign-teaser-v1./20261002_181957-1.mp4`) | 94 % ("ATOMIVID" → "a Tommy Bitt", palabra fuera de vocabulario) | 3.10–10.66 s |
Ambas: 1080×1920, 30 fps, H.264 **HLG (arib-std-b67, BT.2020)** → convertidas a SDR BT.709 con tone mapping `hable` (elegido sobre 4 variantes).

## Audio real (micrófono nuevo) — APTO
| | Apertura | Cierre |
|---|---|---|
| Loudness original | −11.5 LUFS, pico 0.0 dBFS | −9.8 LUFS, pico +0.8 dBTP |
| Ruido en pausas | −54 dB | −62 dB |
| Voz/ruido | 36.7 dB | 47.3 dB |
| Clipping | 3 muestras (≤ 2 seguidas) | 18 muestras (≤ 7 seguidas ≈ 0.15 ms) — inaudible |
| Reverb (caída −30 dB tras la última palabra) | 0.22 s | 0.36 s → seco, sin sonido hueco |
| Balance | presencia 2–6 kHz ≈ 12 dB bajo el cuerpo → oscuro | ídem |
Cadena aplicada: −6 dB, HPF 75 Hz, denoise ligero, −2 dB @220 Hz, +3 dB @3.2 kHz, +1.5 dB aire, de-esser, compresión 2.5:1, limitador; voz real y TTS igualadas a −16 LUFS antes de la mezcla. Sin de-reverb (innecesario).

## Master V2 (sin VFX)
| Check | Resultado |
|---|---|
| Resolución / fps | 1080×1920 / 30 ✅ |
| Duración | 34.63 s ✅ |
| Loudness | −14.3 LUFS, TP −1.5 dBFS, LRA 2.3 LU ✅ |
| Primer frame visual / negros | ✅ / ninguno ✅ |
| Subtítulos sin solapes / sin cruzar secciones | ✅ / ✅ |
| Sincronía A/V por segmento | ≤ 38 ms ✅ |
| End card | 1.2 s ✅ |
| Música con ducking, cortes al beat | 119.96 BPM, error medio 62 ms ✅ |
| VFX integrado | ❌ (ver arriba) |

Estructura: Hans real caminando → frase de apertura (0–7.3 s) → zoom-in + whoosh → avatar HeyGen (6.95–10.75) → demo con un plano por palabra
(10.71–16.68) → resultados DULCE/Océano (16.64–21.0) → reveal con riser (20.71–25.8) → flash + Hans real de cierre + CTA (25.51–33.78) → end card animada (33.43–34.63).

## Defectos residuales
1. Sin el momento VFX (pendiente de autorizar el envío corregido).
2. La transición reveal → cierre (`fadewhite`) pasa por un cuadro blanco completo (flash deliberado de 0.3 s); puede suavizarse.
3. El micrófono de solapa es visible en el pecho de Hans en el cierre.
4. Lip-sync del avatar y pronunciación de "ATOMIVID": escucha humana.

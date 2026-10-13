# Propuesta de retención de Storage (NO aplicada)

Este documento es solo una propuesta.
- No se crean jobs, políticas ni borrados.
- No se toca ningún objeto existente.
- No se toca nada de Travis Walton (v5, v6 ni los originales).
- La decisión y la aplicación son de Hans.

## Situación actual (código)
- El bucket `videos` guarda en cada intento de Reel todos los artefactos en `<requestId>/attempt-<n>/`:
  - clips o imágenes de stock (`scene-*`);
  - `voice.*` y `music.*`;
  - `director.json`, si aplica;
  - `final.mp4`.
- No hay ninguna política de borrado en el código: el almacenamiento crece cada mes.
- Este PR solo cambia el formato de los intermedios de audio que llegan como WAV: se guardan como MP3 de 192 kbps.
  - La voz real (ElevenLabs) y la música real (Beatoven) ya llegan en MP3 y no cambian.
  - Por eso **no se espera ahorro en producción** por este cambio, salvo en los recorridos que produzcan WAV.
  - La medición de −53,5 % por intento es local, con proveedores fixture que entregan WAV, y no se extrapola a producción.

## Exclusiones obligatorias (nunca entran en una limpieza automática)
- `final.mp4` del intento que dejó la solicitud en `completed` (el que ve el cliente), y cualquier objeto referenciado por una fila: `video_path`, miniatura, `recorded_audio_path`.
- `<requestId>/paid/`: resultados pagados (clips IA, imágenes IA y similares). Se reutilizan en reintentos para no volver a comprar.
- Artefactos de recuperación y reanudación:
  - `<requestId>/state/`: `output.json`, `production-budget.json`, `visual-report.json`, `curation.json`, `prepared.json`, `state/shots/`, `render-*.json`;
  - `<requestId>/assets/`: activos durables por plano, que se reutilizan al reintentar;
  - `<requestId>/recovery*/`;
  - `<requestId>/output/`: final y miniatura de Long Form;
  - `<requestId>/curation/uploads/`;
  - `<requestId>/avatar-narration.*`.
- Todo Long Form, podcast y avatar mientras no exista un inventario propio de cada flujo.
- Prefijos de Travis Walton (v5, v6 y originales).

## Política propuesta (solo Reels)

| Objeto | Retención propuesta |
|---|---|
| `final.mp4` del intento `completed` | **Nunca se borra** |
| Carpetas `attempt-<n>` de intentos fallidos o reemplazados, sin referencias desde ninguna fila | 30 días tras el último intento |
| Intermedios del intento correcto (`voice.*`, `music.*`, `scene-*`, `director.json`) | 90 días (permiten re-render y auditoría) |

**Aplicación (pendiente de aprobación):** un job programado de solo borrado, con:
- lista de inclusión por prefijo;
- la lista de exclusiones anterior comprobada antes de cada borrado;
- modo simulación (dry-run) obligatorio la primera vez;
- registro de lo borrado.

Requiere SQL o un workflow nuevo, así que **no se implementa aquí**.

## Estimación (supuestos editables, no medidos en producción)

**Supuestos por Reel terminado:**
- `final.mp4` de 15 MB (30 s a 4 Mbps);
- intermedios de 30 MB;
- 15% de intentos extra;
- Supabase Pro: 100 GB incluidos y luego USD 0,0213/GB-mes.

| Volumen | Meses | Sin retención | 90 d | 30 d |
|---|---|---|---|---|
| 10/día | 12 | 186 GB (USD 1,84/mes) | 87 GB (0) | 65 GB (0) |
| 40/día | 6 | 373 GB (USD 5,81) | 240 GB (2,99) | 152 GB (1,11) |
| 40/día | 12 | 745 GB (USD 13,74) | 348 GB (5,29) | 260 GB (3,41) |

**Lectura:**
- En dinero el ahorro es pequeño, porque el almacenamiento es barato.
- El beneficio principal es acotar el crecimiento.
- La retención reduce lo **almacenado**, no la transferencia: el renderer sigue leyendo cada objeto que usa desde Storage.
- Ninguna cifra de esta tabla es una medición de producción.

## Decisión sobre la caché compartida de stock (retirada de este PR)
Una versión anterior de este PR guardaba los clips de Pexels una sola vez en `stock/<id>-<w>x<h>.<ext>` y los reutilizaba. Se retiró por dos motivos:
- **Integridad:** la clave (id + resolución + extensión) no verifica el contenido. Un objeto compartido corrupto o truncado se reutilizaría en cada Reel y podría acabar en un video roto. Verificarlo exige guardar un hash o tamaño esperado al subir y comprobarlo antes de reutilizar (metadatos o tabla nueva), además de definir la recuperación ante fallos de lectura o firma y la concurrencia. Eso es arquitectura nueva, fuera del alcance de este PR.
- **Ahorro no acreditado:** reutilizar evitaría la descarga desde Pexels y la subida duplicada, pero **no** la lectura Storage→renderer, que se repite en cada render. No hay medición de la tasa de reutilización en producción.

## Qué medir antes de aprobar
1. Bytes reales por intento en producción, separados por tipo de objeto.
2. Fracción de intentos fallidos.
3. Si algún flujo (re-render, auditoría o soporte) lee intermedios después de 30 o 90 días.

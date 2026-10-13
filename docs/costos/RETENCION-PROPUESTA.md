# Propuesta de retención de Storage (NO aplicada)

Este documento es solo una propuesta.
- No se crean jobs, políticas ni borrados.
- No se toca ningún objeto existente.
- No se toca nada de Travis Walton (v5, v6 ni los originales).
- La decisión y la aplicación son de Hans.

## Situación actual (código)
- El bucket `videos` guarda en cada intento todos los artefactos en `<requestId>/attempt-<n>/`:
  - clips o imágenes de stock (hasta este PR);
  - `voice.*` y `music.*`;
  - `director.json`, si aplica;
  - `final.mp4`.
- No hay ninguna política de borrado en el código: el almacenamiento crece cada mes.
- Desde este PR, los clips de Pexels se guardan una sola vez en `stock/<id>-<w>x<h>.<ext>` y se reutilizan. Los WAV intermedios se guardan como MP3 de 192 kbps.

## Política propuesta

| Objeto | Retención propuesta |
|---|---|
| `final.mp4` del intento que dejó la solicitud en `completed` (el que ve el cliente) | **Nunca se borra** |
| Carpetas `attempt-<n>` de intentos fallidos o reemplazados | 30 días tras el último intento |
| Intermedios del intento correcto (`voice.*`, `music.*`, `scene-*`, `director.json`) | 90 días (permiten re-render y auditoría) |
| `stock/` (clips compartidos) | Fuera de esta política. Su limpieza, por última referencia, requeriría un índice. |
| Prefijos de Long Form y de Travis Walton (v5, v6, originales) | **Excluidos** |

**Aplicación (pendiente de aprobación):** un job programado de solo borrado, con:
- lista de inclusión por prefijo;
- modo simulación (dry-run) obligatorio la primera vez;
- registro de lo borrado.

Requiere SQL o un workflow nuevo, así que **no se implementa aquí**.

## Estimación de ahorro (supuestos editables, no medidos en producción)

**Supuestos por Reel terminado:**
- `final.mp4` de 15 MB (30 s a 4 Mbps);
- intermedios de 30 MB hoy y unos 6 MB con este PR (audio comprimido y stock compartido; el stock compartido no se cuenta por video);
- 15% de intentos extra;
- Supabase Pro: 100 GB incluidos y luego USD 0,0213/GB-mes.

| Volumen | Meses | Hoy: sin retención | Hoy: 90 d | Hoy: 30 d | Con PR: sin retención | Con PR: 90 d | Con PR: 30 d |
|---|---|---|---|---|---|---|---|
| 10/día | 12 | 186 GB (USD 1,84/mes) | 87 GB (0) | 65 GB (0) | 87 GB (0) | 62 GB (0) | 57 GB (0) |
| 40/día | 6 | 373 GB (USD 5,81) | 240 GB (2,99) | 152 GB (1,11) | 174 GB (1,57) | 141 GB (0,87) | 119 GB (0,40) |
| 40/día | 12 | 745 GB (USD 13,74) | 348 GB (5,29) | 260 GB (3,41) | 348 GB (5,28) | 249 GB (3,17) | 227 GB (2,70) |

**Lectura:**
- En dinero el ahorro es pequeño, porque el almacenamiento es barato.
- El beneficio principal es acotar el crecimiento: a 40/día y 12 meses, el volumen baja de unos 745 GB a unos 230–350 GB.
- También reduce el egress Supabase→runner, que este PR ya reduce al no re-subir stock.

## Qué medir antes de aprobar
1. Bytes reales por intento en producción, separados por tipo de objeto.
2. Fracción de intentos fallidos.
3. Cuántas veces se reutiliza cada clip de `stock/` (registro `[atomivid:stock-cache]`).
4. Si algún flujo (re-render, auditoría o soporte) lee intermedios después de 30 o 90 días.

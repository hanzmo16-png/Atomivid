# VFX Provider V1 — VFX / Transform Scene (Luma Ray 3.2 `video_edit`)

**Capacidad:** video real existente + transformación descrita → video transformado → pipeline normal de edición/master.
Distinta de `ai_video` (generación nueva): resultados `kind: "vfx_transform"`, filas de ledger `vfx:<hash>` / método `video_transform`.

**Principio de producto:** máxima calidad de producción al menor costo FIABLE. La métrica futura es el costo por asset aprobado,
no por generación; la arquitectura (`VfxProvider` → adapters, identidad y costo por operación en el ledger) lo permite sin scoring todavía.

## Piezas
| Archivo | Rol |
|---|---|
| `src/lib/providers/vfx/types.ts` | `VfxProvider.transformVideo`, request/asset, controles de preservación, contrato de producto `TransformSceneInput` |
| `src/lib/providers/vfx/luma.ts` | Adapter Luma Agents API: Files API → `file_id` → `video_edit` en `ray-3.2`; sondeo, descarga, reanudación; preflight `GET /files?limit=1` |
| `src/lib/providers/vfx/pricing.ts` | Motor de costo: tabla Ray 3.2 `video_edit` estándar/SDR por resolución y tramo (5 s/10 s); tope (estimado + comprometido + reservado) |
| `src/lib/providers/vfx/index.ts` / `fixture.ts` | Registro (`VFX_PROVIDER=luma`, sin router todavía) y proveedor determinístico sin red |
| `src/lib/paid-calls/gated-vfx.ts` | Gate de pago + ledger + idempotencia + persistencia + `file_id` durable por sha256 |
| `src/lib/video/vfx/vfx-001.ts`, `scripts/vfx/*` | VFX-001 (WAITING_FOR_HANS_SOURCE_VIDEO), plan de gasto, preflight |
| `.github/workflows/vfx-luma-preflight.yml` | Preflight manual gratuito (requiere registrarse en la rama por defecto para poder dispararse) |

## Contrato (verificado 2026-10-02 contra el SDK oficial `luma-agents` 0.5.0, PyPI, 2026-08-05)
- Base `https://agents.lumalabs.ai/v1`, `Authorization: Bearer <LUMA_API_KEY>`.
- Origen: `POST /files` (JSON → `upload` presignado) → `PUT` de los bytes → `POST /files/{id}/complete` → `GET /files/{id}` hasta `ready` → `source.file_id`.
- `POST /generations` `{ type: "video_edit", model: "ray-3.2", prompt, aspect_ratio: "9:16", source: { file_id }, video: { resolution, hdr: false, edit: { strength, auto_controls: false, controls } } }`.
- Controles documentados: `face {enabled}`, `pose {enabled, strength precise|coarse}`, `depth {enabled, blur 0..1}`, `normals {enabled, augmentation 0..1}`, `trajectory {enabled, sparsity 0..1}`; intensidad `adhere_1..3 | flex_1..3 | reimagine_1..3`.
- Origen ≤ 18 s; la salida dura lo mismo que el origen. Sin semilla ni campo de negativo (el negativo va como "Avoid:" en el prompt; una semilla se rechaza).
- `GET /generations/{id}` → `queued | processing | completed | failed`, `output[].url` (presignada 1 h), `failure_code`.
- Se eliminó el adapter Dream Machine v1 `modify_video` (`ray-2`/`ray-flash-2`) y su precio por megapíxel.

## Precio (estándar/SDR, autorizado por el propietario 2026-10-02)
| | 5 s | 10 s |
|---|---|---|
| 360p | 0.54 | 1.08 |
| 540p | 0.72 | 1.44 |
| 720p | 1.08 | 2.16 |
| 1080p | 2.16 | 4.32 |
Sin interpolación: el origen se recorta a un tramo con precio (5 s o 10 s, ±0.05 s). Sin HDR ni EXR.

## Identidad (idempotencia)
sha256 del origen (aunque Luma use `file_id`) + duración + proveedor + modelo + `video_edit` + prompt + negativo + rango + aspecto + resolución + SDR
+ controles + intensidad + estilo + semilla + parámetros resueltos del proveedor. Nunca la URL firmada, el `file_id` ni `render_attempts`.

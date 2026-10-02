# VFX Provider V1 — VFX / Transform Scene (Luma first)

**Capacidad:** video real existente + transformación descrita → video transformado → pipeline normal de edición/master.
Distinta de `ai_video` (generación nueva): resultados `kind: "vfx_transform"`, filas de ledger `vfx:<hash>` / método `video_transform`.

## Piezas
| Archivo | Rol |
|---|---|
| `src/lib/providers/vfx/types.ts` | Interfaz `VfxProvider.transformVideo`, request/asset, contrato de producto `TransformSceneInput` |
| `src/lib/providers/vfx/luma.ts` | Adapter Luma (payload puro, preflight GET /credits, transform bloqueado mientras el contrato no esté verificado) |
| `src/lib/providers/vfx/pricing.ts` | Motor de costo: tarifas con `verified`, estimación solo con tarifas verificadas, tope (estimado + comprometido + reservado) |
| `src/lib/providers/vfx/index.ts` / `fixture.ts` | Registro (`VFX_PROVIDER=luma`) y proveedor determinístico sin red |
| `src/lib/paid-calls/gated-vfx.ts` | Gate de pago + ledger + idempotencia + persistencia + reanudación |
| `src/lib/video/vfx/vfx-001.ts`, `scripts/vfx/*` | VFX-001 (READY_FOR_SOURCE_VIDEO), plan de gasto, preflight |

## Estado del contrato Luma (2026-10-02)
- **Verificado** contra el SDK oficial `lumaai@1.19.1` (generado desde el OpenAPI de Luma): `POST https://api.lumalabs.ai/dream-machine/v1/generations/video/modify`
  (`modify_video`, `ray-2` | `ray-flash-2`, modos `adhere|flex|reimagine_1..3`, `media.url`, `prompt`), `GET /generations/{id}`, `GET /credits` (centavos USD).
- **No verificado** (docs.lumalabs.ai, docs.agents.lumalabs.ai y lumalabs.ai bloqueados por la política de red del entorno):
  si Modify Video sigue siendo la API vigente frente a Ray3.2 `video_edit` en la Agents API (`agents.lumalabs.ai`; su SDK `luma-agents@0.1.2` solo expone imagen),
  las tarifas, los límites por modelo, la resolución/fps de salida y a qué API pertenece `LUMA_API_KEY`.
- Por eso `LUMA_VFX_CONTRACT_VERIFIED = false` y todas las tarifas `verified: false`: cualquier llamada pagada se rechaza **antes** del ledger.

## Para habilitar (decisión humana)
1. Confirmar en la doc oficial qué API usar (Modify Video v1 o Ray3.2 `video_edit`) y para cuál es la clave.
2. Confirmar tarifas y límites; actualizar `VFX_RATES` (`verified: true`) y, si cambia la API, el adapter.
3. Cambiar `LUMA_VFX_CONTRACT_VERIFIED` e implementar submit/poll/download en el adapter con tests de mocks.
4. Registrar el workflow de preflight/producción en la rama por defecto (cambio aislado) si se ejecuta desde Actions.

## Identidad (idempotencia)
sha256 del tramo enviado + proveedor + modelo + prompt + negativo + rango (ms) + aspecto + preservar sujeto + intensidad + estilo + calidad + semilla.
Nunca la URL firmada ni `render_attempts`.

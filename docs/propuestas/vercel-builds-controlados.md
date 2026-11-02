# Propuesta: compilaciones de Vercel controladas (NO APLICADA)

**Estado:** propuesta. **Requiere autorización expresa del propietario.** Afecta a los despliegues.

Esta propuesta no modifica `vercel.json` ni la configuración del proyecto en Vercel. El script `scripts/vercel-ignore-build.sh` se incluye para revisión, pero **ningún archivo de configuración lo invoca**.

## Situación actual (verificada en el repositorio, 2026-11-02)
**`vercel.json`:** solo desactiva el despliegue (`git.deploymentEnabled: false`) de 8 ramas antiguas:
- `codex/provider-monitor-ready`
- `codex/internal-readiness-isolated`
- `claude/video-review`
- `claude/pilot-diag`
- `ops-sealed-out`
- `claude/pilot-deploy`
- `claude/pilot-budget-total`
- `claude/orchestrator-v1`

Cualquier otra rama genera una **preview en cada push**.

**Rama de producción:** `claude/atomivid-mvp-setup-0079jv`, la base de los PR.

**Ramas que reciben pushes frecuentes sin necesitar preview:**
- `claude/puertas-merge`: solo contiene arneses de QA que se ejecutan en GitHub Actions.
- `claude/evidencias-cierre`: evidencia cifrada que escriben los workflows.
- Ramas de trabajo `claude/*`, `cursor/*`, `chatgpt/*` y `codex/*`.

**Actividad de Claude el 2026-11-02, como muestra de lo que cuesta hoy:**
- unos 12 pushes a ramas con preview, repartidos entre `claude/podcast-guion-incidente`, `claude/podcast-plantilla-larga`, `claude/puertas-merge` y `claude-tmp-pm`;
- 2 despliegues productivos por merges de Hans (#273 y #274).

**Costo:** no verificado; los agentes no ven la facturación de Vercel.

**Pushes de los workflows:** cada ejecución de `prueba-real` empuja evidencia a `claude/evidencias-cierre`. Si esa rama no está excluida, **cada ejecución de QA puede disparar una preview**. Hay que comprobarlo en el panel de Vercel.

## Opción A — mínima y de bajo riesgo (recomendada como primer paso)
Añadir a `git.deploymentEnabled` de `vercel.json` las ramas que **nunca** necesitan preview:

```json
"claude/puertas-merge": false,
"claude/evidencias-cierre": false,
"claude-tmp-pm": false
```

- **Efecto:** desaparecen las previews de las ramas de QA y evidencia.
- **Sin efecto sobre:** producción, la CI de GitHub ni las previews de los PR reales.
- **Reversible:** basta con quitar las líneas.

## Opción B — previews solo a petición
Configurar en Vercel el **Ignored Build Step** con `bash scripts/vercel-ignore-build.sh`, por `vercel.json` (`"ignoreCommand"`) o desde el panel del proyecto.

**Comportamiento del script:**

| Caso | Resultado |
|---|---|
| Rama de producción (`VERCEL_GIT_COMMIT_REF` = rama de producción) | **compila siempre** |
| Mensaje del commit con `[preview]` | compila |
| Cualquier otra rama | se omite (exit 0) |

- **Efecto:** las previews solo existen cuando se piden expresamente. Encaja con la etapa 4 de la política («una preview final cuando sea necesaria»).
- **Riesgo:** quien necesite una preview tiene que pedirla con `[preview]` en el commit. Las pruebas e2e de la CI **no** usan Vercel (levantan Next en local), así que no se pierde cobertura.

## Opción C — almacenamiento de funciones (Function Storage, USD 65.83)
- Revisar en el panel la **retención de despliegues** (Deployment Retention) y borrar previews antiguas.
- Es una acción del propietario en Vercel: los agentes no tienen acceso y **borrar despliegues requiere autorización**.

## GitHub Actions
- La mayoría de los workflows de `pull_request` ya tienen filtros de rutas y `concurrency` con `cancel-in-progress`.
- **No se propone desactivar** ninguna comprobación: la política prohíbe quitar CI obligatoria.
- Los minutos de Actions de un repositorio privado pueden tener costo. Hay que revisarlo con la facturación real antes de proponer cambios.

## Pendiente de autorización
1. Opción A (recomendada).
2. Opción B.
3. Opción C (en el panel de Vercel, por el propietario).
4. Medir la línea base (builds, minutos, Function Storage, factura) desde el panel de uso de Vercel. Solo el propietario tiene acceso.

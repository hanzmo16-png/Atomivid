# Política permanente de control de costos y despliegues — ATOMIVID

- **Estado:** obligatoria.
- **Vigencia:** desde 2026-11-02 hasta nueva instrucción expresa del propietario (Hans).
- **Destinatarios:** todos los agentes (Claude, Grok, Codex, ChatGPT y futuros) y cualquier persona que contribuya.
- **Origen:** orden P0 de Hans del 2026-11-02, tras la factura de Vercel.

**Factura de Vercel que motivó la política** (datos reportados por Hans; no verificados por agentes):

| Concepto | Importe aproximado |
|---|---|
| Function Storage | USD 65.83 |
| Build CPU Minutes | USD 52.75 |
| Cargo bancario asociado a Vercel | USD 100.03 |

## 1. Principio
**Calidad > Seguridad > Estabilidad > Control de costos > Velocidad.**

Ahorrar dinero nunca justifica comprometer la seguridad, la calidad o la estabilidad.

## 2. Reglas permanentes

### A. Desarrollo local obligatorio
Antes de publicar cualquier cambio:
1. Revisar el código existente.
2. Identificar la causa raíz.
3. Implementar una corrección completa.
4. Ejecutar las pruebas locales gratuitas: `npm run -s test:podcast3`, `npm run -s test:unit`, `npx tsc --noEmit -p .`, `npx eslint <archivos>` y las suites específicas del área.
5. Comprobar regresiones.
6. Agrupar los cambios relacionados en una entrega coherente.

Queda prohibido hacer commits remotos pequeños y repetidos hasta conseguir una compilación verde.

### B. GitHub y Vercel
- No hacer push automáticamente después de cada ajuste: un push por entrega consolidada.
- No generar previews de Vercel por rutina ni usar Vercel como sustituto de las pruebas locales.
- No desplegar para comprobar correcciones triviales.
- Si hace falta validación visual, una única preview final.
- No fusionar ningún PR sin autorización expresa del propietario para ese PR y su SHA.
- No desplegar a producción sin autorización expresa.
- **No bloquear** las pruebas gratuitas de seguridad, CI o aceptación indispensables.
- **Nunca** desactivar la CI obligatoria para ahorrar.

### C. Responsabilidades
- **Claude (desarrollo principal):**
  - Podcast Studio Premium, biblioteca de episodios y correcciones asignadas.
  - Completa cambios y pruebas locales antes de publicar, sin despliegues intermedios.
- **Grok (auditoría independiente):**
  - Seguridad, QA y revisión técnica.
  - Audita primero el SHA entregado y las pruebas existentes.
  - No genera builds por iniciativa propia ni edita los mismos archivos que Claude.
- **Codex (proyectos independientes):**
  - Módulos separados (p. ej. Avatar Engine), con su propio repositorio y pruebas.
  - No altera la plataforma principal sin autorización.

### D. Autorizaciones económicas
- Presupuesto predeterminado: **USD 0**.
- Sin autorización específica queda prohibido:
  - consumir APIs de IA pagadas;
  - contratar servicios o subir de plan;
  - ejecutar pruebas con gasto;
  - hacer merges o despliegues productivos;
  - modificar secretos;
  - aplicar migraciones;
  - escribir en Supabase de producción;
  - borrar datos, objetos, episodios, el ledger o registros de gasto.
- Una autorización anterior no es un permiso general para operaciones nuevas.

## 3. Proceso de desarrollo (seis etapas)
1. **Desarrollo:** el agente de desarrollo trabaja y prueba en local.
2. **Consolidación:** agrupa los cambios y entrega un SHA estable, con un solo push.
3. **Auditoría:** Grok verifica seguridad, funcionalidad y regresiones sobre ese SHA, con pruebas existentes y gratuitas.
4. **Preview controlada:** solo si hace falta validación visual y está autorizada.
5. **Integración:** solo con autorización expresa del propietario para el PR y el SHA concretos.
6. **Validación productiva:** comprobaciones de solo lectura, sin proveedores pagados ni cambios de datos.

## 4. Reporte obligatorio en cada entrega técnica
- Trabajo completado.
- Archivos modificados.
- SHA exacto.
- Pruebas ejecutadas y resultados.
- **Número de pushes y compilaciones generadas** (Vercel y GitHub Actions).
- Previews creadas.
- Despliegues productivos realizados.
- **Costo conocido o estimado**, claramente separados. Sin evidencia de facturación se escribe «costo no verificado»; nunca «USD 0» de infraestructura.
- Riesgos y pendientes.
- Siguiente delegación necesaria.

## 5. Objetivo medible
- **Meta inicial:** reducir un **70 %** los builds innecesarios respecto de la línea base histórica, sin reducir la cobertura de seguridad ni de calidad.
- **Métricas, por separado:**
  - número de builds;
  - minutos de compilación;
  - Function Storage;
  - costo facturado;
  - frecuencia de despliegues;
  - errores detectados después de llegar a producción.
- La reducción se demuestra con **facturación real**, no con estimaciones.
- La línea base debe sacarse del panel de uso de Vercel. Solo el propietario tiene acceso; los agentes no tienen credenciales de Vercel.

## 6. Cambios de configuración pendientes de autorización
Ver [`docs/propuestas/vercel-builds-controlados.md`](../propuestas/vercel-builds-controlados.md). **Ninguno está aplicado.** Afectan a los despliegues y requieren autorización expresa del propietario.

## 7. Dónde se aplica
- **Repositorio:** `AGENTS.md`, que `CLAUDE.md` incluye y que los agentes leen al iniciar.
- **Drive:** complemento del protocolo de coordinación «PROTOCOLO-COSTOS-Y-DESPLIEGUES-v1» en la carpeta Entregas. Se añade sin sobrescribir los protocolos v3 y v3.1.
- **Automatizaciones:** la rutina horaria de coordinación ya prohíbe gasto, despliegue, merge, migración y secretos sin autorización. Con esta política, cada ENTREGADO debe incluir además los pushes, compilaciones y costo de la sección 4.

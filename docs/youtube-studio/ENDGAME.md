# YouTube Studio — candidato de revisión

Base: `fdd7a4720e25a9416df86264bd05dc7ce9a3a921` de `claude/atomivid-mvp-setup-0079jv`, consultada y clonada del remoto el 21 noviembre 2026. Rama nueva exclusiva `codex/youtube-studio-endgame-20261121`. No se modifica `claude/hola-sn3dxy`, Podcast, Biblioteca ni producción.

## Qué se reutiliza y qué cambia

La base ya tiene OAuth oficial de Google con PKCE, state de un uso y expiración, refresh token cifrado AES-GCM, verificación exacta de scopes de lectura y conexión en Command Center. También existe paquete de entrega de videos. Faltaba una interfaz de Studio conectada a consultas de canal, catálogo y borradores; no se reconstruye OAuth ni se amplían permisos.

Nueva ruta `/dashboard/youtube`, accesible desde el enlace añadido en Command Center. API nueva GET `/api/distribution/youtube/studio` autentica con getUser, filtra owner explícito antes de resolver cualquier token, repite el owner check en memoria y devuelve sólo DTOs. La Biblioteca consulta videos completed con video_path existente del propio usuario, sin modificarla. Título de fuente = topic del contrato existente. No se firman ni copian medios ni se genera video. Enlaces a Reels, Long Form, Biblioteca y Command Center reutilizan rutas actuales.

Al abrir se leen conexiones guardadas y videos terminados; **no se consulta Google automáticamente**. Una pulsación de consulta renueva el access token en servidor y consulta channels.list, playlistItems.list y videos.list (máximo 25 por página). Cada página vuelve a consultar el canal y el listado correspondiente; sin bucles automáticos ni search.list. Analytics sólo con pulsación explícita y scope ya concedido. Ventana de 28 días hasta hace dos días. No se inventan filas ni métricas ausentes; hidden subscribers/otras métricas dependen de Google. Duración ≤180s es sólo posible Short porque falta la relación de aspecto/metadatos definitivos.

El access token nunca se persiste ni vuelve al browser; refresh token sólo en la infraestructura cifrada existente. No se registran respuestas de tokens, encabezados ni errores originales. Errores públicos enumerados. Headers private,no-store y Vary Cookie; timeouts de transporte; cero reintentos. No hay handler de escritura, import de upload ni scheduler ejecutable.

## Borradores

Preparar título, descripción, tags, privacidad, miniatura y fecha no publica ni programa. Guardado explícito por UUID de usuario en localStorage, esquema versionado, importación allowlist al recuperar, errores de corrupción y espacio visibles. Mismo botón reescribe el mismo borrador: no crea trabajos repetidos. Exportación JSON para continuidad. **Sólo este navegador/teléfono, sin sincronización ni durabilidad externa automática**. No almacenar secretos en el borrador. Un dispositivo compartido no es un almacén privado contra otros usuarios del mismo perfil del navegador.

Valida fuente terminada propia, título1–100/desc≤5000 sin `<`/`>`, tags≤500 incluidos separadores/comillas, privacidad enum. Fecha UTC preparada ≥15 minutos, privada si hay fecha; la entrada usa zona local del teléfono y muestra UTC. Miniatura real decodificada JPG/PNG≤2MB, ≥640px, 16:9 y SHA256 local. Guarda nombre/hash, **no binario**: tras recargar se debe seleccionar de nuevo. Compatibilidad de miniatura de Shorts requiere verificación posterior del flujo oficial, no se promete carga.

La publicación, programación y desconexión Google están deshabilitadas. Revocar es escritura externa, fuera de autorización. Reconectar reutiliza el flujo de solo lectura; el callback existente devuelve JSON y la persona debe volver al Studio. No se cambió su redirect, secretos ni scopes. La renovación intenta usar conexión actual; fallos requieren reconexión o revisión de configuración. No hay prueba OAuth real en esta misión.

## Arquitectura futura, sin ejecución

Un futuro worker de publicación necesita consentimiento por operación, scopes verificados, usuario/canal/fingerprint de video y metadata como clave idempotente durable, transiciones PREPARED→AUTHORIZED→SUBMITTING→UPLOADED/RECONCILIATION_REQUIRED, recibo provider antes de reintentar y cancelación que no prometa deshacer una subida ya enviada. Tras respuesta ambigua no reenviar. No activar con un env toggle. Requiere otra revisión/autorización y persistencia transaccional aprobada: **esa capacidad no está implementada ni habilitada por este PR**. El estado actual sólo admite DRAFT local.

## QA y límites de evidencia

- 30 pruebas directas node/tsx: Studio10, OAuth8, conexión Command Center7, paquete5. Sin llamadas Google. Conservar el primer FAIL (el test legado prohibía enlaces en el botón; el enlace se movió al contenedor sin alterar el botón ni la prueba).
- TypeScript y ESLint de archivos tocados aprobados. next typegen requerido antes de typecheck por LayoutProps generado. Build de producción con Webpack aprobado; default Turbopack no pudo resolver el symlink local de node_modules (fuera del root). No se cambia configuración global por ello.
- `scripts/youtube-studio/qa.mjs`: componente cliente real, CSS productivo, React y Chromium reales. HTTP reemplazado por fixtures explícitos, sin backend Supabase/Google real. 390×844, 412×915,1440×900, guardado/reload, previsualización, filtros, Analytics fixture, errores de cuota, botones de escritura deshabilitados. Axe WCAG2/2.1 AA, cero serious/critical y cero overflow. Se preservan FAIL de labels y contraste previos; contraste del botón reutilizado corregido sólo dentro del Studio, sin editar componente compartido.
- Esta prueba NO es E2E autenticado de Next→Supabase→Google ni una sesión física Samsung. Faltan sesión owner autorizada, despliegue de revisión y consentimiento existente para esa verificación. Producción sin sesión responde redirect de login: eso no acredita el módulo desplegado.
- No se consulta Supabase de producción ni se consumen cuotas Google. Se leyó changelog/documentación Supabase y se conservan APIs existentes; no hay esquema, grants, secretos ni migraciones.
- CI nuevo fixture-only: checkout, npm ci, typegen/typecheck, ESLint, tests, build, Chromium/axe. No secrets ni servicios de pago; sin deploy desde el workflow. Integraciones PR existentes pueden crear Preview automáticamente según configuración del repositorio; no se ejecuta promoción ni despliegue manual.

## Android, después de autorizar e integrar

Abrir `/dashboard/youtube` con sesión ATOMIVID, o Command Center → Abrir YouTube Studio. Conectar con Google sólo si faltan permisos de lectura existentes. Consultar explícitamente canal/videos o estadísticas; buscar y filtrar. Elegir video terminado, editar metadata, fecha deseada y miniatura; Guardar borrador, Exportar borrador o Previsualizar. No hay botón operativo de publicación. Volver a seleccionar el archivo de miniatura tras recargar. El enlace productivo aún no contiene este candidato hasta un merge/deploy autorizado; no presentarlo como operativo allí.

## Restauración y rollback

El paquete de entrega incluye árbol completo, cambios, logs, imágenes, SHA256SUMS y bundle que se verifica al restaurar. Para clones shallow, el paquete deberá documentar si el bundle es autocontenido o requiere un prerrequisito; nunca declarar recuperación completa sin probarla. Preservar el HEAD remoto/base exactos.

Rollback de esta propuesta sin migraciones: conservar rama base intacta, no fusionar; si hubiera integración futura, revertir el commit de este PR y redeploy de la revisión anterior sólo con autorización. El gate local verifica que el diff se pueda revertir; no equivale a un rollback productivo ejecutado. No borrar borradores ni videos como rollback.

## Dictamen

Candidato local útil para revisión. GO PARA REVISIÓN sólo con PR en borrador, CI final aprobado y límites visibles. OAuth/Google real, revocación, upload, publicación, programación y móvil físico siguen NO PROBADOS o BLOQUEADOS según sus autorizaciones. Nunca GO de publicación real.

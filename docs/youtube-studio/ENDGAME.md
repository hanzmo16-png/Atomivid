# YouTube Studio — candidato de revisión

Base inicial: `fdd7a4720e25a9416df86264bd05dc7ce9a3a921` de `claude/atomivid-mvp-setup-0079jv`, consultada y clonada del remoto el 21 noviembre 2026. Rama nueva exclusiva `codex/youtube-studio-endgame-20261121`. No se modifica `claude/hola-sn3dxy`, Podcast, Biblioteca ni producción.

Base productiva reconciliada: `4e5959bdce1c87ae5823288298968932ab1b4bae`. HEAD recibido al inicio de la continuación nocturna: `7dbe4ee4d9c6091451c916e4ec6fa9b8937dfcf1`. La integración previa de esa base no tuvo conflictos; los cambios de Audio Studio pertenecen a producción y no se editan aquí. El SHA final y sus checks se registran en el PR y el manifiesto externo para evitar una referencia circular al propio commit.

## FUNCIONAL / PREPARADO / BLOQUEADO

| Capacidad | Estado y alcance de evidencia |
| --- | --- |
| Selección de videos, metadata, privacidad y fecha deseadas, miniatura, guardado/reload, exportación y preview | FUNCIONAL en navegador con HTTP fixtures y componente real; no acredita la sesión productiva del propietario |
| Conexiones propias almacenadas, foto/nombre, biblioteca YouTube, métricas y renovación | PREPARADO en código; BLOQUEADO en Preview por configuración OAuth ausente, además del gate autenticado. Una fila guardada no acredita vigencia del token |
| Shorts | PREPARADO como candidatos por duración; clasificación definitiva exige aspecto/metadatos |
| Desconexión, upload, publicación y programación efectiva | BLOQUEADO por autorización/permisos; no hay handlers ejecutables |
| Disponibilidad en producción | BLOQUEADO hasta merge/despliegue autorizados; Preview existe pero tiene protección de acceso |

La interfaz muestra esos límites. Una respuesta de consulta tiene fecha visible; no prueba que otro usuario o entorno esté acreditado. La marca del arnés de QA identifica inequívocamente todos sus datos como sintéticos.

## Qué se reutiliza y qué cambia

La base ya tiene OAuth oficial de Google con PKCE, state de un uso y expiración, refresh token cifrado AES-GCM, verificación exacta de scopes de lectura y conexión en Command Center. También existe paquete de entrega de videos. Faltaba una interfaz de Studio conectada a consultas de canal, catálogo y borradores; no se reconstruye OAuth ni se amplían permisos.

Nueva ruta `/dashboard/youtube`, accesible desde el enlace añadido en Command Center. API nueva GET `/api/distribution/youtube/studio` autentica con getUser, filtra owner explícito antes de resolver cualquier token, repite el owner check en memoria y devuelve sólo DTOs. La Biblioteca consulta videos completed con video_path existente del propio usuario, sin modificarla. Título de fuente = topic del contrato existente. No se firman ni copian medios ni se genera video. Enlaces a Reels, Long Form, Biblioteca y Command Center reutilizan rutas actuales.

Al abrir se leen conexiones guardadas y videos terminados; **no se consulta Google automáticamente**. Una pulsación de consulta renueva el access token en servidor y consulta channels.list, playlistItems.list y videos.list (máximo 25 por página). Cada página vuelve a consultar el canal y el listado correspondiente; sin bucles automáticos ni search.list. Analytics sólo con pulsación explícita y scope ya concedido. Ventana de 28 días hasta hace dos días. No se inventan filas ni métricas ausentes; hidden subscribers/otras métricas dependen de Google. Duración ≤180s es sólo posible Short porque falta la relación de aspecto/metadatos definitivos.

El access token nunca se persiste ni vuelve al browser; refresh token sólo en la infraestructura cifrada existente. No se registran respuestas de tokens, encabezados ni errores originales. Errores públicos enumerados. Permisos insuficientes mantienen HTTP403; cuota agotada usa HTTP429. No se clasifica un error de permisos como cuota. Headers private,no-store y Vary Cookie; timeouts de transporte; cero reintentos. No hay handler de escritura, import de upload ni scheduler ejecutable.

## Gate de configuración encontrado durante el cierre

Una lectura de metadatos Vercel sin descifrado (21nov2026) confirmó que GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI y YOUTUBE_TOKEN_ENC_KEY sólo tienen target production. El Preview de esta rama no tiene esos bindings. No se leyeron valores ni se modificaron secretos. Supabase tiene bindings Preview existentes, por lo que no se debe recomendar reconectar contra un almacenamiento compartido.

La API devuelve únicamente un booleano googleReadConfigured de presencia; no acredita que las credenciales sean válidas. Si falta configuración, la interfaz bloquea conexión y consultas Google y explica el motivo. Los borradores locales siguen funcionando. Una petición manual de lectura sin configuración falla503 antes de recuperar el envelope. El Preview actual queda **BLOQUEADO para Google real**, además del gate de sesión propietaria. Habilitar configuración existente para un Preview aislado de esta rama requiere autorización específica; no se hace en esta misión. Producción no cambia.

## Borradores

Preparar título, descripción, tags, privacidad, miniatura y fecha no publica ni programa. Guardado explícito por UUID de usuario en localStorage, esquema versionado, importación allowlist al recuperar, errores de corrupción y espacio visibles. Mismo botón reescribe el mismo borrador: no crea trabajos repetidos. Exportación JSON para continuidad. **Sólo este navegador/teléfono, sin sincronización ni durabilidad externa automática**. No almacenar secretos en el borrador. Un dispositivo compartido no es un almacén privado contra otros usuarios del mismo perfil del navegador.

Valida fuente terminada propia, título1–100/desc≤5000 sin `<`/`>`, tags≤500 incluidos separadores/comillas, privacidad enum. Fecha UTC preparada ≥15 minutos, privada si hay fecha; la entrada usa zona local del teléfono y muestra UTC. Miniatura real decodificada JPG/PNG≤2MB, ≥640px, 16:9 y SHA256 local. Guarda nombre/hash, **no binario**: tras recargar se debe seleccionar de nuevo. Compatibilidad de miniatura de Shorts requiere verificación posterior del flujo oficial, no se promete carga.

La publicación, programación y desconexión Google están deshabilitadas. Revocar es escritura externa, fuera de autorización. Reconectar reutiliza el flujo de solo lectura; el callback existente devuelve JSON y la persona debe volver al Studio. No se cambió su redirect, secretos ni scopes. La renovación intenta usar conexión actual; sólo `invalid_grant` HTTP400 se presenta como reconexión. Un fallo de cliente OAuth, clave/cifrado, transporte o respuesta inválida devuelve unavailable503 sin revelar el error y sin solicitar nuevo consentimiento. No se modifica el fundamento OAuth compartido. No hay prueba OAuth real en esta misión.

## Arquitectura futura, sin ejecución

Un futuro worker de publicación necesita consentimiento por operación, scopes verificados, usuario/canal/fingerprint de video y metadata como clave idempotente durable, transiciones PREPARED→AUTHORIZED→SUBMITTING→UPLOADED/RECONCILIATION_REQUIRED, recibo provider antes de reintentar y cancelación que no prometa deshacer una subida ya enviada. Tras respuesta ambigua no reenviar. No activar con un env toggle. Requiere otra revisión/autorización y persistencia transaccional aprobada: **esa capacidad no está implementada ni habilitada por este PR**. El estado actual sólo admite DRAFT local.

## QA y límites de evidencia

- 35 pruebas directas node/tsx: Studio15, OAuth8, conexión Command Center7, paquete5. Cinco regresiones nuevas cubren refresh/errores de configuración, cifrado, transporte y respuestas inválidas; las pruebas previas se conservan. Además, 27 regresiones de Long Form/Reels/Biblioteca (57 antes, 62 después, sin contar repeticiones). Sin llamadas Google. Conservar el primer FAIL (el test legado prohibía enlaces en el botón; el enlace se movió al contenedor sin alterar el botón ni la prueba).
- TypeScript y ESLint de archivos tocados aprobados. next typegen requerido antes de typecheck por LayoutProps generado. Build de producción con Webpack aprobado; default Turbopack no pudo resolver el symlink local de node_modules (fuera del root). No se cambia configuración global por ello.
- `scripts/youtube-studio/qa.mjs`: componente cliente real, CSS productivo, React y Chromium reales. HTTP reemplazado por fixtures explícitos, sin backend Supabase/Google real. 390×844, 412×915,1440×900, guardado/reload, previsualización, filtros, Analytics fixture, errores de cuota, botones de escritura deshabilitados. Axe WCAG2/2.1 AA, cero serious/critical y cero overflow. Se preservan FAIL de labels y contraste previos; contraste del botón reutilizado corregido sólo dentro del Studio, sin editar componente compartido.
- Esta prueba NO es E2E autenticado de Next→Supabase→Google ni una sesión física Samsung. Falta una sesión owner autorizada para esa verificación. El Preview anterior está READY y ligado a 7dbe4ee; debe verificarse otro Preview del SHA final después del push. Su protección SSO no es evidencia de OAuth de ATOMIVID. Producción sin sesión responde redirect de login: eso no acredita el módulo desplegado.
- Las pruebas locales y CI no consultan Supabase productivo ni Google. En el cierre previo se hicieron SELECTs de sólo lectura de esquema/RLS y agregados de conexiones: una conexión activa con scopes almacenados de lectura, sin seleccionar tokens ni datos de clientes. Eso no acredita que Google acepte la conexión hoy. En esta continuación no se repiten esas consultas ni se consumen cuotas Google. Se leyó changelog/documentación Supabase y se conservan APIs existentes; no hay esquema, grants, secretos ni migraciones.
- CI nuevo fixture-only: checkout, npm ci, typegen/typecheck, ESLint, tests, build, Chromium/axe. No secrets ni servicios de pago; sin deploy desde el workflow. Integraciones PR existentes pueden crear Preview automáticamente según configuración del repositorio; no se ejecuta promoción ni despliegue manual.

## Android, después de autorizar e integrar

Abrir el Preview exacto del SHA final (enlace en PR/entrega) con acceso Vercel y sesión propia ATOMIVID; después de un despliegue autorizado, abrir `/dashboard/youtube`, o Command Center → Abrir YouTube Studio. Usar primero la conexión existente. No reconectar desde un Preview contra almacenamiento compartido con producción sin verificar entorno/callback y autorización de esa escritura. Si no existe sesión autorizada o Google devuelve un error, registrar el bloqueo sin extraer secretos ni suplantar al propietario. Consultar explícitamente canal/videos o estadísticas; buscar y filtrar. Elegir video terminado, editar metadata, fecha deseada y miniatura; Guardar borrador, Exportar borrador o Previsualizar. No hay botón operativo de publicación. Volver a seleccionar el archivo de miniatura tras recargar. El enlace productivo aún no contiene este candidato hasta un merge/deploy autorizado; no presentarlo como operativo allí.

## Restauración y rollback

El paquete incluye el árbol completo del candidato, cambios, logs, imágenes, SHA256SUMS y un bundle snapshot shallow en el HEAD entregado. No es un espejo de toda la historia. COMMIT.txt y SHALLOW-BOUNDARY.txt permiten a restore.py establecer la frontera antes de fetch y fsck. No necesita alternates ni archivos de esta instancia. Se conserva también el código en la rama remota. Drive debe verificarse mediante descarga de los bytes, CRC, hashes y restauración en directorio nuevo; el informe externo recoge los recibos y el resultado real. Conservar la entrega anterior intacta.

Rollback de esta propuesta sin migraciones: conservar rama base intacta, no fusionar; si hubiera integración futura, revertir el commit de este PR y redeploy de la revisión anterior sólo con autorización. El gate previo aplicó el diff inverso en un clon aislado, comparó el árbol con la base y reaplicó el diff, terminando limpio. Se repite si cambia el diff. No equivale a un rollback productivo ejecutado. No borrar borradores ni videos como rollback.

## Dictamen

Candidato local útil para revisión. GO PARA REVISIÓN sólo con PR en borrador, CI final aprobado y límites visibles. OAuth/Google real, revocación, upload, publicación, programación y móvil físico siguen NO PROBADOS o BLOQUEADOS según sus autorizaciones. Nunca GO de publicación real.

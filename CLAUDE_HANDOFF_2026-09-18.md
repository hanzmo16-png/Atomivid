# ATOMIVID — traspaso a Claude — 18 septiembre 2026

## Encargo del propietario

Continuar el proyecto exactamente desde su estado actual. El propietario pidió preparar el traspaso a Claude; Codex deja de hacer cambios funcionales para evitar trabajo simultáneo. Este commit solo documenta el traspaso: no activa generación ni cambia configuración.

## Primera lectura y sincronización

1. Lee AGENTS.md y docs/AVATAR_PREFLIGHT_STATUS.md en la rama codex/avatar-preflight.
2. Comprueba git status, ramas y referencias remotas antes de modificar nada. Conserva cambios locales ajenos. No uses force push, reset destructivo ni fusiones ciegas.
3. La rama de trabajo de Codex es codex/avatar-preflight. Su último commit previo a este traspaso era 8d60056491f7a208a799c6ecd3659c6e3d9c3741. No supongas que esta rama es la rama de producción.
4. El despliegue de producción inspeccionado usa claude/atomivid-mvp-setup-0079jv y commit 2d0e30ebe13bf0d99842cfc97b8aa7b01f340338. Compara referencias antes de proponer cambios.

## Última verificación directa en esta sesión

- La publicación de producción 9P6fVJ9XP88rHG3ofeymC53WuHTz seguía Queued (en cola), no Ready. Su página: https://vercel.com/atomivid/atomivid/9P6fVJ9XP88rHG3ofeymC53WuHTz
- Vercel mostró "Another build is in progress"; la vista de cola solo mostraba dos publicaciones en espera. No se confirmó un build activo causante ni un error de código.
- La otra publicación en cola era Preview 4Sx3Ygh2mWGAX2sb48nADMceYPoA, commit 8d60056 de codex/avatar-preflight. No confundirla con producción.
- https://www.vercel-status.com/ mostraba incidencia activa "Elevated Errors Triggering Deployments", inicio 20:32 UTC y actualización 20:56 UTC, con afectación parcial a Builds / Build & Deploy. Revalidar al retomar: este estado puede cambiar.
- No se canceló ni relanzó ninguna publicación durante esta sesión. La cancelación y el relanzamiento autorizados ocurrieron antes y están documentados en AVATAR_PREFLIGHT_STATUS.md.
- No se verificó que el formulario/botón de avatar sea visible para la cuenta beta. No afirmar que ya está habilitado.
- No se generaron videos, no se consumieron créditos D-ID, no se hicieron compras ni cambios de plan durante esta sesión.

## Configuración y evidencia heredadas de la bitácora

Estas afirmaciones están registradas en docs/AVATAR_PREFLIGHT_STATUS.md; no se reejecutaron sus pruebas durante este traspaso:

- La variable de producción AVATAR_PREPARATION_OWNER_EMAIL fue corregida para la cuenta beta exacta indicada por el propietario, no su correo personal. Mantener acceso a una sola cuenta. Recuperar su valor por un canal privado autorizado; no publicar el correo en el repositorio.
- AVATAR_MODE_ENABLED=false. Preparación privada y generación real son pasos distintos.
- Grabación original medida: 42.794 s, 699576 bytes. Límite configurado de audio: 45 s. No recortar ni sustituir el audio; no usar fallback TTS.
- Se reportaron 32 pruebas específicas aprobadas con fixtures/proveedores simulados. No constituyen prueba real de generación ni verificación de producción.
- El despliegue anterior o36ccZuUDqKuD9grQ1z6pWBqu1uX se reportó Ready / Production / Current. Confirmar qué despliegue tiene actualmente asignado atomivid.vercel.app.

## Pendientes concretos, en orden

1. Revisa el estado del despliegue de producción pendiente y el dominio vigente. Evita crear más despliegues mientras siga la incidencia o el intento actual continúe pendiente. Si falla, lee su error antes de reintentar.
2. Cuando quede Ready y asignado al dominio, verifica con la cuenta beta la visibilidad del formulario privado. El navegador de Codex no tenía sesión autenticada válida de ATOMIVID ni D-ID en la última inspección; las sesiones no se transfieren automáticamente a Claude. Nunca pedir contraseñas o códigos en el chat.
3. Comprueba el acceso privado y la carga de foto/audio con controles de propietario, formato y duración. La preparación aún no equivale a una solicitud renderizable: falta verificar asociación con solicitud, validación del audio en servidor y activos privados antes de la prueba real.
4. Verifica saldo actual de la API de D-ID, consumo exacto de la prueba y cualquier costo adicional/requisito de plan. La bitácora identifica GET https://api.d-id.com/credits como consulta de solo lectura; revalida su documentación. El workflow existente descarta el cuerpo y no confirma el saldo. No sustituir saldo real por capturas viejas o precios orientativos.
5. Reporta al propietario los datos verificados y DETENTE hasta recibir autorización expresa para UNA generación real. El pedido de retomar o preparar el traspaso no autoriza consumir créditos.
6. Verifica videos existentes y facturación con comprobaciones de solo lectura; no generar un video ordinario como prueba de regresión sin autorización de consumo.

## Restricciones obligatorias

- Sin compras, cambios de plan, activación pública ni acceso de otros usuarios.
- No generar con D-ID ni activar el worker real antes del informe de consumo/saldo y autorización expresa.
- Repositorio PÚBLICO: no guardar foto/audio personal, correos privados, saldos, claves, tokens, URLs firmadas o credenciales en archivos, commits, issues ni logs públicos.
- No asumir que archivos temporales, sesiones del navegador o adjuntos de ChatGPT existen en el entorno de Claude. Solicitar solo el elemento realmente faltante cuando sea necesario.
- Mantener videos, suscripción y comportamiento existente. No repetir migraciones o pruebas pagadas ya realizadas sin evidencia de necesidad.
- Al terminar cada bloque, registrar qué cambió, qué se verificó y qué sigue pendiente. Hablar al propietario en español sencillo y no afirmar éxito sin evidencia.

## Enlaces de continuidad

- Repositorio: https://github.com/hanzmo16-png/Atomivid
- Rama de traspaso: https://github.com/hanzmo16-png/Atomivid/tree/codex/avatar-preflight
- Aplicación: https://atomivid.vercel.app
- Estado de Vercel: https://www.vercel-status.com/

El propietario mantiene la dirección del proyecto. Esta guía preserva el estado y no concede autorizaciones adicionales.

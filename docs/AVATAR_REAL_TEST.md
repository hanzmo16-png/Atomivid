> Actualización 2026-09-18: ya existen reserva persistente (0014), medición de audio
> y recuperación D-ID por GET sin regeneración. Falta acceso a configuración
> Vercel y confirmar créditos/tarifa antes de la prueba pagada (límite USD 10).
> Ninguna foto privada está versionada.

# Prueba con la fotografía del propietario — ejecución pendiente de acceso y costo

Revisión: 2026-09-18. Ninguna llamada pagada ni contratación en esta fase.

## Fotografía y carga privada

La prueba real usará exclusivamente una fotografía de Hans, con su consentimiento.
JPEG o PNG, máximo 10 MB según la [FAQ oficial](https://www.d-id.com/).
ATOMIVID comprueba además tamaño mínimo de 4096 bytes y, cuando puede leer
dimensiones, entre 200 y 8000 píxeles por lado. Para esta prueba elegir una
foto de frente, nítida, bien iluminada, con una sola persona y sin tapar la boca
(recomendación de preparación, no una garantía de calidad del proveedor).
No utilizar WEBP en D-ID aunque el validador general lo permita.

Ruta existente en código: `/dashboard/new` → modo avatar → fotografía propia
y consentimiento. La Server Action guarda la foto bajo `user.id/UUID` en
`avatar-uploads` privado y la envía al proveedor. Por tanto, enviar el formulario
con un proveedor real **ya realiza una llamada externa**; no es una zona de
preparación sin consumo. No activar el modo ni pedir al usuario que envíe su foto
por ese formulario antes de confirmar despliegue, cuenta, costo y autorización.
No copiar fotos, audio privado o URLs firmadas a git, logs o artifacts.

## Contrato y fuentes oficiales consultadas

- [V2 Photo Avatars](https://docs.d-id.com/docs/v2-photo-avatar-quickstart):
  POST `/talks`, seguimiento por GET del ID y descarga del resultado.
- [Create a talk](https://docs.d-id.com/reference/createtalk): admite
  TextScript o AudioScript. ATOMIVID usa audio externo de ElevenLabs;
  no necesita contratar TTS interno de D-ID para este flujo.
- [API keys](https://docs.d-id.com/reference/basic-authentication): credencial
  entregada como usuario:contraseña. El adaptador la codifica una vez para
  Basic HTTP. La guía muestra una notación simplificada del header; la referencia
  de Create a talk identifica Basic/base64. No se verificó autenticación real.

## Precio: no convertir el estimado anterior en autorización

La [página oficial de precios API](https://www.d-id.com/pricing/api/) es accesible,
pero su tabla no apareció en el contenido extraído. Un resultado indexado oficial
anuncia Trial $0 / 14 días y Build $14.40 por mes equivalente a $172.80 facturados
anualmente; **no confirma la oferta disponible en la cuenta de Hans**, créditos
aplicables, impuestos ni un desembolso mensual mínimo. No contratar el anual.
No usar tarifas del Studio o la app móvil para inferir tarifas API.

Se necesita confirmar en la cuenta API la disponibilidad de prueba/créditos,
vigencia y precio por generación o unidad facturable antes de autorizar el intento.
El estimado previo de $1–1.50 por 10–15 segundos procede de terceros y no está
validado; no es un presupuesto aprobado. La voz de ElevenLabs se calcula aparte.

## Ejecución única pendiente

No ejecutar el pipeline pagado actual sin cerrar estos puntos:

1. Confirmar cuenta/credencial, tarifa, créditos y autorización explícita con
   monto máximo total; usar exclusivamente la foto suministrada por Hans.
2. Preparar audio de 10–15 s, medir duración real con ffprobe antes del POST.
   Si falla el audio propio, detenerse: no pasar silenciosamente a TTS de D-ID.
3. Reclamar de forma persistente un único intento antes del POST; conservar
   el ID inmediatamente después. Ante timeout ambiguo no volver a crear el talk.
4. Consultar solo el ID existente, descargar en almacenamiento privado,
   comprobar reproducción y revisar parecido/sincronización con Hans.

**Actualización 2026-09-18:** el pipeline ahora se detiene ante errores de
síntesis/subida/firma de narración y verifica jobs existentes antes de volver
a sintetizar. La duración y costo todavía se estiman por palabras. Eso no garantiza un límite monetario
real. La reserva persistente de intento único está implementada en la migración 0014
y el pipeline: requiere aplicar la migración antes de activar el modo.
No se libera automáticamente ante fallos; el intento necesita revisión.

Los fixtures verifican orquestación, no identidad, calidad o sincronización labial.
El modo avatar aún no añade subtítulos ni música; el MP4 simulado no prueba eso.

## Avance 2026-09-18 — autorización y protección de consumo

Hans autorizó continuar tomando decisiones técnicas y proporcionó su fotografía.
Se conserva el límite previo de USD 10 acumulados; no contratar planes ni recargar.
La foto se validó localmente como JPEG 1536×1536, 336788 bytes. No se copió a git.
La autorización no confirma una cuenta API, créditos o tarifas de D-ID.

- Migración 0014: reserva duradera antes de sintetizar voz. Los workers concurrentes
  y los reintentos sin job conocido se bloquean. Si falta la columna, falla sin consumo.
- D-ID y HeyGen: cero reintentos del POST de creación de video; callback para guardar
  el job inmediatamente al recibirlo, antes del sondeo o descarga.
- Un timeout ambiguo queda bloqueado para revisión; no se garantiza recuperación
  automática del resultado. Los intentos fallidos antes del POST también quedan bloqueados.
- Pendientes para la prueba real: aplicar 0014, verificar despliegue y credencial D-ID,
  confirmar costo/créditos, medir duración real del audio antes del POST y recuperar
  resultados por ID sin regenerarlos. No se ejecutó ningún proveedor pagado.

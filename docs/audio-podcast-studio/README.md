# Audio Podcast Studio 1.0

Módulo nuevo y aislado para crear podcasts **solo audio**. Ruta: `/dashboard/audio-studio`.

## Alcance de 1.0

- Crear y guardar episodios con una o dos voces: perfiles de voz en español latinoamericano.
- Editor de guion:
  - guardado manual y automático;
  - control de revisión para que dos pestañas no se pisen;
  - aviso antes de cerrar con cambios sin guardar.
- Música de fondo propia (CC0), en tres modos:
  - **inteligente**: un ambiente por sección, según el texto;
  - **un solo ambiente**;
  - **sin música**.

  También se configuran el volumen, la atenuación bajo la voz, la entrada y el cierre.
- Presupuesto visible: costo estimado de voz, tope del episodio y gasto real.
  - La tarifa nunca es menor que USD 0.20 por 1 000 caracteres (la tarifa de producción).
  - El gasto real es USD 0.00: 1.0 no hace llamadas de pago.
- Biblioteca de audio con «Activos» y «Archivados». Archivar no borra nada.
- Estado «Listo para autorizar»: el contenido está completo y dentro del tope.
- **La generación real con ElevenLabs está bloqueada.** «Generar audio real…» responde 409 con una explicación y no llama a ningún proveedor. Activarla requiere una autorización de gasto posterior y un cambio de código revisado.

### Primer episodio

El primer episodio se carga como proyecto editable para la cuenta interna del dueño:

- Título: «El día que entiendes que no puedes controlarlo todo».
- Voz: Mateo, masculina profesional, español latinoamericano.
- Duración: objetivo 18 min; estimado 17.9 min.
- Costo estimado: unos USD 3.04, con un tope de USD 6.
- Guion original sobre estoicismo, en 15 secciones.

Su id es estable por cuenta, así que nunca se duplica ni pisa una versión editada.

## Aislamiento

- **Código**
  - El módulo vive en:
    - `src/lib/audio-studio/**`
    - `src/app/dashboard/audio-studio/**`
    - `src/app/api/audio-studio/**`
  - No importa nada de Podcast Studio Premium (`src/lib/podcast/**`, `src/app/dashboard/podcast/**`, `src/components/podcast/**`), ni proveedores, ni ledger. Una prueba lo verifica.
  - Fuera del módulo solo cambia `src/app/dashboard/layout.tsx`, con el enlace «Audio Podcast»: en la franja móvil (< 640 px) y en la barra desde 1024 px. Entre 640 y 1023 px no se añade a la barra porque la desbordaría y taparía la ayuda (defecto M3-1, prueba `qa-m3-movil`); allí se entra por `/dashboard/audio-studio`.
- **Datos**
  - No hay migraciones ni tablas nuevas.
  - Cada proyecto es un JSON en el bucket privado existente `videos`, bajo `audio-studio/v1/<id de cuenta>/<id de proyecto>.json`.
  - El estudio nunca lee, escribe ni borra fuera de ese prefijo. Ningún otro módulo lo usa.
- **Cuentas**
  - La ruta se construye solo con el id de la sesión autenticada. Los ids se validan como UUID, así que no admite `../`.
  - Otra cuenta recibe 404 al leer, editar, archivar o generar un proyecto ajeno.
  - Sin sesión: 401 en la API y redirección a `/login` en la página.
  - Las acciones POST/PUT exigen `Content-Type: application/json`, lo que frena los envíos cruzados desde otro sitio.
- **Acceso**: misma lista privada que Podcast y Long Form (beta y cuenta interna del dueño).

## Interruptor

`AUDIO_STUDIO_DISABLED=1` apaga a la vez:

- la ruta (404);
- la API (403);
- el enlace del panel.

No hace falta desplegar código. No es un secreto.

## Respaldo y recuperación

1. **Antes del despliegue.** No hay datos previos del módulo. Producción solo gana archivos nuevos bajo `videos/audio-studio/v1/`. Nada existente se modifica.
2. **Respaldo de proyectos.** Descargar el prefijo `videos/audio-studio/v1/` con la clave de servicio, desde un entorno autorizado. Cada archivo es autocontenido y lleva `version: "audio-studio-1.0"` y `revision`.
3. **Restaurar un proyecto.** Volver a subir su JSON a la misma ruta. Al leerlo, el estudio lo valida contra el esquema y la cuenta (`parseStored`). Un archivo corrupto o ajeno se ignora y nunca se ejecuta.
4. **Retirar el módulo sin desplegar.** Poner `AUDIO_STUDIO_DISABLED=1`. Los proyectos guardados quedan intactos.
5. **Revertir el código.** Usar `git revert` del commit de merge del PR. Sin migraciones, no hay nada que deshacer en la base. Los JSON del prefijo pueden quedarse: ningún otro módulo los lee.

## Pruebas

| Tipo | Archivo | Qué cubre |
|---|---|---|
| Unitarias, integración y seguridad | `src/lib/audio-studio/audio-studio.test.ts` | Modelo, servicio, almacén en Storage simulado, aislamiento, costo, bloqueo de pago, aislamiento de código |
| Render | `src/app/dashboard/audio-studio/audio-studio.render.test.tsx` | Biblioteca y editor |
| E2E | `scripts/harness/e2e/audio-studio/audio-studio-e2e.cjs` | Ver abajo |

El E2E corre en Samsung 390×844 y en escritorio 1440×900, con un arnés local sin red externa. Cubre:

- enlace en el panel y episodio inicial;
- creación y guardado de episodios, con conservación tras recargar;
- guardado automático y conflicto entre pestañas;
- música y presupuesto;
- generación bloqueada;
- archivar y restaurar;
- aislamiento entre cuentas por interfaz y por API;
- 401 sin sesión y 415 para envíos que no son JSON;
- portada, Podcast Premium, Long Form y Facturación siguen respondiendo;
- ningún archivo previo del Storage local borrado;
- ninguna salida a proveedores reales.

CI: `.github/workflows/audio-podcast-studio.yml`.

## Verificación en producción

`.github/workflows/audio-studio-produccion.yml` se lanza manualmente después del despliegue. Cuesta USD 0.

- **`publico`**: sin sesión ni secretos, en escritorio y con agente de móvil. Comprueba:
  - la ruta, que redirige a `/login`;
  - la API, que responde 401;
  - el envío que no es JSON, que responde 415;
  - que los módulos anteriores siguen respondiendo.
- **`episodio`**: deja cargado el episodio inicial del dueño de forma idempotente y lo relee.
  - Usa los secretos ya existentes `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `INTERNAL_PRODUCTION_OWNER_USER_ID`, sin modificarlos.
  - Solo escribe bajo `videos/audio-studio/v1/<dueño>/`.

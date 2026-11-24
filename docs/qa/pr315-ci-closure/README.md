# PR315 — cierre técnico aislado

Base de trabajo:87cfd11b1794ef5b6aa3c4671d70f3877803ec4d (PR315). Referencia fallida35e5c67d2e5ba259dff50da3a5171eced78f1b75; base productiva890eef5e6683cd9cb18590a9acf35682d27bd90e.

- qa-m3-movil:19PASS/1FAIL a640px, ayuda tapada tras desborde de cabecera. Claude ya corrigió el layout en d79a838; sus pasosM3-1 yM3-2 posteriores pasaron. Se conserva su corrección sin editar portada/layout/CSS/nav/componentes cinematográficos. El resto del run fue cancelado por una actualización, no se declara workflowPASS.
- audio-podcast-studio:el enlace estaba ausente en el diseño inicial;0PASS/2FAIL. Claude recuperó la fila de estudios en d79a838. No se modifica código AudioStudio ni se cambian sus criterios.
- podcast-3-0-e2e:caso11 usa una clase de implementación obsoleta `header div.sm:hidden`. Se cambia por un enlace visible con el mismo destino exacto, textoPodcast y unicidad. No se sustituye el clic por navegación directa ni se omiten generación/reproducción/descarga del caso.
- longform-e2e-cierre:73PASS/2FAIL;el modal onboarding interceptó el clic de descarga Samsung. El arnés tragaba cualquier error al intentar Omitir durante4s. Ahora espera al diálogo de primera visita, lo omite mediante un clic real y exige cierre+persistencia. Visitas ya completadas no requieren diálogo. No se fuerza el clic, modifica localStorage ni oculta la hoja desde el test.

No se atribuyen a nuevos motores defectos de navegación ni se afirma que los fallos anteriores a315 estén certificados ausentes sin reproducción base. La carrera del onboarding es un defecto latente del arnés:el helper anterior también existe en producción;se demuestra con una hidratación retrasada. La rotura del selectorPodcast es incompatibilidad del arnés con la nueva estructura, no fallo del motor de audio. M3 y ausencia de enlaces sí correspondían al primer diseño y fueron corregidos por Claude.

Regresiones nuevas:5 testsPlaywright en fixtures HTML, incluidas ruta incorrecta y cierre de diálogo roto que deben rechazarse. No son sesionesGoogle ni generaciones de pago. Se ejecutan en el workflowLongForm antes de su recorrido auténtico local. Los E2E existentes mantienen umbrales, aserciones, controles de egress, QC y comparaciónSHA de descargas.

Reproducir:infra/setup.sh; desde paths.env tomarCHROME y PLAYWRIGHT_MODULE; `node --test scripts/harness/e2e/shared/contracts.browser.test.cjs`. Para la aplicación usar los workflows originales gratis con sus proveedores loopback y BD desechable. Nunca usar credenciales ni datosSupabase productivos. Linux local:PostgreSQL17 y espeak se extrajeron desde paquetesDebian a un directorio de usuario;Chrome149 originalRemotion se descargó con curl porque Node directo no podía salir por el proxy. No se cambió receta ni dependencia del producto.

Rollback:descartar únicamente los commitsCodex. No hay migraciones, secretos, proveedores ni cambios productivos. PR apilado sobre la rama deClaude para que su diff contenga solo el arnés y esta documentación. No fusionar315 ni desplegar su interfaz sin revisión visual deHans.

## Segundo hallazgo conservado — descarga Audio en CI

El run45439462554 sobre06f65a1 terminó148PASS/3FAIL:Next devolvióHTML404 en tres descargas; no se observó ninguna firma de audio en el gateway. La misma revisión local pasó151/151. Se conservó el artefacto14942809969 con CRC y digest fc1454b6455a934103b742a1e21611045ddac0bad1f53234fe3e6c216830a7e4. Node22.23.5 y arranque frío locales responden401JSON sin sesión en esa ruta; no se atribuye todavía la discrepancia a un defecto productivo ni se declara corregida su causa raíz.

Se añaden controles estrictos:antes de sintetizar, la ruta real autenticada debe devolver el404JSON propio del handler para un UUID inexistente;un404HTML falla inmediatamente. La descarga registra el primer salto, exige302→200 y bytesMP3 y jamás sigue una URL fuera de loopback ni cadenas de redirección. No hay reintentos, acceso directo alternativo aStorage ni conversión de404aPASS. Cinco pruebas con doblesHTTP cubren404HTML, destinoexterno,302adicional y cuerposfalsos. El gate nuevo puede revelar antes un entorno no listo;un verde posterior no demuestra por sí solo la causa raíz del fallo original.

Los workflowsAudio yPodcast3 ahora aceptan también PR dirigidos exactamente a feature/cinematic-ui-experience-v1. Así el checkout de GitHub valida la combinación de la corrección con la base actual de315, sin fusionar ni actualizar su rama. M3 incluye el arnés compartido en su filtro de rutas. No se eliminan destinos, pasos, permisos, aserciones o umbrales; no se ejecuta el workflow cinematográfico de pago.

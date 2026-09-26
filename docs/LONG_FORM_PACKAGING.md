# Long Form — Portada de apertura y miniatura de YouTube

Dos opciones **independientes** en «Configurar producción» (`/dashboard/long-form/configure/[id]`): ninguna, una o ambas.

| Opción | Qué produce | Dónde se ve |
| --- | --- | --- |
| Portada de apertura | Título grande sobre la primera escena (incluido el fotograma 0), que se desvanece al terminarla (1.5–3.2 s) | Dentro de `final.mp4` |
| Miniatura de YouTube | JPG 1280×720 con la misma identidad visual | `{requestId}/output/thumbnail.jpg`, con vista y descarga en el resultado |

## Comportamiento

- **Opciones por defecto:**
  - en los canales propios de Hans (`AVATAR_PREPARATION_OWNER_EMAIL` o la lista `LONG_FORM_OWN_CHANNEL_EMAILS`) ambas vienen activadas;
  - para cualquier otra cuenta, ambas vienen desactivadas.
- **Título sugerido:** sale del tema del video (lo que va antes de «:») y el cliente lo edita. `*palabra*` resalta una palabra.
- **Estilos:** «Impacto» (amarillo), «Alerta» (rojo, con placa) y «Sobrio» (blanco).
- **Vista previa** del primer fotograma o de la miniatura:
  - usa el mismo componente y las mismas reglas que el render (`remotion/OpeningTitle.tsx`, `remotion/cover-rules.ts`);
  - el fondo es de ejemplo, porque la primera escena se decide al producir;
  - muestra con líneas punteadas las zonas reservadas.
- **Alcance:** solo los planes v3 (visuales anclados) la aplican. v1/v2, Shorts y Avatar no cambian.
- **Almacenamiento:** se guarda en `ProductionPlan.packaging`, dentro del plan confirmado; no requiere migración.
- **Costo:** ninguno de proveedores; se renderiza con Remotion.

## Validaciones (`remotion/cover-rules.ts`)

| Regla | Portada (1920×1080) | Miniatura (1280×720) |
| --- | --- | --- |
| Título | ≤ 40 caracteres, 1–3 líneas | ≤ 32 caracteres, 1–3 líneas |
| Tamaño mínimo legible | 84 px (nunca se encoge por debajo) | 96 px |
| Márgenes seguros | 96 / 64 px | 48 / 40 px |
| Antetítulo | ≤ 32 caracteres | ≤ 28 caracteres |
| Zonas reservadas | subtítulos (y ≥ 780) y rótulos «Recreación IA» / créditos (arriba a la izquierda) | duración de YouTube (abajo a la derecha) |

Además, en ambos lienzos:

- contraste ≥ 4.5:1 en todos los estilos;
- énfasis `*…*` cerrado;
- aviso (no error) si se da el rectángulo del sujeto y el título lo tapa;
- métrica real de la fuente Anton (anchos de glifo) y espacio extra en las líneas con tildes o Ñ.

## Dónde se valida

- **Navegador:** muestra las incidencias y bloquea «Confirmar» mientras una opción activada tenga errores.
- **Servidor (`confirm-production`):** revalida siempre (400 si falla). La portada se valida en el peor caso, con rótulos arriba a la izquierda.
- **Render:**
  - la portada se revalida con la primera escena real; si no pasa, el video se produce sin portada y se registra un aviso;
  - la miniatura se revalida también; si falla, el video no se ve afectado.

## Limitaciones

- La vista previa no usa la primera escena real (aún no existe al configurar).
- No hay entidad «canal» en la base de datos: la cuenta equivale al canal.
- La miniatura solo se genera si la primera escena es un medio (imagen o video), no una tarjeta.

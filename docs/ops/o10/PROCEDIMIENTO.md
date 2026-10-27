# O10 · Merge de #228 (candidato Podcast Studio) a producción

USD 0. O10 no aplica migraciones ni cambia flags, secretos ni datos. Solo integra el código de #228 en la rama de producción
`claude/atomivid-mvp-setup-0079jv`, lo que dispara el despliegue habitual. Las funciones nuevas siguen apagadas hasta O9 (flags).

## Precondiciones (todas, en este orden)

1. O8 COMPLETADO: el run de `o8-ejecucion-unica.yml` terminó en verde, con `o8.sh done`, `o8.sh post` y `o8-postgate.sh`.
2. La revisión de Grok del delta 0acef98 está entregada y sin bloqueos abiertos. Si obliga a cambiar #228, el nuevo head
   sustituye a `FROZEN["228"]` en `gate.py` y necesita CI completa y autorización nueva. No se mergea un head no congelado.
3. CI de #228 en verde sobre el head congelado `0acef98aa8da6f510fa0901121a9c34a8bb061ce` (25/25 checks, incluido
   `director-worker-e2e` lanzado a mano: run 40451253874).
4. `GATE_ONLY=1 GATE_NEXT=O10 bash scripts/qa/schema-readonly/cierre.sh`: **15/15 PASS, 0 FAIL**. Esa puerta exige:
   - estado posterior a O8 (marcadores 000000/120000/130000/140000 = t, 120000/130000/140000 registradas, tablas del
     estudio presentes y vacías);
   - árbol de producción == árbol de #207 (d8b203d), con el último merge como merge commit de #207;
   - head de #228 == 0acef98;
   - **sin trabajo en curso**: ningún episodio de podcast vencido ni ocupado y ningún guion documental en cola o en ejecución.
     Si lo hay, se espera a que termine; nunca se cancela trabajo de usuarios para mergear.

## Operación (una sola vez)

Merge de #228 con **merge commit**, no squash ni rebase: el segundo padre debe ser exactamente 0acef98. Antes, quitar el
estado borrador del PR. Nada más.

## Verificación posterior

1. `GATE_ONLY=1 GATE_NEXT=DONE bash scripts/qa/schema-readonly/cierre.sh`: **13/13 PASS, 0 FAIL**. Exige un árbol de
   producción == árbol de #228 y un merge commit cuyo segundo padre sea 0acef98.
2. El despliegue de producción del merge commit termina en Ready, y la versión del worker coincide con el merge commit.
3. Comprobación en solo lectura (sin cuenta y sin gasto): las rutas nuevas responden y, con el flag apagado, no exponen
   Podcast Studio.

## Contingencia

O10 no toca la base de datos, así que la reversión es solo de código: un **revert del merge commit** en un commit nuevo,
sin force-push ni reescritura de historia, y después un nuevo despliegue. Comprobación: el árbol del commit de revert ==
árbol de #207 (`git rev-parse <revert>^{tree}` frente a `d8b203d^{tree}`), y el despliegue del revert termina en Ready.
La puerta `GATE_NEXT=O10` no vuelve a 15/15 tras un revert, porque el último commit ya no es el merge de #207. Un O10
posterior necesita una puerta y una autorización nuevas. Las migraciones 130000 y 140000 siguen aplicadas: su
contingencia es la de O3 y O8, y no forma parte de O10.

## Lo que O10 no hace

No ejecuta O9 (flags), pruebas reales, gasto, migraciones, secretos ni reencolados. #224 no se mergea nunca.

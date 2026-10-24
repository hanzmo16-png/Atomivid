# Previews de Vercel fallidos en ramas `evidence/*`

## Causa (verificada)
- `evidence/qa-202-203-ux` (6141d31) y `evidence/qa-202-203-headers` (a9eb880) son commits **huérfanos** que publican los
  workflows `qa-aceptacion-ux.yml` y `security-headers.yml` (rama `claude/verify-202-203`): solo capturas PNG/JSON/logs
  (52 y 12 archivos), sin `package.json`, sin app y sin `vercel.json`.
- La integración Git de Vercel despliega toda rama empujada que no esté excluida → intenta construir un árbol sin app →
  estado `Vercel: failure` (dpl_FVRMZFtJxwXmzhHv3rjnCELXJFbB, dpl_EaSCZHGJp3rkiuYWiq3oZ3cBZoJ9, 2026-10-24 18:45 UTC).
  El log de build exige sesión de Vercel (`npx vercel inspect … --logs`); esta auditoría no tiene token de Vercel, así que
  la causa se confirma por el contenido del árbol y el estado del commit, no por el log.
- Mismo patrón ya visto: `ops-sealed-out` (huérfana, sin `vercel.json`) → failure. Las ramas que llevaban en **su propio
  árbol** `deploymentEnabled: { "<rama>": false }` (`claude/video-review` a5687bb, `claude/pilot-deploy` fd5deea) no
  recibieron ningún despliegue.

## Mecanismo oficial
`git.deploymentEnabled` en `vercel.json`, con patrones minimatch por rama (una rama sin regla despliega; con varias
reglas, basta una `true` para desplegar). Docs: https://vercel.com/docs/project-configuration/git-configuration ·
changelog: https://vercel.com/changelog/granular-branch-matching-for-git-configuration-in-vercel-json

## Cambio mínimo (esta rama, sin aplicar)
1. `vercel.json`: `"evidence/*": false` y `"evidence/**": false` (las reglas existentes se conservan).
   `scripts/qa/vercel-deployment-rules.test.cjs` comprueba: evidence/* no despliega; producción
   (`claude/atomivid-mvp-setup-0079jv`), `claude/*`, `grok/*`, `codex/*` y ramas que solo contienen «evidence» sí.
2. Como Vercel lee el `vercel.json` del commit que se despliega (precedente de arriba), un commit huérfano debe llevar el
   suyo. Parche para el paso de publicación de ambos workflows (antes de `git add -A`):
   ```bash
   printf '{\n  "git": { "deploymentEnabled": false }\n}\n' > vercel.json   # rama de evidencias: nunca desplegar
   ```
   Con (1) en la rama de producción y (2) en el árbol de evidencias, la exclusión vale lea Vercel una u otra.

## Qué NO se hizo
Ningún cambio en la configuración activa de Vercel (Ignored Build Step, ajustes del proyecto), ni merge, ni deploy, ni
re-publicación de las ramas `evidence/*`: sus commits y enlaces actuales quedan intactos (re-publicarlas reemplazaría el
commit con `push -f`). Los estados `failure` existentes no afectan a producción ni a otros previews.

## Verificación
- Producción: la rama de producción no coincide con ningún patrón `false` (test).
- Previews de PR de desarrollo: esta misma rama (`claude/…`) debe recibir su preview de Vercel normal tras el push —
  confirma que el `vercel.json` es válido y que las ramas de desarrollo siguen desplegando.
- Tras aplicar (2), el siguiente push a `evidence/*` no debe recibir estado `Vercel` (comprobar con
  `GET /repos/{owner}/{repo}/commits/{sha}/statuses`).

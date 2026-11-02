#!/usr/bin/env bash
# PROPUESTA (no conectada): «Ignored Build Step» de Vercel. Ver docs/propuestas/vercel-builds-controlados.md.
# Convención de Vercel: exit 0 = OMITIR la compilación; exit 1 = COMPILAR.
# Producción compila siempre; las demás ramas solo si el commit pide «[preview]».
PROD_BRANCH="${ATOMIVID_PROD_BRANCH:-claude/atomivid-mvp-setup-0079jv}"
REF="${VERCEL_GIT_COMMIT_REF:-}"
MSG="${VERCEL_GIT_COMMIT_MESSAGE:-}"
if [ -z "$REF" ] || [ "$REF" = "$PROD_BRANCH" ] || [ "${VERCEL_ENV:-}" = "production" ]; then echo "compilar: producción o rama desconocida ($REF)"; exit 1; fi
case "$MSG" in *"[preview]"*) echo "compilar: preview pedida en el commit ($REF)"; exit 1;; esac
echo "omitir: preview no pedida ($REF); añade [preview] al mensaje del commit para generarla"; exit 0

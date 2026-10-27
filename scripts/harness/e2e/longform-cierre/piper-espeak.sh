#!/usr/bin/env bash
# Sustituto local de la CLI de Piper para mock-longform-providers.mjs (USD 0): lee el texto por stdin y escribe el WAV
# indicado con -f usando espeak-ng (voz «es», 155 ppm). -m (modelo) se ignora. Solo para el arnés; no es una voz real.
set -euo pipefail; out=""
while [ $# -gt 0 ]; do case "$1" in -f) out="$2"; shift 2;; -m) shift 2;; *) shift;; esac; done
[ -n "$out" ] || { echo "falta -f" >&2; exit 2; }
espeak-ng -v es -s 155 --stdin -w "$out"

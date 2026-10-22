#!/usr/bin/env bash
# QC de audio de los MP4 entregados por el E2E (proveedores simulados). Umbrales: −16 ±1.5 LUFS integrado,
# true peak ≤ −1 dBTP, 0 muestras recortadas (|x| ≥ 0.999). Escribe JSON por archivo y falla si alguno no cumple.
set -uo pipefail
out=${1:?dir de salida}; shift; fail=0; found=0
for f in "$@"; do
  [ -f "$f" ] || continue; found=$((found+1))
  e=$(ffmpeg -hide_banner -nostats -i "$f" -af ebur128=peak=true -f null - 2>&1)
  I=$(printf '%s' "$e" | awk '/Integrated loudness:/{f=1} f&&/I:/{print $2; exit}')
  TP=$(printf '%s' "$e" | awk '/True peak:/{f=1} f&&/Peak:/{print $2; exit}')
  CL=$(ffmpeg -hide_banner -nostats -i "$f" -map 0:a:0 -ac 1 -f f32le - 2>/dev/null | python3 -c 'import sys,numpy as n;a=n.frombuffer(sys.stdin.buffer.read(),dtype="<f4");print(int((n.abs(a)>=0.999).sum()))')
  ok=$(python3 -c "print(str(abs($I+16)<=1.5 and $TP<=-1 and $CL==0).lower())")
  b=$(basename "$f" .mp4)
  printf '{"archivo":"%s","lufs_integrado":%s,"true_peak_dbtp":%s,"muestras_recortadas":%s,"ok":%s}\n' "$b.mp4" "$I" "$TP" "$CL" "$ok" | tee "$out/$b-audio-qc.json"
  [ "$ok" = true ] || fail=1
done
[ "$found" -gt 0 ] || { echo "::error::no hay MP4 para QC"; exit 1; }
exit $fail

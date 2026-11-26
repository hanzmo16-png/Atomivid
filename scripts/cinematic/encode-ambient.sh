#!/usr/bin/env bash
# Monta y codifica el fondo cinematográfico a partir de los dos clips maestros de Veo (1080p, 8 s):
#   <libre.mp4>  imagen clave → movimiento de cámara libre
#   <bucle.mp4>  imagen clave → misma imagen clave (primer y último fotograma iguales)
# Montaje: libre completo (8 s) + fundido de 1,5 s hacia el tramo 3–8 s del bucle, que termina en la imagen clave =
# primer fotograma del libre ⇒ bucle de 11,5 s sin salto. Salida: H.264 + VP9 sin audio y póster JPEG.
# Uso: encode-ambient.sh <libre.mp4> <bucle.mp4> <landscape|portrait> <outDir> [prefijo=cosmos]
# Variables: FFMPEG (binario), CRF_L / CRF_P (H.264), VP9_CRF.
set -euo pipefail
FREE=$1; LOOP=$2; OR=$3; OUT=$4; P=${5:-cosmos}
FF=${FFMPEG:-ffmpeg}
if [ "$OR" = landscape ]; then S=1280:720; CRF=${CRF_L:-25}; else S=720:1280; CRF=${CRF_P:-26}; fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
"$FF" -loglevel error -y -i "$FREE" -i "$LOOP" -filter_complex "\
[0:v]fps=24,format=yuv420p,split[a1][a2];[a1]trim=0:6.5,setpts=PTS-STARTPTS[head];[a2]trim=6.5:8,setpts=PTS-STARTPTS[ta];\
[1:v]fps=24,format=yuv420p,split[b1][b2];[b1]trim=3:4.5,setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=1.5:alpha=1[tb];\
[b2]trim=4.5:8,setpts=PTS-STARTPTS[rest];[ta][tb]overlay=format=auto,format=yuv420p[mix];[head][mix][rest]concat=n=3:v=1[v]" \
  -map "[v]" -an -c:v libx264 -crf 10 -preset fast "$TMP/master.mp4"
VF="scale=$S:flags=lanczos,format=yuv420p"
"$FF" -loglevel error -y -i "$TMP/master.mp4" -an -vf "$VF" -c:v libx264 -preset slow -crf "$CRF" -profile:v high -movflags +faststart "$OUT/$P-$OR.mp4"
"$FF" -loglevel error -y -i "$TMP/master.mp4" -an -vf "$VF" -c:v libvpx-vp9 -b:v 0 -crf "${VP9_CRF:-38}" -row-mt 1 -deadline good -cpu-used 2 "$OUT/$P-$OR.webm"
"$FF" -loglevel error -y -i "$TMP/master.mp4" -vf "scale=$S:flags=lanczos" -frames:v 1 -q:v 4 "$OUT/$P-$OR-poster.jpg"
ls -l "$OUT/$P-$OR.mp4" "$OUT/$P-$OR.webm" "$OUT/$P-$OR-poster.jpg"

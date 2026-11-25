#!/usr/bin/env bash
# Bucle clásico por fundido (USD 0, solo ffmpeg). Toma un clip ya generado, lo corta en T segundos (antes de cualquier
# defecto del final) y funde los últimos D segundos con los primeros D: la salida empieza en el fotograma D y termina
# justo antes de él ⇒ bucle sin salto por construcción. Duración final = T − D.
# Uso: encode-loop-xfade.sh <clip.mp4> <landscape|portrait> <outDir> [prefijo=cosmos] [T=11.0] [D=1.25]
# Variables: CRF (H.264, por defecto 27), VP9_CRF (por defecto 40).
set -euo pipefail
IN=$1; OR=$2; OUT=$3; P=${4:-cosmos}; T=${5:-11.0}; D=${6:-1.25}
if [ "$OR" = landscape ]; then S=1280:720; else S=720:1280; fi
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
OFF=$(awk "BEGIN{print $T-2*$D}")
ffmpeg -loglevel error -y -i "$IN" -filter_complex "\
[0:v:0]fps=24,scale=$S:flags=lanczos,setsar=1,format=yuv420p,trim=0:$T,setpts=PTS-STARTPTS,split[a][b];\
[a]trim=$D:$T,setpts=PTS-STARTPTS,fps=24[main];[b]trim=0:$D,setpts=PTS-STARTPTS,fps=24[head];\
[main][head]xfade=transition=fade:duration=$D:offset=$OFF,format=yuv420p[v]" -map "[v]" -an -c:v libx264 -crf 6 -preset fast "$TMP/loop.mp4"
ffmpeg -loglevel error -y -i "$TMP/loop.mp4" -an -c:v libx264 -preset slow -crf "${CRF:-27}" -profile:v high -pix_fmt yuv420p -movflags +faststart "$OUT/$P-$OR.mp4"
ffmpeg -loglevel error -y -i "$TMP/loop.mp4" -an -c:v libvpx-vp9 -b:v 0 -crf "${VP9_CRF:-40}" -row-mt 1 -deadline good -cpu-used 2 -pix_fmt yuv420p "$OUT/$P-$OR.webm"
ffmpeg -loglevel error -y -i "$TMP/loop.mp4" -frames:v 1 -q:v 4 "$OUT/$P-$OR-poster.jpg"
ls -l "$OUT/$P-$OR.mp4" "$OUT/$P-$OR.webm" "$OUT/$P-$OR-poster.jpg"

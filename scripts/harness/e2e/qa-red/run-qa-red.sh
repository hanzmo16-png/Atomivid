#!/usr/bin/env bash
# RED por mutación de cada control de media_qa.py director (T-20261019-1602). Parte de un MP4 GREEN + su director.json,
# fabrica una variante defectuosa por control y exige que ESE control falle. Exit 0 solo si todas las mutaciones quedan en RED.
# Uso: run-qa-red.sh <final.mp4> <director.json> <dur> <outdir>
set -u; MP4="$1"; DJ="$2"; DUR="$3"; OUT="$4"; QA="$(dirname "$0")/../media_qa.py"; mkdir -p "$OUT"; rc=0
mut() { # nombre, patrón del control que debe fallar, args ffmpeg
  local name="$1" pat="$2"; shift 2; local v="$OUT/$name.mp4"
  ffmpeg -v error -y -i "$MP4" "$@" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "$v" || { echo "MUT $name: ffmpeg falló"; rc=1; return; }
  python3 "$QA" director "$v" "$DJ" "$OUT/qa-$name" "$DUR" > "$OUT/$name.log" 2>&1
  if grep -E "^FAIL  .*$pat" "$OUT/$name.log" >/dev/null; then echo "RED OK  $name → $(grep -E "^FAIL  .*$pat" "$OUT/$name.log" | head -1 | cut -c1-110)"; else echo "RED MISSING  $name (el control «$pat» no falló)"; rc=1; fi
}
mut letterbox '\[6\] sin letterbox' -vf "scale=1080:1680,pad=1080:1920:0:120:black"
mut black '\[5\] sin negro' -vf "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,5,5.6)'"
mut freeze '\[6\] sin congelados' -vf "loop=loop=75:size=1:start=$(python3 -c "import json;d=json.load(open('$DJ'));s=[x for x in d['props']['scenes'] if x['direction']['motion']!='static'][0];print(int((s['startSeconds']+0.3)*30))"),setpts=N/30/TB,trim=duration=$DUR"
mut loud '\[9\] sonoridad integrada' -af "volume=8dB"
mut clip '\[9\] true peak' -af "volume=30dB,alimiter=limit=1:level=false"
mut silence '\[2\] narración presente' -af "volume=enable='between(t,3,30)':volume=0"
mut nocaptions '\[3\] subtítulos correctos' -vf "drawbox=x=0:y=ih*0.55:w=iw:h=ih*0.35:color=gray:t=fill"
mut nolabel '\[8\] etiqueta visible' -vf "drawbox=x=0:y=0:w=iw*0.6:h=ih*0.1:color=gray:t=fill"
mut nomotion '\[4\] push_in' -vf "trim=end_frame=1,loop=loop=-1:size=1,setpts=N/30/TB" -r 30 -t "$DUR"
mut safearea '\[3\] subtítulos dentro de la zona segura' -vf "pad=iw:ih+200:0:200,crop=iw:1920:0:0"
mut aspect '\[1\] relación 9:16' -vf "scale=1080:1350"
# [10] faststart: el mut sin +faststart ya deja moov al final; cualquier variante anterior sirve de RED
if grep -E "^FAIL  .*\[10\] MP4 con moov" "$OUT/loud.log" >/dev/null; then echo "RED OK  nofaststart (variante sin +faststart)"; else echo "RED MISSING nofaststart"; rc=1; fi
exit $rc

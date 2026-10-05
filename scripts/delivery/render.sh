#!/usr/bin/env bash
# Review delivery, stage "render" (free): fetch approved masters + sources, edit, QA, package, publish links.
set -euo pipefail
OUT="${DELIVERY_OUT:-/tmp/delivery}"; F="$OUT/fetch"; P="$OUT/package"
mkdir -p "$OUT" "$P/dulce-part1" "$P/thermopylae"
npm ci --no-audit --no-fund --loglevel=error
FETCH_WHAT=dulce,dulce-master,thermopylae node scripts/delivery/fetch.mjs
DM="$F/DULCE-Part-I-master.mp4"; TM="$F/VIDEO-004-v3-master.mp4"

node scripts/delivery/edit.mjs dulce "$DM" "$F/src" "$OUT"
EDIT_CRF=18 node scripts/delivery/edit.mjs thermopylae "$TM" "$F/src" "$OUT"
DN="$OUT/DULCE-Part-I-review-v2.mp4"; TN="$OUT/Thermopylae-The-Annals-of-History-review-v4.mp4"

echo '[[11.03,13.40],[29.70,32.97],[73.93,82.14],[455.86,462.24],[521.13,527.24],[576.70,582.70]]' > "$OUT/win-dulce.json"
echo '[[49.70,54.77],[689.63,698.67],[740.06,753.70]]' > "$OUT/win-thermo.json"
node scripts/delivery/qa.mjs "$DN" "$DM" "$OUT/win-dulce.json" "$OUT/qa-dulce.json"
node scripts/delivery/qa.mjs "$TN" "$TM" "$OUT/win-thermo.json" "$OUT/qa-thermopylae.json"

# Official public site: linked only if it answers publicly right now.
SITE=https://atomivid.vercel.app; CODE=$(curl -s -o /tmp/site.html -w '%{http_code}' -L --max-time 20 "$SITE" || echo 000)
if [ "$CODE" = "200" ] && grep -qi "atomivid" /tmp/site.html; then LINK="$SITE"; else LINK=""; fi
echo "{\"site\":\"$SITE\",\"http\":\"$CODE\",\"linked\":$( [ -n "$LINK" ] && echo true || echo false )}" > "$OUT/site-check.json"; cat "$OUT/site-check.json"
for v in dulce-part1 thermopylae; do
  if [ -n "$LINK" ]; then sed -i "s#{{ATOMIVID_LINK}}#$LINK#" content/delivery/$v/YOUTUBE-TEXT.md; else sed -i '/{{ATOMIVID_LINK}}/d' content/delivery/$v/YOUTUBE-TEXT.md; fi
done

pkg() { # video dir, master, base name, closing capture time, thumbnail, srt, text
  local d="$P/$1" m="$2" b="$3"
  cp "$m" "$d/$b.mp4"
  ffmpeg -loglevel error -y -i "$m" -vf scale=854:480:flags=lanczos -c:v libx264 -preset medium -crf 27 -c:a aac -b:a 96k -movflags +faststart "$d/$b-proxy-480p.mp4"
  ffmpeg -loglevel error -y -ss "$4" -i "$m" -frames:v 1 -q:v 2 "$d/$b-closing-credit.jpg"
  cp "$5" "$d/"; cp "$6" "$d/$b.srt"; cp "$7" "$d/$b-YOUTUBE-TEXT.md"; cp "$8" "$d/$b-qa.json"; cp "$(dirname "$7")/NOTAS-REVISION.md" "$d/$b-NOTAS-REVISION.md"
  (cd "$d" && sha256sum ./* > SHA256SUMS.txt && zip -q -0 "../$b-package.zip" ./* && mv "../$b-package.zip" .)
}
pkg dulce-part1 "$DN" DULCE-Part-I-review-v2 581.0 content/delivery/dulce-part1/DULCE-Part-I-thumbnail.jpg content/delivery/dulce-part1/dulce-part1-en.srt content/delivery/dulce-part1/YOUTUBE-TEXT.md "$OUT/qa-dulce.json"
pkg thermopylae "$TN" Thermopylae-The-Annals-of-History-review-v4 752.2 content/delivery/thermopylae/Thermopylae-The-Annals-of-History-thumbnail.jpg content/delivery/thermopylae/video-004-v3-en.srt content/delivery/thermopylae/YOUTUBE-TEXT.md "$OUT/qa-thermopylae.json"
ls -l "$P"/*

node scripts/delivery/publish.mjs
# Keep the large media out of the generic artifact (they are uploaded as their own artifacts).
mkdir -p "$OUT/masters"
mv "$P/dulce-part1/DULCE-Part-I-review-v2.mp4" "$P/dulce-part1/DULCE-Part-I-review-v2-package.zip" "$OUT/masters/"
mv "$P/thermopylae/Thermopylae-The-Annals-of-History-review-v4.mp4" "$P/thermopylae/Thermopylae-The-Annals-of-History-review-v4-package.zip" "$OUT/masters/"
rm -rf "$OUT/fetch" "$OUT"/work-* 
ls -l "$OUT/masters"

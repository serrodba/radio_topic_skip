#!/bin/bash
# Uso:  ./probar_radio.sh        -> lista "Mis radios web" numeradas
#       ./probar_radio.sh N      -> analiza la radio numero N (Ctrl+C para salir)
RADIOS="${RADIOS:-/data/favourites/my-web-radio}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$1" ]; then
  python3 -c "import json,sys;[print(i, '|', r.get('title') or r.get('name'), '|', r.get('uri')) for i,r in enumerate(json.load(open(sys.argv[1])))]" "$RADIOS"
  exit 0
fi
URL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[int(sys.argv[2])]['uri'])" "$RADIOS" "$1") || exit 1
echo "Analizando: $URL"
python3 "$DIR/worker/topic_worker.py" --url "$URL" --model "$DIR/model" \
  --keywords "$DIR/worker/keywords_futbol.txt" --chunk 15 --min-hits 3

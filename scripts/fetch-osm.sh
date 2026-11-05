#!/bin/sh
# Downloads the OSM extract once; later runs reuse the file already in ./data/osm.
set -eu
target="/data/osm/${OSM_FILE}"
if [ -s "$target" ]; then
  echo "OSM extract already present: $target"
  exit 0
fi
echo "Downloading ${OSM_URL} -> ${target}"
wget -O "${target}.part" "${OSM_URL}"
mv "${target}.part" "$target"

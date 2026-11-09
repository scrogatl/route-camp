#!/bin/sh
# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | fdabd96 | Add Docker Compose stack with GraphHopper routing and README
# END LICENSE HEADER
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

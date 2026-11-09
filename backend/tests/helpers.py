# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | e0f6e37 | Import GPX tracks as routes, de-duplicate re-imports, guard imported lines
# END LICENSE HEADER
"""GPX builders and an import helper shared by the API tests."""

def gpx(body: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">'
        f"{body}</gpx>"
    ).encode()


def trk(name: str, points: list[tuple[float, float]]) -> str:
    trkpts = "".join(f'<trkpt lat="{lat}" lon="{lon}"></trkpt>' for lat, lon in points)
    return f"<trk><name>{name}</name><trkseg>{trkpts}</trkseg></trk>"


def rte(name: str, points: list[tuple[str, float, float]]) -> str:
    rtepts = "".join(f'<rtept lat="{lat}" lon="{lon}"><name>{n}</name></rtept>' for n, lat, lon in points)
    return f"<rte><name>{name}</name>{rtepts}</rte>"


START, END = (34.5, -83.5), (34.6, -83.4)
# A straight diagonal of about 15 km, 1000 intervals.
TRACK = [START] + [(START[0] + i * 0.0001, START[1] + i * 0.0001) for i in range(1, 1000)] + [END]


def import_gpx_bytes(client, data: bytes) -> dict:
    response = client.post("/api/gpx/import", files={"file": ("trip.gpx", data, "application/gpx+xml")})
    assert response.status_code == 200, response.text
    return response.json()


def routes(client) -> list[dict]:
    return client.get("/api/routes").json()

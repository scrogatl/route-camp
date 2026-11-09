# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-06 10:59:13 -0500 | Scott Rogers <scott@scottandrewrogers.com> | f9b12e3 | Duplicate a route, and a route table with arrival times
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | e0f6e37 | Import GPX tracks as routes, de-duplicate re-imports, guard imported lines
# END LICENSE HEADER
from tests.helpers import START, TRACK, END, gpx, import_gpx_bytes, routes, rte, trk


def test_track_becomes_two_stop_route_with_imported_geometry(client):
    summary = import_gpx_bytes(client, gpx(trk("Ridge run", TRACK)))
    assert summary["routes_created"] == 1 and summary["pois_created"] == 2
    assert summary["routes"][0]["kind"] == "track"

    (route,) = routes(client)
    assert route["name"] == "Ridge run"
    assert route["geometry_source"] == "imported"
    assert route["geometry"] and route["geometry"][0] == [START[1], START[0]]  # GeoJSON order: lon, lat
    assert route["distance_m"] > 10_000 and route["time_s"] is None
    names = [client.get(f"/api/pois/{pid}").json()["name"] for pid in route["poi_ids"]]
    assert names == ["Ridge run start", "Ridge run end"]


def test_reimporting_the_same_track_matches_instead_of_duplicating(client):
    data = gpx(trk("Ridge run", TRACK))
    import_gpx_bytes(client, data)
    summary = import_gpx_bytes(client, data)
    assert summary["routes_created"] == 0 and summary["routes_matched"] == 1
    assert summary["pois_created"] == 0
    assert len(routes(client)) == 1


def test_track_with_matching_rte_attaches_to_the_route_instead_of_a_second_route(client):
    body = rte("Day 1", [("Start", *START), ("End", *END)]) + trk("Day 1", TRACK)
    summary = import_gpx_bytes(client, gpx(body))
    assert [r["kind"] for r in summary["routes"]] == ["route"]
    (route,) = routes(client)
    assert route["geometry_source"] == "imported" and route["geometry"]


def test_rte_reimport_matches_on_name_and_ordered_pois(client):
    body = rte("Day 1", [("Start", *START), ("End", *END)])
    import_gpx_bytes(client, gpx(body))
    assert import_gpx_bytes(client, gpx(body))["routes_matched"] == 1
    assert len(routes(client)) == 1

    reversed_body = rte("Day 1", [("End", *END), ("Start", *START)])
    assert import_gpx_bytes(client, gpx(reversed_body))["routes_created"] == 1
    assert len(routes(client)) == 2


def test_calculate_refuses_to_overwrite_an_imported_track(client):
    import_gpx_bytes(client, gpx(trk("Ridge run", TRACK)))
    route_id = routes(client)[0]["id"]

    refused = client.post(f"/api/routes/{route_id}/calculate")
    assert refused.status_code == 409
    assert client.post(f"/api/routes/{route_id}/optimize").status_code == 409

    # Explicit replacement gets past the guard. GraphHopper is unreachable in tests, so it fails later, with 502.
    assert client.post(f"/api/routes/{route_id}/calculate?replace_imported=true").status_code == 502
    assert routes(client)[0]["geometry_source"] == "imported"  # the failed calculate left the track alone


def test_duplicate_keeps_an_imported_track(client):
    import_gpx_bytes(client, gpx(trk("Ridge run", TRACK)))
    original = routes(client)[0]
    copy = client.post(f"/api/routes/{original['id']}/duplicate").json()
    assert copy["geometry_source"] == "imported"
    assert copy["geometry"] == original["geometry"]
    assert copy["distance_m"] == original["distance_m"]

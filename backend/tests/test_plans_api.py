# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | a28c415 | Test plan totals, reordering and tags over the API
# END LICENSE HEADER
from tests.helpers import END, START, TRACK, gpx, import_gpx_bytes, trk


def _track_route(client, name: str, track=TRACK) -> dict:
    """Imported tracks come with a length, so they give plan totals without GraphHopper."""
    import_gpx_bytes(client, gpx(trk(name, track)))
    return next(r for r in client.get("/api/routes").json() if r["name"] == name)


def test_plan_totals_sum_routes_that_have_distance(client):
    a = _track_route(client, "Leg A")
    b = _track_route(client, "Leg B", track=[START, END])
    plan = client.post("/api/plans", json={"name": "Spring", "route_ids": [a["id"], b["id"]]}).json()

    assert plan["route_ids"] == [a["id"], b["id"]]
    assert plan["routes_total"] == 2 and plan["routes_with_distance"] == 2
    assert plan["distance_m"] == a["distance_m"] + b["distance_m"]
    assert plan["routes_with_time"] == 0 and plan["time_s"] == 0  # imported tracks have no time


def test_plan_reorder_and_remove_via_patch(client):
    a = _track_route(client, "Leg A")
    b = _track_route(client, "Leg B", track=[START, END])
    plan = client.post("/api/plans", json={"name": "Trip", "route_ids": [a["id"], b["id"]]}).json()

    reordered = client.patch(f"/api/plans/{plan['id']}", json={"route_ids": [b["id"], a["id"]]}).json()
    assert reordered["route_ids"] == [b["id"], a["id"]]

    trimmed = client.patch(f"/api/plans/{plan['id']}", json={"route_ids": [a["id"]]}).json()
    assert trimmed["route_ids"] == [a["id"]] and trimmed["routes_total"] == 1


def test_plan_rename_tag_and_filter(client):
    plan = client.post("/api/plans", json={"name": "Old name", "tags": ["Trip"]}).json()
    assert plan["tags"] == ["trip"]

    renamed = client.patch(f"/api/plans/{plan['id']}", json={"name": "New name", "tags": ["Trip", "Spring"]}).json()
    assert renamed["name"] == "New name" and renamed["tags"] == ["spring", "trip"]

    assert [p["id"] for p in client.get("/api/plans", params={"tag": "spring"}).json()] == [plan["id"]]
    assert client.get("/api/plans", params={"tag": "winter"}).json() == []


def test_unknown_route_in_plan_is_rejected(client):
    assert client.post("/api/plans", json={"name": "Bad", "route_ids": [9999]}).status_code == 422


def test_deleting_a_route_removes_it_from_plans_but_keeps_the_plan(client):
    a = _track_route(client, "Leg A")
    b = _track_route(client, "Leg B", track=[START, END])
    plan = client.post("/api/plans", json={"name": "Trip", "route_ids": [a["id"], b["id"]]}).json()

    assert client.delete(f"/api/routes/{a['id']}").status_code == 204
    remaining = client.get(f"/api/plans/{plan['id']}").json()
    assert remaining["route_ids"] == [b["id"]] and remaining["distance_m"] == b["distance_m"]


def test_plan_delete_keeps_routes(client):
    a = _track_route(client, "Leg A")
    plan = client.post("/api/plans", json={"name": "Trip", "route_ids": [a["id"]]}).json()
    assert client.delete(f"/api/plans/{plan['id']}").status_code == 204
    assert client.get(f"/api/plans/{plan['id']}").status_code == 404
    assert client.get(f"/api/routes/{a['id']}").status_code == 200

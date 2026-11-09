# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 18:05:03 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 588aab5 | Import rally bonus CSVs and store a POI's state
# END LICENSE HEADER
import pytest

from app.rally import RallyCsvError, parse_rally_csv

SAMPLE = "ABAC, 31.4813266787678, -83.526049414649606,510, GA, , \nANDH, 32.54122001118958, -83.895665025338531,555, N/A, , \n\n"


def upload(client, text: str):
    return client.post("/api/rally/import", files={"file": ("bonus-lat-lon-points.csv", text.encode(), "text/csv")})


def test_parse_reads_code_position_points_and_state():
    abac, andh = parse_rally_csv(SAMPLE)
    assert (abac.code, abac.points, abac.state) == ("ABAC", 510, "GA")
    assert abac.lat == pytest.approx(31.4813266787678) and abac.lon == pytest.approx(-83.5260494146496)
    assert andh.state is None  # "N/A" means no state


def test_parse_skips_a_header_row_and_rejects_bad_rows():
    assert [b.code for b in parse_rally_csv("code,lat,lon,points,state\n" + SAMPLE)] == ["ABAC", "ANDH"]
    with pytest.raises(RallyCsvError, match="line 2"):
        parse_rally_csv("ABAC, 31.4, -83.5, 510, GA\nBAD, x, -83.5, 1, GA\n")
    with pytest.raises(RallyCsvError, match="points"):
        parse_rally_csv("ABAC, 31.4, -83.5, lots, GA\n")
    with pytest.raises(RallyCsvError, match="fields"):
        parse_rally_csv("ABAC, 31.4\n")


def test_import_creates_pois_named_by_code_with_points_and_state(client):
    summary = upload(client, SAMPLE).json()
    assert summary["pois_created"] == 2 and summary["pois_matched"] == 0 and summary["created"] == ["ABAC", "ANDH"]
    pois = {p["name"]: p for p in client.get("/api/pois").json()}
    assert pois["ABAC"]["score"] == 510 and pois["ABAC"]["state"] == "GA"
    assert pois["ANDH"]["state"] is None


def test_reimport_matches_and_never_duplicates(client):
    upload(client, SAMPLE)
    summary = upload(client, SAMPLE).json()
    assert summary["pois_created"] == 0 and summary["pois_matched"] == 2 and summary["pois_updated"] == 0
    assert len(client.get("/api/pois").json()) == 2


def test_matches_a_poi_named_code_and_points_and_updates_points_and_state(client):
    """Existing GPX-imported bonuses are named "ABAC 510"; the name, tags and notes are kept."""
    poi = client.post(
        "/api/pois",
        json={"name": "ABAC 500", "lat": 31.4813266787678, "lon": -83.5260494146496, "score": 500, "tags": ["all"], "notes": "n"},
    ).json()
    summary = upload(client, SAMPLE).json()
    assert summary["pois_matched"] == 1 and summary["pois_created"] == 1 and summary["updated"] == ["ABAC 500"]
    after = client.get(f"/api/pois/{poi['id']}").json()
    assert (after["name"], after["score"], after["state"], after["tags"], after["notes"]) == ("ABAC 500", 510, "GA", ["all"], "n")


def test_same_name_elsewhere_or_a_longer_code_is_not_a_match(client):
    client.post("/api/pois", json={"name": "ABAC 510", "lat": 31.5, "lon": -83.5})  # moved: not the same bonus
    client.post("/api/pois", json={"name": "ABACUS", "lat": 31.4813266787678, "lon": -83.5260494146496})
    summary = upload(client, SAMPLE).json()
    assert summary["pois_created"] == 2 and summary["pois_matched"] == 0


def test_invalid_file_is_rejected_with_422(client):
    response = upload(client, "ABAC, north, west, 1, GA\n")
    assert response.status_code == 422 and "line 1" in response.text

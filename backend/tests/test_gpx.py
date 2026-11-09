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
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 66d7ed8 | Add GPX parsing, writing and import/export services
# END LICENSE HEADER
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import make_engine
from app.gpx import parse_gpx
from app.models import POI, Base, Route
from app.services import export_route_gpx, import_gpx, set_route_stops


def _seed(session: Session) -> Route:
    a = POI(name="Trailhead", lat=34.5, lon=-83.5, notes="parking")
    b = POI(name="Overlook", lat=34.6, lon=-83.4)
    c = POI(name="Diner", lat=34.4, lon=-83.6)
    session.add_all([a, b, c])
    session.flush()
    route = Route(name="Mountain loop", profile="fun")
    session.add(route)
    set_route_stops(session, route, [a.id, b.id, c.id, b.id])
    route.geometry = [[-83.5, 34.5], [-83.4, 34.6]]  # set after stops: changing stops clears the cache
    session.commit()
    return route


def test_export_then_import_round_trips_pois_and_route_order(db_session):
    route = _seed(db_session)
    xml = export_route_gpx(route)

    fresh_engine = make_engine("sqlite://")
    Base.metadata.create_all(fresh_engine)
    with Session(fresh_engine) as fresh:
        summary = import_gpx(fresh, parse_gpx(xml))
        fresh.commit()

        assert summary.pois_created == 3
        assert [r.kind for r in summary.routes] == ["route"]  # the trk attached to the rte, no second route
        imported = fresh.scalars(select(Route)).one()
        assert imported.name == "Mountain loop"
        assert imported.geometry_source == "imported" and imported.geometry
        assert [s.poi.name for s in imported.stops] == ["Trailhead", "Overlook", "Diner", "Overlook"]
        assert [s.poi.lat for s in imported.stops][:2] == [34.5, 34.6]
        assert fresh.scalars(select(POI).where(POI.name == "Trailhead")).one().notes == "parking"
    fresh_engine.dispose()


def test_importing_twice_reuses_existing_pois(db_session):
    route = _seed(db_session)
    xml = export_route_gpx(route)
    summary = import_gpx(db_session, parse_gpx(xml))
    db_session.commit()
    assert summary.pois_created == 0
    assert summary.pois_matched == 3
    assert [r.status for r in summary.routes] == ["matched"]
    assert len(db_session.scalars(select(Route)).all()) == 1
    assert len(db_session.scalars(select(POI)).all()) == 3


def test_parse_accepts_bytes_with_bom():
    xml = (
        '﻿<?xml version="1.0" encoding="UTF-8"?>'
        '<gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">'
        '<wpt lat="1.0" lon="2.0"><name>X</name></wpt></gpx>'
    ).encode("utf-8")
    parsed = parse_gpx(xml)
    assert [(w.name, w.lat, w.lon) for w in parsed.waypoints] == [("X", 1.0, 2.0)]

# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 575b4b0 | Add data model, settings and database wiring
# END LICENSE HEADER
from sqlalchemy import select

from app.models import POI, Plan, PlanRoute, Route, RouteStop, Tag
from app.services import get_or_create_tags, set_plan_routes, set_route_stops


def _poi(session, name, lat=33.0, lon=-84.0):
    poi = POI(name=name, lat=lat, lon=lon)
    session.add(poi)
    session.flush()
    return poi


def test_route_references_pois_in_order_without_copying(db_session):
    a, b = _poi(db_session, "A"), _poi(db_session, "B")
    route = Route(name="R")
    db_session.add(route)
    set_route_stops(db_session, route, [b.id, a.id, b.id])
    db_session.commit()

    stored = db_session.get(Route, route.id)
    assert [s.poi.name for s in stored.stops] == ["B", "A", "B"]
    assert len(db_session.scalars(select(POI)).all()) == 2  # POIs are not duplicated


def test_editing_stops_invalidates_cached_calculation(db_session):
    a, b = _poi(db_session, "A"), _poi(db_session, "B")
    route = Route(name="R", distance_m=1000.0, time_s=60.0, geometry=[[-84.0, 33.0], [-84.1, 33.1]])
    db_session.add(route)
    set_route_stops(db_session, route, [a.id, b.id])
    db_session.commit()
    assert route.geometry is None and route.distance_m is None


def test_tags_are_many_to_many_across_item_types(db_session):
    poi = _poi(db_session, "Gas station")
    route = Route(name="Mountain loop")
    plan = Plan(name="Spring trip")
    db_session.add_all([route, plan])
    db_session.flush()
    shared = get_or_create_tags(db_session, ["Trip", "trip ", "north"])
    poi.tags = shared
    route.tags = shared
    plan.tags = get_or_create_tags(db_session, ["trip"])
    db_session.commit()

    assert db_session.scalar(select(Tag).where(Tag.name == "trip")) is not None
    assert len(db_session.scalars(select(Tag)).all()) == 2  # "trip" was not duplicated
    assert [t.name for t in poi.tags] == ["north", "trip"]
    assert [t.name for t in plan.tags] == ["trip"]


def test_deleting_poi_removes_it_from_routes_but_not_the_route(db_session):
    a, b = _poi(db_session, "A"), _poi(db_session, "B")
    route = Route(name="R")
    db_session.add(route)
    set_route_stops(db_session, route, [a.id, b.id])
    db_session.commit()

    db_session.delete(a)
    db_session.commit()
    db_session.expire_all()
    assert db_session.scalars(select(RouteStop)).all() and len(db_session.get(Route, route.id).stops) == 1


def test_plan_orders_routes(db_session):
    r1, r2 = Route(name="first"), Route(name="second")
    plan = Plan(name="trip")
    db_session.add_all([r1, r2, plan])
    db_session.flush()
    set_plan_routes(db_session, plan, [r2.id, r1.id])
    db_session.commit()
    assert [link.route.name for link in plan.route_links] == ["second", "first"]
    assert db_session.scalars(select(PlanRoute)).all()[0].plan_id == plan.id

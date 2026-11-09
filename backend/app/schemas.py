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
#   2026-11-06 06:20:07 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 108a72d | Add time at each stop: a default for all stops and a bonus's own minutes
#   2026-11-05 18:05:03 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 588aab5 | Import rally bonus CSVs and store a POI's state
#   2026-11-05 17:04:04 -0500 | Scott Rogers <scott@scottandrewrogers.com> | b1b94e3 | Preview an optimized stop order without saving it
#   2026-11-05 16:30:44 -0500 | Scott Rogers <scott@scottandrewrogers.com> | fdd43dc | Add a nullable POI score, filled from names
#   2026-11-05 13:50:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | e0f6e37 | Import GPX tracks as routes, de-duplicate re-imports, guard imported lines
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 42f2690 | Add REST API, GraphHopper routing and stop optimization
# END LICENSE HEADER
"""Pydantic request/response models and ORM -> response converters."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from sqlalchemy.orm import object_session

from app.models import POI, Plan, Route
from app.stop_time import default_stop_minutes, stop_seconds

Profile = Literal["car", "fun"]
ItemKind = Literal["poi", "route", "plan"]
OptimizeSource = Literal["graphhopper", "haversine", "none"]


class TagOut(BaseModel):
    id: int
    name: str


# --- POIs -------------------------------------------------------------------


Score = Field(default=None, ge=0, le=999_999_999)
StopMinutes = Field(default=None, ge=0, le=24 * 60)


class POIIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    notes: str | None = None
    score: int | None = Score
    state: str | None = Field(default=None, max_length=40)
    stop_minutes: float | None = StopMinutes
    tags: list[str] = []


class POIUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    notes: str | None = None
    score: int | None = Score  # an explicit null clears the score
    state: str | None = Field(default=None, max_length=40)
    stop_minutes: float | None = StopMinutes  # an explicit null goes back to the default
    tags: list[str] | None = None


class POIOut(BaseModel):
    id: int
    name: str
    lat: float
    lon: float
    notes: str | None
    score: int | None
    state: str | None
    stop_minutes: float | None
    tags: list[str]
    created_at: datetime
    updated_at: datetime


# --- Routes -----------------------------------------------------------------


class RouteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    notes: str | None = None
    profile: Profile = "car"
    poi_ids: list[int] = []
    tags: list[str] = []


class RouteDuplicate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)


class RouteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = None
    profile: Profile | None = None
    poi_ids: list[int] | None = None
    tags: list[str] | None = None


class RouteLeg(BaseModel):
    distance_m: float
    time_s: float  # driving time


class RouteOut(BaseModel):
    id: int
    name: str
    notes: str | None
    profile: Profile
    poi_ids: list[int]
    distance_m: float | None
    time_s: float | None  # driving time
    stop_s: float  # time at the stops (not the first or last, unless they have their own minutes)
    total_s: float | None  # driving plus stops; null without a driving time
    geometry: list[list[float]] | None
    geometry_source: Literal["calculated", "imported"] | None
    legs: list[RouteLeg] | None  # per leg between consecutive stops; null until calculated, or for a GPX track
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class OptimizeOut(BaseModel):
    route: RouteOut
    source: OptimizeSource


class OrderSummary(BaseModel):
    poi_ids: list[int]
    distance_m: float | None  # null when GraphHopper could not route this order
    time_s: float | None


class OptimizePreviewOut(BaseModel):
    """A proposed stop order and its totals. Nothing is saved; accept by PATCHing poi_ids."""

    source: OptimizeSource
    current: OrderSummary
    proposed: OrderSummary
    geometry: list[list[float]] | None  # the proposed line as [lon, lat] points, when GraphHopper routed it


# --- Plans ------------------------------------------------------------------


class PlanIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    notes: str | None = None
    route_ids: list[int] = []
    tags: list[str] = []


class PlanUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = None
    route_ids: list[int] | None = None
    tags: list[str] | None = None


class PlanOut(BaseModel):
    id: int
    name: str
    notes: str | None
    route_ids: list[int]
    tags: list[str]
    # Totals over the plan's routes. Routes without a calculated or imported line are left out of the sums.
    distance_m: float
    time_s: float  # driving time
    stop_s: float  # stop time of the routes that have a driving time
    total_s: float
    routes_total: int
    routes_with_distance: int
    routes_with_time: int
    created_at: datetime
    updated_at: datetime


# --- Settings ---------------------------------------------------------------


class SettingsOut(BaseModel):
    stop_minutes: float  # default minutes at each stop
    start_minutes: float  # rally start, minutes after midnight (for arrival times)


class SettingsUpdate(BaseModel):
    stop_minutes: float | None = Field(default=None, ge=0, le=24 * 60)
    start_minutes: float | None = Field(default=None, ge=0, lt=24 * 60)


# --- Tags and GPX -----------------------------------------------------------


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ItemRef(BaseModel):
    kind: ItemKind
    id: int


class TaggedItemsOut(BaseModel):
    pois: list[POIOut]
    routes: list[RouteOut]
    plans: list[PlanOut]


class ImportedRouteOut(BaseModel):
    id: int
    name: str
    kind: Literal["route", "track"]
    status: Literal["created", "matched"]


class ImportSummaryOut(BaseModel):
    pois_created: int
    pois_matched: int
    routes_created: int
    routes_matched: int
    routes: list[ImportedRouteOut]


# --- Rally CSV import --------------------------------------------------------


class RallyImportOut(BaseModel):
    bonuses: int  # rows in the file
    pois_created: int
    pois_matched: int
    pois_updated: int  # matched POIs whose points or state changed
    created: list[str]  # codes of the new POIs
    updated: list[str]  # names of the changed POIs


# --- ORM -> response --------------------------------------------------------


def poi_out(poi: POI) -> POIOut:
    return POIOut(
        id=poi.id,
        name=poi.name,
        lat=poi.lat,
        lon=poi.lon,
        notes=poi.notes,
        score=poi.score,
        state=poi.state,
        stop_minutes=poi.stop_minutes,
        tags=[t.name for t in poi.tags],
        created_at=poi.created_at,
        updated_at=poi.updated_at,
    )


def _default_minutes(item: Route | Plan) -> float:
    session = object_session(item)
    return default_stop_minutes(session) if session is not None else 0.0


def route_out(route: Route, default_minutes: float | None = None) -> RouteOut:
    if default_minutes is None:
        default_minutes = _default_minutes(route)
    stop_s = stop_seconds([s.poi for s in route.stops], default_minutes)
    return RouteOut(
        id=route.id,
        name=route.name,
        notes=route.notes,
        profile=route.profile,
        poi_ids=[s.poi.id for s in route.stops],
        distance_m=route.distance_m,
        time_s=route.time_s,
        stop_s=stop_s,
        total_s=None if route.time_s is None else route.time_s + stop_s,
        geometry=route.geometry,
        geometry_source=route.geometry_source,
        legs=route.legs,
        tags=[t.name for t in route.tags],
        created_at=route.created_at,
        updated_at=route.updated_at,
    )


def plan_out(plan: Plan) -> PlanOut:
    routes = [link.route for link in plan.route_links]
    distances = [r.distance_m for r in routes if r.distance_m is not None]
    times = [r.time_s for r in routes if r.time_s is not None]
    default_minutes = _default_minutes(plan)
    stops = [stop_seconds([s.poi for s in r.stops], default_minutes) for r in routes if r.time_s is not None]
    return PlanOut(
        id=plan.id,
        name=plan.name,
        notes=plan.notes,
        route_ids=[r.id for r in routes],
        tags=[t.name for t in plan.tags],
        distance_m=sum(distances),
        time_s=sum(times),
        stop_s=sum(stops),
        total_s=sum(times) + sum(stops),
        routes_total=len(routes),
        routes_with_distance=len(distances),
        routes_with_time=len(times),
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )

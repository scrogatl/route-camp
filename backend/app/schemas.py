"""Pydantic request/response models and ORM -> response converters."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.models import POI, Plan, Route

Profile = Literal["car", "fun"]
ItemKind = Literal["poi", "route", "plan"]
OptimizeSource = Literal["graphhopper", "haversine", "none"]


class TagOut(BaseModel):
    id: int
    name: str


# --- POIs -------------------------------------------------------------------


class POIIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    notes: str | None = None
    tags: list[str] = []


class POIUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    notes: str | None = None
    tags: list[str] | None = None


class POIOut(BaseModel):
    id: int
    name: str
    lat: float
    lon: float
    notes: str | None
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


class RouteUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = None
    profile: Profile | None = None
    poi_ids: list[int] | None = None
    tags: list[str] | None = None


class RouteOut(BaseModel):
    id: int
    name: str
    notes: str | None
    profile: Profile
    poi_ids: list[int]
    distance_m: float | None
    time_s: float | None
    geometry: list[list[float]] | None
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class OptimizeOut(BaseModel):
    route: RouteOut
    source: OptimizeSource


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
    created_at: datetime
    updated_at: datetime


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


class ImportSummaryOut(BaseModel):
    pois_created: int
    pois_matched: int
    routes_created: int
    tracks_skipped: int


# --- ORM -> response --------------------------------------------------------


def poi_out(poi: POI) -> POIOut:
    return POIOut(
        id=poi.id,
        name=poi.name,
        lat=poi.lat,
        lon=poi.lon,
        notes=poi.notes,
        tags=[t.name for t in poi.tags],
        created_at=poi.created_at,
        updated_at=poi.updated_at,
    )


def route_out(route: Route) -> RouteOut:
    return RouteOut(
        id=route.id,
        name=route.name,
        notes=route.notes,
        profile=route.profile,
        poi_ids=[s.poi.id for s in route.stops],
        distance_m=route.distance_m,
        time_s=route.time_s,
        geometry=route.geometry,
        tags=[t.name for t in route.tags],
        created_at=route.created_at,
        updated_at=route.updated_at,
    )


def plan_out(plan: Plan) -> PlanOut:
    return PlanOut(
        id=plan.id,
        name=plan.name,
        notes=plan.notes,
        route_ids=[link.route.id for link in plan.route_links],
        tags=[t.name for t in plan.tags],
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )

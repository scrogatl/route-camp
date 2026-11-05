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


Score = Field(default=None, ge=0, le=999_999_999)


class POIIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    notes: str | None = None
    score: int | None = Score
    state: str | None = Field(default=None, max_length=40)
    tags: list[str] = []


class POIUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    notes: str | None = None
    score: int | None = Score  # an explicit null clears the score
    state: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = None


class POIOut(BaseModel):
    id: int
    name: str
    lat: float
    lon: float
    notes: str | None
    score: int | None
    state: str | None
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
    geometry_source: Literal["calculated", "imported"] | None
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
    time_s: float
    routes_total: int
    routes_with_distance: int
    routes_with_time: int
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
        geometry_source=route.geometry_source,
        tags=[t.name for t in route.tags],
        created_at=route.created_at,
        updated_at=route.updated_at,
    )


def plan_out(plan: Plan) -> PlanOut:
    routes = [link.route for link in plan.route_links]
    distances = [r.distance_m for r in routes if r.distance_m is not None]
    times = [r.time_s for r in routes if r.time_s is not None]
    return PlanOut(
        id=plan.id,
        name=plan.name,
        notes=plan.notes,
        route_ids=[r.id for r in routes],
        tags=[t.name for t in plan.tags],
        distance_m=sum(distances),
        time_s=sum(times),
        routes_total=len(routes),
        routes_with_distance=len(distances),
        routes_with_time=len(times),
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )

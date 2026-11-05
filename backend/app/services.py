"""Business logic shared by the API routers and the GPX code."""

from dataclasses import dataclass, field
from typing import Literal, TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.geo import haversine_m, path_length_m, simplify
from app.gpx import GpxPoint, GpxTrack, ParsedGpx, build_route_gpx
from app.models import POI, Base, Plan, PlanRoute, Route, RouteStop, Tag

COORD_TOLERANCE = 1e-6  # ~10 cm; used to match GPX points to existing POIs
TRACK_END_MATCH_M = 500  # a track end this close to a route's stop counts as the same place
TRACK_LENGTH_TOLERANCE = 0.02  # re-import matches a track whose length differs by under 2% (or 500 m)
TRACK_LENGTH_TOLERANCE_M = 500

M = TypeVar("M", bound=Base)


@dataclass
class ImportedRoute:
    id: int
    name: str
    kind: Literal["route", "track"]
    status: Literal["created", "matched"]


@dataclass
class ImportSummary:
    pois_created: int = 0
    pois_matched: int = 0
    routes: list[ImportedRoute] = field(default_factory=list)


def normalise_tag_names(names: list[str]) -> list[str]:
    return sorted({name.strip().lower() for name in names if name.strip()})


def get_or_create_tags(session: Session, names: list[str]) -> list[Tag]:
    tags = []
    for name in normalise_tag_names(names):
        tag = session.scalar(select(Tag).where(Tag.name == name))
        if tag is None:
            tag = Tag(name=name)
            session.add(tag)
            session.flush()
        tags.append(tag)
    return tags


def _load_by_ids(session: Session, model: type[M], ids: list[int]) -> dict[int, M]:
    if not ids:
        return {}
    found = {obj.id: obj for obj in session.scalars(select(model).where(model.id.in_(set(ids))))}
    missing = sorted(set(ids) - found.keys())
    if missing:
        raise ValueError(f"Unknown {model.__name__} ids: {missing}")
    return found


def set_route_stops(session: Session, route: Route, poi_ids: list[int]) -> None:
    """Replace a route's ordered POI references. Duplicates are allowed (a route may pass a POI twice)."""
    pois = _load_by_ids(session, POI, poi_ids)
    route.stops = [RouteStop(poi=pois[poi_id], position=i) for i, poi_id in enumerate(poi_ids)]
    route.invalidate()


def set_plan_routes(session: Session, plan: Plan, route_ids: list[int]) -> None:
    routes = _load_by_ids(session, Route, route_ids)
    plan.route_links = [PlanRoute(route=routes[rid], position=i) for i, rid in enumerate(route_ids)]


def find_or_create_poi(session: Session, name: str, lat: float, lon: float, notes: str | None) -> tuple[POI, bool]:
    for poi in session.scalars(select(POI).where(POI.name == name)):
        if abs(poi.lat - lat) < COORD_TOLERANCE and abs(poi.lon - lon) < COORD_TOLERANCE:
            return poi, False
    poi = POI(name=name, lat=lat, lon=lon, notes=notes)
    session.add(poi)
    session.flush()
    return poi, True


def _coord_key(lat: float, lon: float) -> tuple[float, float]:
    return round(lat, 6), round(lon, 6)


def _stop_ids(route: Route) -> list[int]:
    return [stop.poi_id for stop in route.stops]


def _find_or_create_route(session: Session, name: str, poi_ids: list[int]) -> tuple[Route, bool]:
    """A GPX route is the same route when its name and ordered POI ids match."""
    for route in session.scalars(select(Route).where(Route.name == name)):
        if _stop_ids(route) == poi_ids:
            return route, False
    route = Route(name=name, profile="car")
    session.add(route)
    set_route_stops(session, route, poi_ids)
    session.flush()
    return route, True


def _find_track_route(session: Session, name: str, poi_ids: list[int], length_m: float) -> Route | None:
    """An imported track is the same route when its name, start/end POIs and length (approx.) match."""
    tolerance = max(TRACK_LENGTH_TOLERANCE_M, TRACK_LENGTH_TOLERANCE * length_m)
    for route in session.scalars(select(Route).where(Route.name == name, Route.geometry_source == "imported")):
        if _stop_ids(route) == poi_ids and route.distance_m is not None and abs(route.distance_m - length_m) <= tolerance:
            return route
    return None


def import_gpx(session: Session, parsed: ParsedGpx) -> ImportSummary:
    """Import waypoints, routes and tracks as POIs and routes. Re-importing the same file creates nothing new.

    - Waypoints become POIs, reused when name and position match.
    - An rte becomes a route over its POIs. Matched on name and ordered POI ids.
    - A trk whose start and end sit on an rte of the same name attaches its geometry to that route.
      Otherwise it becomes a two-stop route (start and end POIs), with its simplified line as the cached
      geometry and geometry_source "imported". Matched on name, start/end POIs and length.
    """
    summary = ImportSummary()
    by_coord: dict[tuple[float, float], POI] = {}

    def resolve_poi(point: GpxPoint) -> POI:
        key = _coord_key(point.lat, point.lon)
        if key not in by_coord:
            poi, created = find_or_create_poi(session, point.name or "Unnamed POI", point.lat, point.lon, point.desc)
            summary.pois_created += created
            summary.pois_matched += not created
            by_coord[key] = poi
        return by_coord[key]

    def record(route: Route, kind: Literal["route", "track"], status: Literal["created", "matched"]) -> None:
        summary.routes.append(ImportedRoute(id=route.id, name=route.name, kind=kind, status=status))

    for waypoint in parsed.waypoints:
        resolve_poi(waypoint)

    # (route, name, first point, last point) for every rte in this file, used to attach tracks.
    rte_ends: list[tuple[Route, str, GpxPoint, GpxPoint]] = []
    for index, gpx_route in enumerate(parsed.routes, start=1):
        if not gpx_route.points:
            continue
        name = gpx_route.name or f"Imported route {index}"
        stops = [resolve_poi(point) for point in gpx_route.points]
        route, created = _find_or_create_route(session, name, [stop.id for stop in stops])
        record(route, "route", "created" if created else "matched")
        rte_ends.append((route, name, gpx_route.points[0], gpx_route.points[-1]))

    for index, track in enumerate(parsed.tracks, start=1):
        if len(track.points) < 2:
            continue
        name = track.name or f"Imported track {index}"
        if _attach_track_to_route(session, track, name, rte_ends):
            continue
        _import_track_as_route(session, track, name, resolve_poi, summary, record)

    session.flush()
    return summary


def _attach_track_to_route(session: Session, track: GpxTrack, name: str, rte_ends) -> bool:
    """Give an rte of the same name and end points the track's line, when it has none yet."""
    start, end = track.points[0], track.points[-1]
    for route, route_name, first, last in rte_ends:
        if route_name != name:
            continue
        if haversine_m(start, (first.lat, first.lon)) > TRACK_END_MATCH_M:
            continue
        if haversine_m(end, (last.lat, last.lon)) > TRACK_END_MATCH_M:
            continue
        if route.geometry is None:
            _set_imported_geometry(route, track.points)
        return True
    return False


def _import_track_as_route(session, track: GpxTrack, name: str, resolve_poi, summary: ImportSummary, record) -> None:
    start_lat, start_lon = track.points[0]
    end_lat, end_lon = track.points[-1]
    start = resolve_poi(GpxPoint(f"{name} start", start_lat, start_lon))
    end = resolve_poi(GpxPoint(f"{name} end", end_lat, end_lon))
    length = path_length_m(track.points)
    existing = _find_track_route(session, name, [start.id, end.id], length)
    if existing is not None:
        record(existing, "track", "matched")
        return
    route = Route(name=name, profile="car")
    session.add(route)
    set_route_stops(session, route, [start.id, end.id])  # clears the cache, so the line is set after this
    _set_imported_geometry(route, track.points)
    session.flush()
    record(route, "track", "created")


def _set_imported_geometry(route: Route, points: list[tuple[float, float]]) -> None:
    simplified = simplify(points)
    route.geometry = [[lon, lat] for lat, lon in simplified]
    route.distance_m = path_length_m(points)
    route.time_s = None
    route.geometry_source = "imported"


def _gpx_point(poi: POI) -> GpxPoint:
    return GpxPoint(name=poi.name, lat=poi.lat, lon=poi.lon, desc=poi.notes)


def export_route_gpx(route: Route) -> str:
    stops = [stop.poi for stop in route.stops]
    unique_pois = {poi.id: poi for poi in stops}
    geometry = [(lat, lon) for lon, lat in route.geometry] if route.geometry else None
    return build_route_gpx(
        route_name=route.name,
        waypoints=[_gpx_point(poi) for poi in unique_pois.values()],
        route_points=[_gpx_point(poi) for poi in stops],
        geometry=geometry,
    )
